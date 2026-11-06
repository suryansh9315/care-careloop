"""Turn a completed call into a reviewable draft.

This is the deterministic half of the pipeline: score, band, pick the protocol
step, screen it for safety, decide escalation. All of it is pure functions from
`clinical/`, so the same answers always produce the same draft.

Nothing here touches the patient's chart. The draft and its medication proposals
live in the plugin's own tables until a clinician approves (see
`services/approval.py`).
"""

from __future__ import annotations

from django.db import transaction

from care_careloop.clinical import (
    InstrumentAnswer,
    RiskAnswer,
    check_regimen_safety,
    evaluate_risk,
    get_module,
    score_instrument,
    should_escalate,
    step_for_band,
)
from care_careloop.models import CallAttempt, CheckInDraft, DraftMedicationProposal
from care_careloop.services.context import load_patient_context


@transaction.atomic
def build_draft(
    call_attempt: CallAttempt,
    *,
    item_answers: dict[str, float],
    risk_answers: dict[str, str] | None = None,
    concerns: list[str] | None = None,
) -> CheckInDraft:
    """Score a call's answers and persist the resulting draft.

    ``item_answers`` and ``risk_answers`` come from the agent's declared output
    variables. They are treated as untrusted: the scoring clamp is what makes a
    garbled 2.5 or a spoken "about four" safe, and that clamping happens inside
    the clinical core rather than here.
    """
    candidate = call_attempt.candidate
    campaign = candidate.campaign
    patient = candidate.patient
    module = get_module(campaign.module_id)

    answers = [
        InstrumentAnswer(link_id=link_id, value=value)
        for link_id, value in item_answers.items()
    ]
    risks = [
        RiskAnswer(link_id=link_id, value=value)
        for link_id, value in (risk_answers or {}).items()
    ]

    score = score_instrument(module, answers)
    step = step_for_band(module, score.band)

    context = load_patient_context(patient, module)
    safety = check_regimen_safety(
        step.medications, context.allergies, context.current_medications
    )
    risk_findings = evaluate_risk(module, risks, score)
    escalated = should_escalate(
        urgent_step=step.urgent, safety=safety, risks=risk_findings
    )

    draft = CheckInDraft.objects.create(
        call_attempt=call_attempt,
        patient=patient,
        facility=campaign.facility,
        module_id=module.id,
        instrument_answers=[a.model_dump() for a in answers],
        risk_answers=[r.model_dump() for r in risks],
        concerns=concerns or [],
        score_total=score.total,
        band=score.band,
        band_label=score.band_label,
        crisis_override=score.crisis_override,
        protocol_step_id=step.id,
        follow_up_days=step.follow_up_days,
        safety_findings=[f.model_dump() for f in safety],
        risk_findings=[f.model_dump() for f in risk_findings],
        escalated=escalated,
    )

    for med in step.medications:
        DraftMedicationProposal.objects.create(
            draft=draft,
            display=med.display,
            role=med.role,
            sig=med.sig,
            route=med.route,
            frequency=med.frequency,
            prn=med.prn,
            duration_days=med.duration_days,
            quantity=med.quantity,
            refills=med.refills,
            ingredients=med.ingredients or [],
            # snomed_code stays blank: the protocol proposes a therapeutic step,
            # and the clinician binds the actual product at review from CARE's
            # own SNOMED-backed medication ValueSet (constraint C2).
            accepted=False,
        )

    return draft
