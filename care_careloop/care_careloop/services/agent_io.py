"""The contract between the Sarvam agent and this plugin.

Two directions, both deliberately narrow:

**In** (``on_start``) — everything the agent needs, loaded **once** before it
speaks: the patient's first name, their condition, allergies, active medications,
the prior score, and **the instrument questions verbatim**. Shipping the wording
as input variables is what lets the question text stay in this repo, under
review, without paying a round-trip per question. A mid-call tool per item would
be 8-10 pauses on the line and would make the call sound like an IVR.

**Out** (post-call webhook) — the agent's declared output variables, one per
instrument item and risk question. The agent *collects*; it never scores. The
totals and bands are recomputed here from these values by the clinical core, so
the agent cannot influence the plan except through the answers it recorded.

Variable names are derived from link ids by replacing ``-`` with ``_``, because
Sarvam variable names have to be identifier-safe. The mapping is mechanical in
both directions, so there is no lookup table to drift.
"""

from __future__ import annotations

from care_careloop.clinical import ConditionModule, parse_count
from care_careloop.services.context import PatientContext

#: Free-text variable holding whatever the patient raised unprompted.
CONCERNS_VARIABLE = "patient_concerns"
#: Set by the agent when it took the crisis branch, as a cross-check against
#: our own scoring of the crisis item.
CRISIS_VARIABLE = "crisis_flagged"
#: The agent's own summary of how the call ended.
DISPOSITION_VARIABLE = "disposition"


def to_variable(link_id: str) -> str:
    """``act-1`` -> ``act_1``. Sarvam variable names must be identifier-safe."""
    return link_id.replace("-", "_")


def from_variable(name: str) -> str:
    """``act_1`` -> ``act-1``."""
    return name.replace("_", "-")


def agent_input_variables(
    module: ConditionModule, context: PatientContext
) -> dict[str, str]:
    """Everything the agent is told before the first word.

    Includes ``question_<link_id>`` and ``scale_<link_id>`` for every item, so
    the agent reads our wording rather than inventing its own. It is still an
    LLM speaking, so verbatim delivery is asserted by the eval suite rather than
    guaranteed — an honest limitation, recorded in the README.
    """
    variables: dict[str, str] = dict(context.to_agent_variables())

    variables["instrument_name"] = module.instrument.name
    variables["item_count"] = str(len(module.instrument.items))
    variables["emergency_rules"] = " ".join(module.emergency_rules)

    for item in module.instrument.items:
        key = to_variable(item.link_id)
        variables[f"question_{key}"] = item.prompt
        variables[f"scale_{key}"] = item.scale_hint

    for question in module.risk_questions:
        variables[f"question_{to_variable(question.link_id)}"] = question.prompt

    return variables


def expected_output_variables(module: ConditionModule) -> list[str]:
    """The variables the agent must declare. Used to author and verify the spec."""
    names = [to_variable(i.link_id) for i in module.instrument.items]
    names += [to_variable(q.link_id) for q in module.risk_questions]
    names += [CONCERNS_VARIABLE, CRISIS_VARIABLE, DISPOSITION_VARIABLE]
    return names


def _coerce_answer(raw) -> float | None:
    """Turn a spoken or typed scale answer into a number, or None.

    Runs everything through `parse_count`, the same tested parser the risk rules
    use. The agent is instructed to emit a digit, but "three" and "about four"
    arrive often enough that discarding them would silently score an answered
    item as unanswered. Out-of-range values are *not* rejected here — the
    clinical core's clamp handles them, and clamping in one place is what keeps
    the behaviour inspectable.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw).strip()
    if not text:
        return None
    parsed = parse_count(text)
    return None if parsed is None else float(parsed)


def _split_concerns(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(c).strip() for c in raw if str(c).strip()]
    text = str(raw).strip()
    if not text:
        return []
    # The agent emits one string; split on separators it plausibly uses.
    for sep in (" | ", ";", "\n"):
        if sep in text:
            return [part.strip() for part in text.split(sep) if part.strip()]
    return [text]


def parse_agent_output(
    module: ConditionModule, final_agent_variables: dict | None
) -> dict:
    """Read the agent's output variables into pipeline inputs.

    Tolerant by design. A call that dropped three items is a *partial* check-in,
    which the core reports through `completeness`, and a partial check-in is
    still worth a clinician's attention. Refusing to parse it would throw away
    what the patient did say.
    """
    variables = final_agent_variables or {}

    item_answers: dict[str, float] = {}
    for item in module.instrument.items:
        value = _coerce_answer(variables.get(to_variable(item.link_id)))
        if value is not None:
            item_answers[item.link_id] = value

    risk_answers: dict[str, str] = {}
    for question in module.risk_questions:
        raw = variables.get(to_variable(question.link_id))
        if raw is None:
            continue
        text = str(raw).strip()
        if text:
            risk_answers[question.link_id] = text

    return {
        "item_answers": item_answers,
        "risk_answers": risk_answers,
        "concerns": _split_concerns(variables.get(CONCERNS_VARIABLE)),
        "agent_flagged_crisis": str(variables.get(CRISIS_VARIABLE, "")).strip().lower()
        in {"true", "yes", "1"},
        "disposition": str(variables.get(DISPOSITION_VARIABLE, "")).strip(),
    }
