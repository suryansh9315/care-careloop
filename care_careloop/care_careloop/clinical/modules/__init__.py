"""Condition module registry.

A `ConditionModule` is the whole extension point for adding a condition. Adding
one means: drop a `<id>.json` next to this file, register its behavioural hooks
below, and nothing else changes.

The data/logic split is deliberate. Clinical content (items, bands, protocol
steps, prompts, medication orders) is **data** in JSON, machine-exported from
the previous TypeScript implementation rather than retyped. Only the two
behavioural hooks are hand-written Python.

Validation is stricter than the previous implementation's: a module whose bands
do not cover its instrument range, or that is missing a protocol step, is
rejected at load rather than failing mid-call.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..models import ConditionModule, CrisisOverride, RiskRules
from .asthma import asthma_risk_rules
from .depression import depression_crisis_override, depression_risk_rules

_HERE = Path(__file__).parent

#: module id -> (risk rules, crisis override)
_HOOKS: dict[str, tuple[RiskRules | None, CrisisOverride | None]] = {
    "asthma": (asthma_risk_rules, None),
    "depression": (depression_risk_rules, depression_crisis_override),
}


class ModuleValidationError(ValueError):
    """A stored or built-in module that cannot be trusted to run a call."""


def validate_module(module: ConditionModule) -> None:
    """Reject a module that would fail unpredictably mid-call.

    Checked here rather than at use time because the failure modes are silent
    and clinical: a band gap means an answer lands on the cautious fallback
    without anyone noticing, and a missing protocol step means the fallback step
    is drafted under the wrong band's label.
    """
    instrument = module.instrument
    if not module.bands:
        raise ModuleValidationError(f"{module.id}: no score bands defined")

    for band in module.bands:
        if band.min > band.max:
            raise ModuleValidationError(
                f"{module.id}: band {band.id} has min {band.min} above max {band.max}"
            )

    ordered = sorted(module.bands, key=lambda b: b.min)
    if ordered[0].min != instrument.min_total:
        raise ModuleValidationError(
            f"{module.id}: bands start at {ordered[0].min}, "
            f"instrument minimum is {instrument.min_total}"
        )
    if ordered[-1].max != instrument.max_total:
        raise ModuleValidationError(
            f"{module.id}: bands end at {ordered[-1].max}, "
            f"instrument maximum is {instrument.max_total}"
        )
    for previous, current in zip(ordered, ordered[1:]):
        if current.min != previous.max + 1:
            raise ModuleValidationError(
                f"{module.id}: gap or overlap between bands {previous.id} "
                f"(max {previous.max}) and {current.id} (min {current.min})"
            )

    for band in module.bands:
        if band.id not in module.steps:
            raise ModuleValidationError(
                f"{module.id}: band {band.id} has no protocol step"
            )

    if module.crisis_band_id and module.crisis_band_id not in module.steps:
        raise ModuleValidationError(
            f"{module.id}: crisis band {module.crisis_band_id} has no protocol step"
        )
    if module.crisis_band_id and module.crisis_override is None:
        raise ModuleValidationError(
            f"{module.id}: declares crisis band {module.crisis_band_id} "
            "but no crisis_override hook"
        )

    item_ids = [item.link_id for item in instrument.items]
    if len(set(item_ids)) != len(item_ids):
        raise ModuleValidationError(f"{module.id}: duplicate instrument item link ids")

    reachable = sum(item.max for item in instrument.items)
    floor = sum(item.min for item in instrument.items)
    if floor != instrument.min_total or reachable != instrument.max_total:
        raise ModuleValidationError(
            f"{module.id}: items span {floor}-{reachable} but instrument declares "
            f"{instrument.min_total}-{instrument.max_total}"
        )

    if module.experts and not any(e.safety_reviewer for e in module.experts):
        raise ModuleValidationError(f"{module.id}: no expert is the safety reviewer")


def load_module(module_id: str) -> ConditionModule:
    """Load one module from its JSON, attach its hooks, and validate it."""
    path = _HERE / f"{module_id}.json"
    if not path.exists():
        raise ModuleValidationError(f"Unknown condition module: {module_id}")
    module = ConditionModule.model_validate(json.loads(path.read_text()))
    risk_rules, crisis_override = _HOOKS.get(module_id, (None, None))
    module.risk_rules = risk_rules
    module.crisis_override = crisis_override
    validate_module(module)
    return module


def built_in_ids() -> list[str]:
    return sorted(_HOOKS)


_REGISTRY: dict[str, ConditionModule] = {}


def get_module(module_id: str) -> ConditionModule:
    """A built-in module, loaded once and cached."""
    if module_id not in _REGISTRY:
        _REGISTRY[module_id] = load_module(module_id)
    return _REGISTRY[module_id]


def list_modules() -> list[ConditionModule]:
    return [get_module(module_id) for module_id in built_in_ids()]


__all__ = [
    "ModuleValidationError",
    "built_in_ids",
    "get_module",
    "list_modules",
    "load_module",
    "validate_module",
]
