"""Clinical core data model.

Ported from `legacy/src/types.ts` and `legacy/src/conditions/types.ts`.

This package deliberately imports **no Django and no CARE code**. It is the part
of the system where being wrong matters, so it stays a pure library that can be
reasoned about and tested on its own. Everything that touches the database, the
API or Sarvam lives outside `clinical/`.
"""

from __future__ import annotations

from typing import Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["info", "warning", "critical"]
MedRole = Literal["controller", "reliever", "primary", "adjunct"]
Direction = Literal["higher-is-better", "higher-is-worse"]
Expects = Literal["yes-no", "count", "text"]
SafetyCode = Literal["allergy-match", "duplicate-therapy", "interaction", "note"]


class MedOrder(BaseModel):
    """A medication the protocol proposes. Nothing here is a prescription.

    `rxnorm_code` is carried over from the previous implementation. CARE binds
    medications to **SNOMED CT**, not RxNorm (constraint C2), so these codes are
    not written to the chart: the protocol proposes a therapeutic step and the
    clinician binds the actual product through CARE's own medication ValueSet at
    review time.
    """

    display: str
    rxnorm_code: str
    role: MedRole
    sig: str
    route: str
    frequency: str
    prn: bool
    duration_days: int | None = None
    quantity: float | None = None
    refills: int | None = None
    ingredients: list[str] | None = None


class MedicationSummary(BaseModel):
    """A medication the patient is already on, read from CARE."""

    display: str
    rxnorm_code: str | None = None
    ingredients: list[str] | None = None


class InstrumentItem(BaseModel):
    link_id: str
    loinc_code: str
    prompt: str
    min: int
    max: int
    scale_hint: str


class Instrument(BaseModel):
    id: str
    name: str
    loinc_panel_code: str
    loinc_total_code: str
    min_total: int
    max_total: int
    direction: Direction
    items: list[InstrumentItem]


class ScoreBand(BaseModel):
    id: str
    label: str
    min: int
    max: int


class RiskQuestion(BaseModel):
    link_id: str
    prompt: str
    expects: Expects


class ProtocolStep(BaseModel):
    id: str
    summary: str
    patient_goal: str
    medications: list[MedOrder] = Field(default_factory=list)
    follow_up_days: int
    referral_required: bool
    urgent: bool


class ExpertPersona(BaseModel):
    """Retained as data. The expert-panel enrichment layer is deferred."""

    id: str
    name: str
    specialty: str
    safety_reviewer: bool
    system_prompt: str


class InstrumentAnswer(BaseModel):
    """A scored answer.

    `value` is a float, not an int, on purpose: a voice pipeline can produce
    2.5, 1e9, NaN or -Infinity, and the scoring clamp is what makes those safe.
    Rejecting them here would move the failure somewhere less visible.
    """

    link_id: str
    value: float


class RiskAnswer(BaseModel):
    """Supplemental risk answers are yes/no or short free text, as spoken."""

    link_id: str
    value: str


class ScoreResult(BaseModel):
    total: int
    band: str
    band_label: str
    crisis_override: bool


class Completeness(BaseModel):
    answered: int
    total: int
    complete: bool


class SafetyFinding(BaseModel):
    severity: Severity
    code: SafetyCode
    message: str
    medication: str | None = None


class RiskFinding(BaseModel):
    severity: Severity
    code: str
    message: str


RiskRules = Callable[[list[RiskAnswer], ScoreResult], list[RiskFinding]]
CrisisOverride = Callable[[list[InstrumentAnswer]], bool]


class ConditionModule(BaseModel):
    """The whole extension point for adding a condition.

    Data comes from `modules/<id>.json`, machine-exported from the previous
    TypeScript implementation so ~600 lines of clinical content were not
    retyped. The two behavioural hooks (`risk_rules`, `crisis_override`) are
    hand-ported Python, attached by the registry.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    id: str
    display: str
    icd10: str
    snomed: str
    instrument: Instrument
    bands: list[ScoreBand]
    risk_questions: list[RiskQuestion] = Field(default_factory=list)
    steps: dict[str, ProtocolStep]
    emergency_rules: list[str] = Field(default_factory=list)
    crisis_band_id: str | None = None
    experts: list[ExpertPersona] = Field(default_factory=list)

    risk_rules: RiskRules | None = Field(default=None, exclude=True, repr=False)
    crisis_override: CrisisOverride | None = Field(default=None, exclude=True, repr=False)
