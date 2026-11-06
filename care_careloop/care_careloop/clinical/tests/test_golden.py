"""Cross-implementation check: the Python core against the frozen TypeScript core.

`data/core-golden.json` holds 363 input/output pairs produced by the previous
TypeScript implementation (`legacy/`, regenerate with `npm run golden`). Every
case is replayed here and compared exactly.

This is what makes the port *provably* behaviour-preserving rather than
plausibly so. It has already caught two real divergences:

* ``Math.round`` rounds half up, Python's ``round`` uses banker's rounding, so
  five ACT answers of 2.5 total 15 in JavaScript and would total 10 with
  ``round``. Hence `scoring.js_round`.
* ``NaN`` and ``+/-Infinity`` cannot be expressed in JSON, so the generator tags
  them and `_untag` decodes them. Without that the non-finite cases would be
  replayed as ``None`` -- a different input path than the one frozen.

What this file does **not** cover: the LOINC and SNOMED codes. Codes do not
affect scoring, so the golden file is blind to them -- which is exactly how the
ACT coding defect (constraint C12) survived in the original. That correction is
verified by `test_modules.py` instead.

Uses stdlib ``unittest`` rather than pytest: the CARE backend image does not
ship pytest, and the core should be testable without adding a dependency to it.
"""

from __future__ import annotations

import json
import math
import re
import unittest
from pathlib import Path
from typing import Any

from .. import modules as module_registry
from ..models import InstrumentAnswer, MedicationSummary, MedOrder, RiskAnswer, ScoreResult
from ..numbers import is_affirmative, parse_count
from ..safety import check_regimen_safety, evaluate_risk, has_critical, should_escalate
from ..scoring import completeness, score_instrument, step_for_band

GOLDEN_PATH = Path(__file__).parent / "data" / "core-golden.json"

_CAMEL = re.compile(r"(?<=[a-z0-9])([A-Z])")

_TAGS = {"@NaN": math.nan, "@Infinity": math.inf, "@-Infinity": -math.inf}


def _snake(key: str) -> str:
    return _CAMEL.sub(r"_\1", key).lower()


def _deep_snake(value: Any) -> Any:
    """Normalise the golden file's camelCase keys to the Python naming."""
    if isinstance(value, list):
        return [_deep_snake(v) for v in value]
    if isinstance(value, dict):
        return {_snake(k): _deep_snake(v) for k, v in value.items()}
    return value


def _untag(value: Any) -> Any:
    """Decode the non-finite sentinels the generator writes."""
    if isinstance(value, str) and value in _TAGS:
        return _TAGS[value]
    return value


def _answers(raw: list[dict[str, Any]]) -> list[InstrumentAnswer]:
    return [
        InstrumentAnswer(link_id=a["linkId"], value=_untag(a["value"])) for a in raw
    ]


def _score_dict(result: ScoreResult) -> dict[str, Any]:
    return result.model_dump()


def _findings(raw: list[Any]) -> list[dict[str, Any]]:
    """Golden findings, normalised. Absent `medication` means None."""
    out = []
    for finding in _deep_snake(raw):
        finding.setdefault("medication", None)
        out.append(finding)
    return out


class GoldenFileTest(unittest.TestCase):
    """Base class that loads the frozen cases once."""

    golden: dict[str, Any]

    @classmethod
    def setUpClass(cls) -> None:
        cls.golden = json.loads(GOLDEN_PATH.read_text())
        cls.cases = cls.golden["cases"]

    def _module(self, module_id: str):
        return module_registry.get_module(module_id)


class TestGoldenFilePresent(GoldenFileTest):
    def test_schema_and_size(self) -> None:
        self.assertEqual(self.golden["$schema"], "careloop-core-golden/1")
        total = sum(
            len(rows)
            for family in ("bandSweep", "malformed", "crisis", "risk", "safety")
            for rows in self.cases[family].values()
        )
        total += len(self.cases["escalation"])
        total += len(self.cases["numbers"]["parseCount"])
        total += len(self.cases["numbers"]["isAffirmative"])
        self.assertEqual(total, 363, "golden case count changed — regenerate deliberately")

    def test_modules_match(self) -> None:
        """The golden file and the registry describe the same instruments."""
        for described in self.golden["modules"]:
            with self.subTest(module=described["id"]):
                module = self._module(described["id"])
                self.assertEqual(module.instrument.id, described["instrument"])
                self.assertEqual(module.instrument.direction, described["direction"])
                self.assertEqual(module.instrument.min_total, described["minTotal"])
                self.assertEqual(module.instrument.max_total, described["maxTotal"])
                self.assertEqual(
                    [i.link_id for i in module.instrument.items],
                    [i["linkId"] for i in described["items"]],
                )
                self.assertEqual(
                    [(b.id, b.min, b.max) for b in module.bands],
                    [(b["id"], b["min"], b["max"]) for b in described["bands"]],
                )


