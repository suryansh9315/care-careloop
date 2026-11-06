"""The approval transaction — the only thing that writes to the patient's chart.

One atomic operation, or nothing:

1. ensure a virtual `Encounter` (class ``vr``) — **mandatory**, because
   `handle_response` only creates observations when an encounter is present (C13)
2. submit the questionnaire, which is what produces coded `Observation`s (C1),
   as the **service account** so the answers are attributed to the agent (C5)
3. write a `MedicationRequest` for each proposal the clinician accepted **and**
   bound to a real product
4. write a clinical note summarising what the call found
5. mark the draft approved, recording who approved it and when

Two refusals are deliberate:

* An **unacknowledged critical** safety or risk finding blocks approval. The
  clinician has to say explicitly that they have seen it.
* A proposal with no bound product is **not** written. CARE binds medications to
  SNOMED CT, not the RxNorm the protocol carries (C2), so the protocol proposes
  a therapeutic step and the clinician chooses the product. Writing something we
  guessed would be worse than writing nothing.

Medication requests are written as ``status="draft"`` / ``intent="proposal"``,
not as active orders. A care-gap phone call plus a queue sign-off is a proposal
*for* the prescriber; turning it into an order is a separate, deliberate act in
CARE's own prescribing UI.
"""

from __future__ import annotations

from django.db import transaction
from django.utils import timezone

from care.emr.models.encounter import Encounter
from care.emr.models.medication_request import MedicationRequest
from care.emr.models.notes import NoteMessage, NoteThread
from care.emr.resources.medication.request.spec import MedicationRequestSpec

from care_careloop.clinical import get_module
from care_careloop.models import CheckInDraft, DraftStatus
from care_careloop.services.questionnaire import submit_check_in
from care_careloop.services.service_account import ensure_service_account

SNOMED = "http://snomed.info/sct"


class ApprovalError(Exception):
    """Base class for refusals that are the caller's fault, not a bug."""


class ApprovalBlocked(ApprovalError):
    """An unacknowledged critical finding gates this draft."""


class ApprovalStateError(ApprovalError):
    """The draft is not in a state that can be approved or rejected."""


def ensure_encounter(draft: CheckInDraft, user) -> Encounter:
    """The virtual encounter the check-in is recorded against.

    Created at approval rather than at call time: an un-approved call should not
    leave an encounter in the patient's record. ``callback_results`` is CARE's
    own priority for exactly this kind of contact.
    """
    if draft.encounter_id:
        return draft.encounter

    return Encounter.objects.create(
        patient=draft.patient,
        facility=draft.facility,
        encounter_class="vr",
        status="completed",
        priority="callback_results",
        period={"start": timezone.now().isoformat()},
        created_by=user,
        updated_by=user,
    )


def _item_answers(draft: CheckInDraft) -> dict[str, int]:
    """Instrument answers as submitted, clamped by the core on the way in."""
    return {
        answer["link_id"]: int(answer["value"])
        for answer in draft.instrument_answers
        if answer.get("value") is not None
    }


def _write_medication_request(draft: CheckInDraft, proposal, encounter, user) -> MedicationRequest:
    spec = MedicationRequestSpec(
        status="draft",
        intent="proposal",
        category="outpatient",
        priority="routine",
        do_not_perform=False,
        medication={
            "system": SNOMED,
            "code": proposal.snomed_code,
            "display": proposal.snomed_display or proposal.display,
        },
        dosage_instruction=[
            {
                "text": proposal.sig,
                "as_needed_boolean": proposal.prn,
            }
        ],
        authored_on=timezone.now(),
        encounter=encounter.external_id,
        note=(
            f"Proposed by a CareLoop check-in ({draft.module_id}, "
            f"{draft.band_label}, score {draft.score_total}). "
            "Reviewed and accepted by the approving clinician."
        ),
    )
    obj = spec.de_serialize()
    obj.patient = draft.patient
    obj.encounter = encounter
    obj.created_by = user
    obj.updated_by = user
    obj.save()
    return obj


