"""Assemble a patient's clinical context for a check-in call.

Ported from `legacy/src/orchestration/context.ts`, but the mechanism changed
completely. The previous implementation held a Medplum client credential and
made authenticated HTTP calls. This plugin is a Django app running **inside**
CARE, so it reads the ORM directly: no HTTP, no tokens, no client secret, and
none of `src/integrations/medplum.ts`. See constraint C4.

Writes are the opposite — those go through CARE's own service layer so audit
fields and validation are not bypassed.

What this returns feeds the Sarvam ``on_start`` hook, which loads it **once**
before the agent speaks. That is the whole reason the call does not need a
round-trip per question.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

from django.utils import timezone

from care.emr.models.allergy_intolerance import AllergyIntolerance
from care.emr.models.condition import Condition
from care.emr.models.medication_statement import MedicationStatement
from care.emr.models.observation import Observation
from care.emr.models.patient import Patient

from care_careloop.clinical import ConditionModule, MedicationSummary


def _coding_display(coding: dict | None) -> str:
    """Pull a human label out of one of CARE's coding JSONFields.

    Precedence is deliberate: an explicit ``display``, then a nested
    ``coding[0]`` for the CodeableConcept shape, then ``text``, then the raw
    ``code``. A coded display beats a free-text summary because the free text is
    author-supplied and often vaguer ("inhaler") than the concept it wraps
    ("Budesonide-containing product"). The raw code is last — worse than a name,
    far better than silence, since an unparsed allergy means the safety screen
    has nothing to match against.
    """
    if not isinstance(coding, dict) or not coding:
        return ""

    display = coding.get("display")
    if isinstance(display, str) and display:
        return display

    # CodeableConcept shape: {"coding": [...], "text": ...}
    nested = coding.get("coding")
    if isinstance(nested, list) and nested:
        inner = _coding_display(nested[0])
        if inner:
            return inner

    for key in ("text", "code"):
        value = coding.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _ingredient_tokens(display: str) -> list[str]:
    """Cheap ingredient guess from a product name.

    The safety screen's own ``_tokens_for`` applies the same >3-character filter
    when ingredients are absent, so this only needs to be good enough to let a
    duplicate or interaction match fire. It is explicitly not a terminology
    lookup, and the clinician sees the source medication name either way.
    """
    cleaned = "".join(c.lower() if c.isalnum() else " " for c in display)
    return [t for t in cleaned.split() if len(t) > 3 and not t.isdigit()]


@dataclass
class ScoreHistoryEntry:
    date: str
    total: int


@dataclass
class PatientContext:
    """Everything the agent is told before it speaks.

    Deliberately small. This crosses a trust boundary into a third-party voice
    platform, so it carries what the conversation needs and nothing more: no
    address, no identifiers, no diagnosis list, no free-text notes.
    """

    patient_id: str
    full_name: str
    first_name: str
    phone: str
    module_id: str
    condition_display: str = ""
    allergies: list[str] = field(default_factory=list)
    current_medications: list[MedicationSummary] = field(default_factory=list)
    score_history: list[ScoreHistoryEntry] = field(default_factory=list)

    @property
    def last_score(self) -> ScoreHistoryEntry | None:
        return self.score_history[-1] if self.score_history else None

    def to_agent_variables(self) -> dict[str, str]:
        """Flatten to the string variables Sarvam's agent accepts.

        Values are strings because that is what the platform passes through to
        the prompt. Anything the agent must *reason* about numerically is
        recomputed server-side from the output variables after the call.
        """
        last = self.last_score
        return {
            "patient_first_name": self.first_name,
            "condition_display": self.condition_display,
            "allergies": ", ".join(self.allergies) or "none recorded",
            "current_medications": ", ".join(m.display for m in self.current_medications)
            or "none recorded",
            "last_score": str(last.total) if last else "",
            "last_score_date": last.date if last else "",
        }


def _active_allergies(patient: Patient) -> list[str]:
    rows = AllergyIntolerance.objects.filter(patient=patient).exclude(
        clinical_status="inactive"
    )
    out = []
    for row in rows:
        display = _coding_display(row.code)
        if display:
            out.append(display)
    return out


def _active_medications(patient: Patient) -> list[MedicationSummary]:
    rows = MedicationStatement.objects.filter(patient=patient, status="active")
    out = []
    for row in rows:
        display = _coding_display(row.medication)
        if not display:
            continue
        out.append(
            MedicationSummary(display=display, ingredients=_ingredient_tokens(display))
        )
    return out


def _score_history(
    patient: Patient, module: ConditionModule, limit: int = 6
) -> list[ScoreHistoryEntry]:
    """Prior totals for this instrument, oldest to newest.

    Matched on the instrument's **total-score** LOINC code. For asthma that code
    is only correct because spike V1 found every ACT code in the previous
    implementation was invalid; querying with the old value would silently
    return nothing and the agent would tell every patient this was their first
    check-in. See constraint C12.
    """
    code = module.instrument.loinc_total_code
    rows = (
        Observation.objects.filter(
            patient=patient, main_code__code=code, status="final"
        )
        .order_by("-effective_datetime")[:limit]
    )
    history: list[ScoreHistoryEntry] = []
    for row in rows:
        value = row.value
        total = value.get("value") if isinstance(value, dict) else value
        try:
            total_int = int(float(total))
        except (TypeError, ValueError):
            continue
        when = row.effective_datetime or row.created_date
        history.append(
            ScoreHistoryEntry(date=when.date().isoformat() if when else "", total=total_int)
        )
    history.reverse()  # oldest first, so a trend reads left to right
    return history


def _condition_display(patient: Patient, module: ConditionModule) -> str:
    """The patient's own wording for the condition, if CARE has a diagnosis."""
    rows = Condition.objects.filter(patient=patient).exclude(
        clinical_status="resolved"
    )
    for row in rows:
        display = _coding_display(row.code)
        if display and module.display.split()[0].lower() in display.lower():
            return display
    return module.display


def load_patient_context(patient: Patient, module: ConditionModule) -> PatientContext:
    """Read everything the agent needs, in one pass over the ORM."""
    full_name = (patient.name or "").strip()
    first_name = full_name.split(" ")[0] if full_name else ""

    return PatientContext(
        patient_id=str(patient.external_id),
        full_name=full_name,
        first_name=first_name,
        phone=patient.phone_number or "",
        module_id=module.id,
        condition_display=_condition_display(patient, module),
        allergies=_active_allergies(patient),
        current_medications=_active_medications(patient),
        score_history=_score_history(patient, module),
    )


def has_open_care_gap(
    patient: Patient, module: ConditionModule, stale_days: int
) -> tuple[bool, str]:
    """Whether this patient has an open gap for the module, and why.

    The reason string is returned alongside the verdict because it is shown to
    the clinician in the review queue. A cohort nobody can explain is a cohort
    nobody should dial.
    """
    history = _score_history(patient, module, limit=1)
    if not history:
        return True, f"No recorded {module.instrument.name} result."

    last = history[-1]
    cutoff = (timezone.now() - timedelta(days=stale_days)).date().isoformat()
    if last.date and last.date < cutoff:
        return (
            True,
            f"Last {module.instrument.name} was {last.total} on {last.date}, "
            f"more than {stale_days} days ago.",
        )
    return False, f"{module.instrument.name} recorded {last.date} ({last.total})."
