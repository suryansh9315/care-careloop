"""Asthma (ACT) behavioural hooks.

Hand-ported from `legacy/src/conditions/asthma.ts`. The module's *data* lives in
`asthma.json`, machine-exported from the same file with the ACT LOINC codes
corrected (constraint C12).

Message strings are reproduced exactly: the golden file compares finding
messages, so rewording any of them here is a divergence, not a tidy-up.
"""

from __future__ import annotations

from ..models import RiskAnswer, RiskFinding, ScoreResult
from ..numbers import is_affirmative, parse_count


def _first(answers: list[RiskAnswer], link_id: str) -> str:
    """First answer for a link id, matching the TypeScript ``Array.find``."""
    for answer in answers:
        if answer.link_id == link_id:
            return answer.value
    return ""


def asthma_risk_rules(
    answers: list[RiskAnswer], score: ScoreResult
) -> list[RiskFinding]:
    findings: list[RiskFinding] = []

    # Answers arrive as speech, so "twice" and "about four" have to count.
    exacerbations = parse_count(_first(answers, "risk-exacerbations"))
    exacerbation_count = 0 if exacerbations is None else exacerbations
    if exacerbation_count >= 2:
        findings.append(
            RiskFinding(
                severity="critical",
                code="frequent-exacerbations",
                message=(
                    f"Patient reports {exacerbation_count} exacerbations requiring oral "
                    "steroids in the past year — a strong predictor of future severe "
                    "exacerbation."
                ),
            )
        )
    elif exacerbation_count == 1:
        findings.append(
            RiskFinding(
                severity="warning",
                code="recent-exacerbation",
                message="One steroid-requiring exacerbation in the past year.",
            )
        )

    canisters_raw = parse_count(_first(answers, "risk-reliever-canisters"))
    canisters = 0 if canisters_raw is None else canisters_raw
    if canisters >= 3:
        findings.append(
            RiskFinding(
                severity="critical",
                code="reliever-overuse",
                message=(
                    f"Reports {canisters} reliever canisters in 12 months. Three or more "
                    "is associated with increased mortality risk and indicates inadequate "
                    "controller therapy."
                ),
            )
        )

    if is_affirmative(_first(answers, "risk-hospitalisation")):
        findings.append(
            RiskFinding(
                severity="critical",
                code="prior-hospitalisation",
                message=(
                    "Prior asthma hospitalisation or ICU admission — highest-risk phenotype."
                ),
            )
        )

    # The adherence-gap and smoke-exposure questions were cut from the call to
    # keep it short. These rules stay and simply never fire without an answer.
    if is_affirmative(_first(answers, "risk-adherence-gap")):
        findings.append(
            RiskFinding(
                severity="warning",
                code="adherence-gap",
                message=(
                    "Patient reports missing controller doses. Adherence and inhaler "
                    "technique should be addressed before stepping up therapy."
                ),
            )
        )

    if is_affirmative(_first(answers, "risk-smoke-exposure")):
        findings.append(
            RiskFinding(
                severity="warning",
                code="smoke-exposure",
                message=(
                    "Ongoing tobacco or smoke exposure reduces inhaled corticosteroid "
                    "responsiveness."
                ),
            )
        )

    if score.total <= 15:
        findings.append(
            RiskFinding(
                severity="warning",
                code="uncontrolled-score",
                message=(
                    f"ACT total of {score.total} indicates poorly controlled asthma "
                    "independent of the risk answers."
                ),
            )
        )

    return findings