def _note_body(draft: CheckInDraft) -> str:
    module = get_module(draft.module_id)
    lines = [
        f"CareLoop pre-visit check-in — {module.instrument.name}.",
        f"Score {draft.score_total} ({draft.band_label}).",
    ]
    if draft.crisis_override:
        lines.append(
            "Crisis pathway applied: the numeric band was overridden by the "
            "self-harm item."
        )
    if draft.concerns:
        quoted = "; ".join(f'"{c}"' for c in draft.concerns[:3])
        lines.append(f"Patient raised: {quoted}")
    for finding in draft.safety_findings + draft.risk_findings:
        lines.append(f"[{finding.get('severity')}] {finding.get('message')}")
    if draft.escalated:
        lines.append("Flagged for earlier clinician contact.")
    lines.append(
        f"Follow-up planned in about {draft.follow_up_days} days. "
        "Answers were collected by an automated voice agent and scored "
        "deterministically; this note records a clinician's review of that draft."
    )
    return "\n".join(lines)


def _write_note(draft: CheckInDraft, encounter, user) -> NoteMessage:
    thread = NoteThread.objects.create(
        patient=draft.patient,
        encounter=encounter,
        title="CareLoop check-in",
        created_by=user,
        updated_by=user,
    )
    return NoteMessage.objects.create(
        thread=thread, message=_note_body(draft), created_by=user, updated_by=user
    )


@transaction.atomic
def approve_draft(
    draft: CheckInDraft,
    clinician,
    *,
    acknowledge_critical: bool = False,
) -> dict:
    """Approve a draft, writing it to the chart. All of it, or none of it.

    The clinician is recorded as the approver; the **service account** submits
    the questionnaire, so the answers stay attributed to the agent that
    collected them.
    """
    if draft.status != DraftStatus.PENDING_REVIEW:
        raise ApprovalStateError(
            f"Draft is {draft.status}, so it cannot be approved again."
        )

    if acknowledge_critical and not draft.critical_acknowledged:
        draft.critical_acknowledged = True

    if draft.blocks_approval:
        raise ApprovalBlocked(
            "This draft has a critical finding that has not been acknowledged. "
            "Acknowledge it explicitly before approving."
        )

    agent, _ = ensure_service_account()
    module = get_module(draft.module_id)

    encounter = ensure_encounter(draft, clinician)

    response = submit_check_in(
        module=module,
        patient=draft.patient,
        encounter=encounter,
        user=agent,
        item_answers=_item_answers(draft),
        total=draft.score_total,
    )

    written: list[MedicationRequest] = []
    skipped: list[str] = []
    for proposal in draft.medication_proposals.all():
        if not proposal.accepted:
            continue
        if not proposal.snomed_code:
            # Refused on purpose: see the module docstring.
            skipped.append(proposal.display)
            continue
        request = _write_medication_request(draft, proposal, encounter, clinician)
        proposal.medication_request_id = request.external_id
        proposal.save(update_fields=["medication_request_id", "modified_date"])
        written.append(request)

    note = _write_note(draft, encounter, clinician)

    draft.encounter = encounter
    draft.questionnaire_response_id = response.external_id
    draft.status = DraftStatus.APPROVED
    draft.reviewed_by = clinician
    draft.reviewed_at = timezone.now()
    draft.save(
        update_fields=[
            "encounter",
            "questionnaire_response_id",
            "status",
            "reviewed_by",
            "reviewed_at",
            "critical_acknowledged",
            "modified_date",
        ]
    )

    return {
        "encounter_id": str(encounter.external_id),
        "questionnaire_response_id": str(response.external_id),
        "medication_requests": [str(r.external_id) for r in written],
        "medications_skipped_unbound": skipped,
        "note_id": str(note.external_id),
    }


@transaction.atomic
def reject_draft(draft: CheckInDraft, clinician, reason: str) -> CheckInDraft:
    """Reject a draft. Writes nothing to the chart.

    A reason is required. A rejected draft with no explanation tells the next
    reviewer nothing, and the call itself is still on the record.
    """
    if draft.status != DraftStatus.PENDING_REVIEW:
        raise ApprovalStateError(
            f"Draft is {draft.status}, so it cannot be rejected."
        )
    if not reason.strip():
        raise ApprovalError("A rejection reason is required.")

    draft.status = DraftStatus.REJECTED
    draft.rejection_reason = reason.strip()
    draft.reviewed_by = clinician
    draft.reviewed_at = timezone.now()
    draft.save(
        update_fields=[
            "status",
            "rejection_reason",
            "reviewed_by",
            "reviewed_at",
            "modified_date",
        ]
    )
    return draft
