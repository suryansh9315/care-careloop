"""Register the instruments as CARE Questionnaires, and submit answers to them.

This is the only write path into the patient's chart, and it exists because of
two constraints found by reading CARE's source rather than its docs:

**C1** — `Observation` cannot be created over REST (`ObservationViewSet` is
read-only). Observations are produced *only* by submitting a questionnaire
response, so the instrument has to be a real CARE `Questionnaire`.

**C13** — and only with an encounter. In `handle_response`, a `subject_type`
of ``"patient"`` forces ``encounter = None`` and the `Observation.bulk_create`
is guarded by ``if encounter:``. A patient-subject submission returns HTTP 200,
creates a `QuestionnaireResponse`, and silently produces **zero** observations.
So these questionnaires are registered as ``subject_type="encounter"`` and the
virtual encounter is a hard prerequisite, not a nicety.

Writes go through CARE's own `handle_response` rather than the ORM, so audit
fields, validation and the questionnaire-response linkage are not bypassed (C4).
"""

from __future__ import annotations

import uuid

from django.db import transaction

from care.emr.models.encounter import Encounter
from care.emr.models.organization import Organization
from care.emr.models.patient import Patient
from care.emr.models.questionnaire import (
    Questionnaire,
    QuestionnaireOrganization,
    QuestionnaireResponse,
)
from care.emr.resources.questionnaire.spec import QuestionnaireSpec
from care.emr.resources.questionnaire.utils import handle_response
from care.emr.resources.questionnaire_response.spec import QuestionnaireSubmitRequest

from care_careloop.clinical import ConditionModule

LOINC = "http://loinc.org"

#: Stable namespace for deriving question ids. Question ids must not change when
#: a questionnaire is re-registered: stored `QuestionnaireResponse.responses`
#: reference them by id, so a fresh `uuid4()` per deploy would orphan every
#: historical response. uuid5 over (module, link id) keeps them reproducible
#: from code alone, which also means the submit path never has to read the
#: stored questionnaire back to find them.
QUESTION_NAMESPACE = uuid.UUID("6f1b0b2e-9a1d-5c4e-9f31-c17e10000001")


def questionnaire_slug(module: ConditionModule) -> str:
    return f"careloop-{module.id}"


def total_link_id(module: ConditionModule) -> str:
    return f"{module.instrument.id}-total"


def question_id(module: ConditionModule, link_id: str) -> str:
    return str(uuid.uuid5(QUESTION_NAMESPACE, f"{module.id}:{link_id}"))


def build_questions(module: ConditionModule) -> list[dict]:
    """One question per instrument item, plus the total.

    The **total-score question is not optional**. CARE only derives a total
    server-side when a question carries a `formula`, and CareLoop scores in
    Python on purpose, so the total has to be submitted as its own coded answer.
    Without it the chart holds item observations but no total, and the care-gap
    detector — which matches on the total-score code — would never see a
    completed check-in and would re-dial the same patient forever.
    """
    instrument = module.instrument
    questions: list[dict] = []

    for item in instrument.items:
        questions.append(
            {
                "id": question_id(module, item.link_id),
                "link_id": item.link_id,
                "text": item.prompt,
                "description": item.scale_hint,
                "type": "integer",
                "code": {
                    "system": LOINC,
                    "code": item.loinc_code,
                    "display": item.prompt[:90],
                },
                "is_observation": True,
                "required": False,
            }
        )

    questions.append(
        {
            "id": question_id(module, total_link_id(module)),
            "link_id": total_link_id(module),
            "text": f"{instrument.name} total score",
            "description": (
                "Computed by the CareLoop clinical core from the item answers, "
                "not by the voice agent."
            ),
            "type": "integer",
            "code": {
                "system": LOINC,
                "code": instrument.loinc_total_code,
                "display": f"{instrument.name} total score"[:90],
            },
            "is_observation": True,
            "required": False,
        }
    )
    return questions


