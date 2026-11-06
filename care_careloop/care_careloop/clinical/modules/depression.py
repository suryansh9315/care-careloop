"""Depression (PHQ-9) behavioural hooks.

Hand-ported from `legacy/src/conditions/depression.ts`. The module's *data* lives
in `depression.json`. PHQ-9's 11 LOINC codes were verified correct against the
live terminology server, including ``44260-8`` for item 9, so unlike ACT they
needed no correction.

Message strings are reproduced exactly: the golden file compares finding
messages.
"""

from __future__ import annotations

from ..models import InstrumentAnswer, RiskAnswer, RiskFinding, ScoreResult
from ..numbers import is_affirmative

#: PHQ-9 item 9 — suicidal ideation. Any answer above zero diverts to the
#: crisis pathway regardless of the numeric band.
CRISIS_ITEM_LINK_ID = "phq9-9"


def _first(answers: list[RiskAnswer], link_id: str) -> str:
    """First answer for a link id, matching the TypeScript ``Array.find``."""
    for answer in answers:
        if answer.link_id == link_id:
            return answer.value
    return ""


def depression_crisis_override(answers: list[InstrumentAnswer]) -> bool:
    """True when PHQ-9 item 9 is endorsed above zero.

    Uses **first**-match semantics, like the TypeScript ``Array.find`` it
    replaces. Scoring itself is last-write-wins on duplicate answers, so the two
    deliberately differ; this is the frozen behaviour.
    """
    for answer in answers:
        if answer.link_id == CRISIS_ITEM_LINK_ID:
            return answer.value > 0
    return False


def depression_risk_rules(
    answers: list[RiskAnswer], score: ScoreResult
) -> list[RiskFinding]:
    findings: list[RiskFinding] = []

    if is_affirmative(_first(answers, "risk-prior-attempt")):
        findings.append(
            RiskFinding(
                severity="critical",
                code="prior-attempt",
                message=(
                    "History of a prior suicide attempt — the strongest single predictor "
                    "of future attempt. Requires clinician contact regardless of PHQ-9 band."
                ),
            )
        )

    if is_affirmative(_first(answers, "risk-support")):
        findings.append(
            RiskFinding(
                severity="warning",
                code="low-support",
                message=(
                    "Patient reports little or no day-to-day support, which reduces the "
                    "safety of a purely remote plan."
                ),
            )
        )

    if is_affirmative(_first(answers, "risk-substance")):
        findings.append(
            RiskFinding(
                severity="warning",
                code="substance-use",
                message=(
                    "Increased alcohol or substance use reported alongside low mood — "
                    "affects both risk and treatment response."
                ),
            )
        )

    if is_affirmative(_first(answers, "risk-prior-treatment")):
        findings.append(
            RiskFinding(
                severity="info",
                code="prior-treatment",
                message=(
                    "Patient has taken an antidepressant before; prior agent, dose, "
                    "duration and response should be confirmed before selecting therapy."
                ),
            )
        )

    if score.crisis_override:
        findings.append(
            RiskFinding(
                severity="critical",
                code="self-harm-item",
                message=(
                    "PHQ-9 item 9 was answered above zero. Crisis pathway applies and "
                    "overrides the score band."
                ),
            )
        )
    elif score.total >= 20:
        findings.append(
            RiskFinding(
                severity="warning",
                code="severe-score",
                message=f"PHQ-9 total of {score.total} is in the severe range.",
            )
        )

    return findings