class TestScoringGolden(GoldenFileTest):
    def _check_score_rows(self, family: str) -> None:
        for module_id, rows in self.cases[family].items():
            module = self._module(module_id)
            for row in rows:
                label = row.get("label", row.get("requestedTotal"))
                with self.subTest(family=family, module=module_id, case=label):
                    answers = _answers(row["answers"])
                    result = score_instrument(module, answers)
                    self.assertEqual(_score_dict(result), _deep_snake(row["score"]))

                    self.assertEqual(
                        completeness(module, answers).model_dump(),
                        _deep_snake(row["completeness"]),
                    )

                    if row.get("stepError"):
                        with self.assertRaises(ValueError):
                            step_for_band(module, result.band)
                    else:
                        step = step_for_band(module, result.band)
                        self.assertEqual(
                            step.model_dump(mode="json", exclude_none=True),
                            _deep_snake(row["step"]),
                        )

    def test_band_sweep(self) -> None:
        self._check_score_rows("bandSweep")

    def test_malformed_answers(self) -> None:
        self._check_score_rows("malformed")

    def test_crisis_override(self) -> None:
        self._check_score_rows("crisis")

    def test_crisis_actually_fires(self) -> None:
        """Guard against a vacuous pass: the crisis rows must include both outcomes."""
        rows = self.cases["crisis"]["depression"]
        fired = [r for r in rows if r["score"]["crisisOverride"]]
        self.assertGreater(len(fired), 0, "no crisis row fires — golden file is not exercising it")
        self.assertLess(len(fired), len(rows), "every crisis row fires — not discriminating")


class TestRiskGolden(GoldenFileTest):
    def test_risk_rules(self) -> None:
        for module_id, rows in self.cases["risk"].items():
            module = self._module(module_id)
            for row in rows:
                with self.subTest(module=module_id, case=row["label"]):
                    risk_answers = [
                        RiskAnswer(link_id=a["linkId"], value=a["value"])
                        for a in row["riskAnswers"]
                    ]
                    score = ScoreResult(**_deep_snake(row["score"]))
                    findings = evaluate_risk(module, risk_answers, score)
                    self.assertEqual(
                        [f.model_dump() for f in findings],
                        _deep_snake(row["findings"]),
                    )
                    self.assertEqual(has_critical(findings), row["hasCritical"])


class TestSafetyGolden(GoldenFileTest):
    def test_regimen_safety(self) -> None:
        for module_id, rows in self.cases["safety"].items():
            for row in rows:
                with self.subTest(module=module_id, case=row["label"]):
                    regimen = [
                        MedOrder(**_deep_snake(m)) for m in row["regimen"]
                    ]
                    context = row["context"]
                    current = [
                        MedicationSummary(**_deep_snake(m))
                        for m in context["currentMedications"]
                    ]
                    findings = check_regimen_safety(
                        regimen, context["allergies"], current
                    )
                    self.assertEqual(
                        [f.model_dump() for f in findings], _findings(row["findings"])
                    )
                    self.assertEqual(has_critical(findings), row["hasCritical"])

    def test_safety_actually_fires(self) -> None:
        """Guard against a vacuous pass."""
        for module_id, rows in self.cases["safety"].items():
            with_findings = [r for r in rows if r["findings"]]
            critical = [r for r in rows if r["hasCritical"]]
            self.assertGreater(len(with_findings), 0, f"{module_id}: no safety findings at all")
            self.assertGreater(len(critical), 0, f"{module_id}: no critical safety findings")


class TestEscalationGolden(GoldenFileTest):
    def test_truth_table(self) -> None:
        from ..models import RiskFinding, SafetyFinding

        for row in self.cases["escalation"]:
            with self.subTest(
                urgent=row["urgentStep"],
                safety=row["safetySeverity"],
                risk=row["riskSeverity"],
            ):
                safety = (
                    [SafetyFinding(severity=row["safetySeverity"], code="note", message="x")]
                    if row["safetySeverity"]
                    else []
                )
                risks = (
                    [RiskFinding(severity=row["riskSeverity"], code="x", message="x")]
                    if row["riskSeverity"]
                    else []
                )
                self.assertEqual(
                    should_escalate(
                        urgent_step=row["urgentStep"], safety=safety, risks=risks
                    ),
                    row["escalate"],
                )


class TestNumbersGolden(GoldenFileTest):
    def test_parse_count(self) -> None:
        for row in self.cases["numbers"]["parseCount"]:
            with self.subTest(text=row["text"]):
                self.assertEqual(parse_count(row["text"]), row["result"])

    def test_is_affirmative(self) -> None:
        for row in self.cases["numbers"]["isAffirmative"]:
            with self.subTest(text=row["text"]):
                self.assertEqual(is_affirmative(row["text"]), row["result"])

    def test_inherited_quirks_preserved(self) -> None:
        """Frozen oddities. Changing these is a deliberate act, not a cleanup."""
        self.assertEqual(parse_count("-2"), 2, "the minus sign is not part of the digit match")
        self.assertEqual(parse_count("3.5"), 3, "only the leading digits match")
        self.assertEqual(parse_count("about four canisters"), 4)
        self.assertEqual(parse_count("a couple"), 2, "'a' must not win over 'couple'")


if __name__ == "__main__":
    unittest.main()
