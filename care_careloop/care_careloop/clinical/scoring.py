"""Scoring and protocol selection.

Ported from `legacy/src/orchestration/scoring.ts`.

Deliberately deterministic. The language model never chooses the band or the
medication: given the same answers these functions return the same plan, and
that is what makes the core inspectable.
"""

from __future__ import annotations

import math

from .models import (
    Completeness,
    ConditionModule,
    InstrumentAnswer,
    ProtocolStep,
    ScoreResult,
)


def js_round(value: float) -> int:
    """Round half **up** (toward +infinity), matching JavaScript's ``Math.round``.

    Not a stylistic choice. Python's builtin ``round`` uses banker's rounding,
    so ``round(2.5) == 2`` where ``Math.round(2.5) === 3``. The golden file
    froze the JavaScript behaviour: an answer of 2.5 on all five ACT items
    totals 15, and ``round`` would make it 10. Negative halves match too --
    ``Math.round(-2.5) === -2``, and ``floor(-2.5 + 0.5) == -2``.
    """
    return math.floor(value + 0.5)


def _clamp(value: float, low: int, high: int) -> int:
    """Clamp an answer into its item's range.

    A non-finite value becomes the item's minimum rather than raising. On a
    phone call a garbled answer must not take down the pipeline, and the
    *lowest* value is the cautious choice for both instruments: on ACT low means
    worse control, and on PHQ-9 the crisis override is what catches severity.
    """
    if not math.isfinite(value):
        return low
    return min(max(js_round(value), low), high)


def _most_cautious_band(module: ConditionModule):
    """The band to fall back to when banding fails: worst severity.

    An unexpected input should escalate to a clinician rather than under-treat.
    """
    if module.instrument.direction == "higher-is-worse":
        bands = sorted(module.bands, key=lambda b: -b.max)
    else:
        bands = sorted(module.bands, key=lambda b: b.min)
    if not bands:
        raise ValueError(f"Module {module.id} defines no bands")
    return bands[0]


def score_instrument(
    module: ConditionModule, answers: list[InstrumentAnswer]
) -> ScoreResult:
    """Total, band and crisis flag for a set of answers."""
    # A later answer for the same item wins, matching the TS Map construction.
    by_link_id = {answer.link_id: answer.value for answer in answers}

    total_raw = 0
    for item in module.instrument.items:
        raw = by_link_id.get(item.link_id)
        if raw is None:
            continue
        total_raw += _clamp(raw, item.min, item.max)

    total = _clamp(total_raw, module.instrument.min_total, module.instrument.max_total)

    crisis = bool(module.crisis_override(answers)) if module.crisis_override else False
    if crisis and module.crisis_band_id:
        return ScoreResult(
            total=total,
            band=module.crisis_band_id,
            band_label="Crisis pathway",
            crisis_override=True,
        )

    for band in module.bands:
        if band.min <= total <= band.max:
            return ScoreResult(
                total=total, band=band.id, band_label=band.label, crisis_override=False
            )

    # Should be unreachable given the clamp, but a missing band must not throw
    # mid-pipeline: fall back to the most cautious band the module defines.
    fallback = _most_cautious_band(module)
    return ScoreResult(
        total=total, band=fallback.id, band_label=fallback.label, crisis_override=False
    )


def step_for_band(module: ConditionModule, band_id: str) -> ProtocolStep:
    """The protocol step for a band, falling back to the most cautious one."""
    step = module.steps.get(band_id)
    if step is not None:
        return step
    fallback = _most_cautious_band(module)
    fallback_step = module.steps.get(fallback.id)
    if fallback_step is None:
        raise ValueError(
            f"Module {module.id} defines no protocol step for band {band_id}"
        )
    return fallback_step


def completeness(
    module: ConditionModule, answers: list[InstrumentAnswer]
) -> Completeness:
    """Answered items only, so a partial call is visibly partial."""
    link_ids = {item.link_id for item in module.instrument.items}
    answered = len({a.link_id for a in answers if a.link_id in link_ids})
    return Completeness(
        answered=answered, total=len(link_ids), complete=answered == len(link_ids)
    )
