"""The deterministic clinical core.

Given the same answers, this package returns the same plan. That property is
what makes the system reviewable, so the core is kept as a pure library:

* **No Django and no CARE imports.** Nothing here touches the database, the API
  or Sarvam. Those live in the viewsets, tasks and services above it.
* **No model calls.** Banding, medication selection, the crisis override and the
  safety screen are pure functions of the recorded answers.
* **Behaviour frozen against the previous implementation.** This is a port from
  TypeScript; `tests/test_golden.py` replays 363 frozen input/output cases and
  asserts byte-equal results. See `docs/REVAMP-PLAN.md` phase 2.

The language model's job is to collect answers. Scoring them is this package's.
"""

from .models import (
    Completeness,
    ConditionModule,
    InstrumentAnswer,
    MedicationSummary,
    MedOrder,
    ProtocolStep,
    RiskAnswer,
    RiskFinding,
    SafetyFinding,
    ScoreResult,
)
from .modules import ModuleValidationError, get_module, list_modules, validate_module
from .numbers import is_affirmative, parse_count
from .safety import (
    check_regimen_safety,
    evaluate_risk,
    has_critical,
    should_escalate,
)
from .scoring import completeness, score_instrument, step_for_band

__all__ = [
    "Completeness",
    "ConditionModule",
    "InstrumentAnswer",
    "MedOrder",
    "MedicationSummary",
    "ModuleValidationError",
    "ProtocolStep",
    "RiskAnswer",
    "RiskFinding",
    "SafetyFinding",
    "ScoreResult",
    "check_regimen_safety",
    "completeness",
    "evaluate_risk",
    "get_module",
    "has_critical",
    "is_affirmative",
    "list_modules",
    "parse_count",
    "score_instrument",
    "should_escalate",
    "step_for_band",
    "validate_module",
]