def build_spec_payload(module: ConditionModule, organization_ids: list[uuid.UUID]) -> dict:
    return {
        "title": f"CareLoop — {module.instrument.name}",
        "slug": questionnaire_slug(module),
        "description": (
            f"{module.instrument.name} as collected by a CareLoop pre-visit voice "
            f"check-in. Scored deterministically; the agent only collects answers."
        ),
        "status": "active",
        # MUST be "encounter". See C13 in the module docstring.
        "subject_type": "encounter",
        "organizations": [str(o) for o in organization_ids],
        "questions": build_questions(module),
    }


@transaction.atomic
def register_questionnaire(
    module: ConditionModule, organization: Organization, user
) -> tuple[Questionnaire, bool]:
    """Idempotently register (or refresh) a module's questionnaire.

    Returns ``(questionnaire, created)``. Re-running updates the questions in
    place and keeps the slug and question ids, so existing responses stay
    interpretable.

    Validation runs through `QuestionnaireSpec` first, which is what enforces the
    LOINC ValueSet binding on every question code — the check that rejected all
    seven of the previous implementation's ACT codes.
    """
    payload = build_spec_payload(module, [organization.external_id])
    spec = QuestionnaireSpec(**payload)  # raises on an invalid code

    slug = questionnaire_slug(module)
    existing = Questionnaire.objects.filter(slug=slug).first()

    if existing:
        existing.title = payload["title"]
        existing.description = payload["description"]
        existing.status = payload["status"]
        existing.subject_type = payload["subject_type"]
        existing.questions = spec.model_dump(mode="json")["questions"]
        existing.updated_by = user
        existing.save(
            update_fields=[
                "title",
                "description",
                "status",
                "subject_type",
                "questions",
                "updated_by",
                "modified_date",
            ]
        )
        questionnaire = existing
        created = False
    else:
        questionnaire = Questionnaire(
            version="1.0",
            slug=slug,
            title=payload["title"],
            description=payload["description"],
            status=payload["status"],
            subject_type=payload["subject_type"],
            questions=spec.model_dump(mode="json")["questions"],
            styling_metadata={},
            created_by=user,
            updated_by=user,
        )
        questionnaire.save()
        created = True

    # Creating this row is what populates Questionnaire.organization_cache (the
    # model's own save() does it), and that cache is what makes the
    # questionnaire visible to non-superusers through get_filtered_questionnaires.
    QuestionnaireOrganization.objects.get_or_create(
        questionnaire=questionnaire, organization=organization
    )

    return questionnaire, created


def submit_check_in(
    *,
    module: ConditionModule,
    patient: Patient,
    encounter: Encounter,
    user,
    item_answers: dict[str, int],
    total: int,
) -> QuestionnaireResponse:
    """Submit a scored check-in, producing coded observations.

    ``user`` should be the CareLoop service account, not the approving
    clinician: the answers were collected by the agent, and `handle_response`
    stamps ``data_entered_by`` from whoever submits. Attributing them to the
    clinician would state that they asked the questions (C5).
    """
    questionnaire = Questionnaire.objects.filter(
        slug=questionnaire_slug(module)
    ).first()
    if questionnaire is None:
        raise RuntimeError(
            f"Questionnaire '{questionnaire_slug(module)}' is not registered. "
            "Run `manage.py careloop_setup` first."
        )

    results = [
        {
            "question_id": question_id(module, link_id),
            "values": [{"value": str(value)}],
        }
        for link_id, value in item_answers.items()
    ]
    results.append(
        {
            "question_id": question_id(module, total_link_id(module)),
            "values": [{"value": str(total)}],
        }
    )

    request = QuestionnaireSubmitRequest(
        resource_id=encounter.external_id,
        patient=patient.external_id,
        encounter=encounter.external_id,
        results=results,
    )

    with transaction.atomic():
        return handle_response(questionnaire, request, user)
