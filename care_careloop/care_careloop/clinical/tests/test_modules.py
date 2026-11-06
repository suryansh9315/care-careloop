"""Module data, codes and validation.

The golden file compares *behaviour*, and codes do not affect behaviour — which
is precisely how the ACT coding defect survived unnoticed in the previous
implementation (Medplum never validated codes; CARE does). So the codes get
their own tests here, pinned to the values verified against the live terminology
server in spike V1. See `docs/spike-results.md`.
"""

from __future__ import annotations

import unittest

from ..models import InstrumentAnswer, RiskAnswer, ScoreResult
from ..modules import (
    ModuleValidationError,
    built_in_ids,
    get_module,
    list_modules,
    load_module,
    validate_module,
)
from ..modules.depression import depression_crisis_override
from ..scoring import score_instrument

#: Verified against POST /api/v1/valueset/system-observation/validate_code/
CORRECT_ACT_CODES = {
    "panel": "82674-3",
    "total": "82668-5",
    "act-1": "82669-3",
    "act-2": "82670-1",
    "act-3": "82671-9",
    "act-4": "82672-7",
    "act-5": "82673-5",
}

#: The codes shipped by the previous implementation. Every one is invalid LOINC:
#: the check digits are wrong, and the item assignment is shifted one position
#: because the panel's total-score code was used as item 1's code.
INVALID_ACT_CODES = {
    "82674-1", "82673-3", "82668-3", "82669-1", "82670-9", "82671-7", "82672-5",
}

#: PHQ-9's codes were checked the same way and are all correct.
CORRECT_PHQ9_ITEM_CODES = [
    "44250-9", "44255-8", "44259-0", "44254-1", "44251-7",
    "44258-2", "44252-5", "44253-3", "44260-8",
]


class TestRegistry(unittest.TestCase):
    def test_both_modules_load_and_validate(self) -> None:
        self.assertEqual(built_in_ids(), ["asthma", "depression"])
        self.assertEqual([m.id for m in list_modules()], ["asthma", "depression"])

    def test_unknown_module_is_rejected(self) -> None:
        with self.assertRaises(ModuleValidationError):
            load_module("nope")

    def test_hooks_are_attached(self) -> None:
        self.assertIsNotNone(get_module("asthma").risk_rules)
        self.assertIsNone(get_module("asthma").crisis_override)
        self.assertIsNotNone(get_module("depression").risk_rules)
        self.assertIsNotNone(get_module("depression").crisis_override)


class TestActCodesCorrected(unittest.TestCase):
    """Constraint C12. These assertions are the fix; do not relax them."""

    def setUp(self) -> None:
        self.module = get_module("asthma")

    def test_panel_and_total_codes(self) -> None:
        self.assertEqual(self.module.instrument.loinc_panel_code, CORRECT_ACT_CODES["panel"])
        self.assertEqual(self.module.instrument.loinc_total_code, CORRECT_ACT_CODES["total"])

    def test_item_codes(self) -> None:
        for item in self.module.instrument.items:
            with self.subTest(item=item.link_id):
                self.assertEqual(item.loinc_code, CORRECT_ACT_CODES[item.link_id])

    def test_no_invalid_code_survives_anywhere(self) -> None:
        """A guard against a partial fix or a regenerated export losing the map."""
        present = {
            self.module.instrument.loinc_panel_code,
            self.module.instrument.loinc_total_code,
            *(i.loinc_code for i in self.module.instrument.items),
        }
        leaked = present & INVALID_ACT_CODES
        self.assertEqual(leaked, set(), f"invalid ACT LOINC codes still present: {leaked}")

    def test_total_code_is_not_an_item_code(self) -> None:
        """The original defect: the total-score code was reused as item 1's code."""
        item_codes = {i.loinc_code for i in self.module.instrument.items}
        self.assertNotIn(self.module.instrument.loinc_total_code, item_codes)
        self.assertNotIn(self.module.instrument.loinc_panel_code, item_codes)


class TestPhq9Codes(unittest.TestCase):
    def test_item_codes_unchanged(self) -> None:
        module = get_module("depression")
        self.assertEqual(
            [i.loinc_code for i in module.instrument.items], CORRECT_PHQ9_ITEM_CODES
        )

    def test_crisis_item_code(self) -> None:
        """Safety-critical: item 9 must be the suicidal-ideation concept."""
        module = get_module("depression")
        item9 = next(i for i in module.instrument.items if i.link_id == "phq9-9")
        self.assertEqual(item9.loinc_code, "44260-8")


class TestCrisisOverrideSemantics(unittest.TestCase):
    def test_any_endorsement_fires(self) -> None:
        for value in (1, 2, 3):
            with self.subTest(value=value):
                self.assertTrue(
                    depression_crisis_override(
                        [InstrumentAnswer(link_id="phq9-9", value=value)]
                    )
                )

    def test_zero_does_not_fire(self) -> None:
        self.assertFalse(
            depression_crisis_override([InstrumentAnswer(link_id="phq9-9", value=0)])
        )

    def test_absent_does_not_fire(self) -> None:
        self.assertFalse(depression_crisis_override([]))

    def test_first_match_wins_unlike_scoring(self) -> None:
        """The override uses first-match; scoring uses last-write-wins.

        Inherited from the TypeScript (`Array.find` vs `new Map`). They really do
        differ, so a duplicate answer can score as 0 while still diverting to the
        crisis pathway — which is the safe direction, and is frozen behaviour.
        """
        answers = [
            InstrumentAnswer(link_id="phq9-9", value=3),
            InstrumentAnswer(link_id="phq9-9", value=0),
        ]
        self.assertTrue(depression_crisis_override(answers))
        result = score_instrument(get_module("depression"), answers)
        self.assertEqual(result.total, 0, "scoring takes the last answer")
        self.assertTrue(result.crisis_override, "override still fires on the first")
        self.assertEqual(result.band, "crisis")

    def test_crisis_overrides_a_minimal_band(self) -> None:
        module = get_module("depression")
        result = score_instrument(
            module, [InstrumentAnswer(link_id="phq9-9", value=1)]
        )
        self.assertEqual(result.total, 1)
        self.assertEqual(result.band, "crisis")
        self.assertEqual(result.band_label, "Crisis pathway")

    def test_crisis_step_drafts_no_antidepressant(self) -> None:
        """The crisis pathway must not propose pharmacotherapy from a phone call."""
        module = get_module("depression")
        self.assertEqual(module.steps["crisis"].medications, [])
        self.assertTrue(module.steps["crisis"].urgent)


class TestModuleValidation(unittest.TestCase):
    """Validation is stricter than the previous implementation's."""

    def _asthma(self):
        return load_module("asthma")

    def test_band_gap_is_rejected(self) -> None:
        module = self._asthma()
        module.bands[1].min = 12  # leaves 11 uncovered
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("gap or overlap", str(ctx.exception))

    def test_bands_must_reach_instrument_maximum(self) -> None:
        module = self._asthma()
        module.bands[-1].max = 24
        with self.assertRaises(ModuleValidationError):
            validate_module(module)

    def test_missing_protocol_step_is_rejected(self) -> None:
        module = self._asthma()
        del module.steps["poor"]
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("no protocol step", str(ctx.exception))

    def test_inverted_band_is_rejected(self) -> None:
        module = self._asthma()
        module.bands[0].min, module.bands[0].max = 10, 5
        with self.assertRaises(ModuleValidationError):
            validate_module(module)

    def test_missing_safety_reviewer_is_rejected(self) -> None:
        module = self._asthma()
        for expert in module.experts:
            expert.safety_reviewer = False
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("safety reviewer", str(ctx.exception))

    def test_crisis_band_without_override_is_rejected(self) -> None:
        module = load_module("depression")
        module.crisis_override = None
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("crisis_override", str(ctx.exception))

    def test_duplicate_item_link_ids_rejected(self) -> None:
        module = self._asthma()
        module.instrument.items[1].link_id = module.instrument.items[0].link_id
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("duplicate", str(ctx.exception))

    def test_item_span_must_match_instrument_range(self) -> None:
        module = self._asthma()
        module.instrument.items[0].max = 6  # span becomes 5..26
        with self.assertRaises(ModuleValidationError) as ctx:
            validate_module(module)
        self.assertIn("items span", str(ctx.exception))

    def test_both_built_ins_pass(self) -> None:
        for module_id in built_in_ids():
            with self.subTest(module=module_id):
                validate_module(load_module(module_id))


class TestRiskRulesDirectly(unittest.TestCase):
    """Spot checks on the speech-driven paths, beyond the golden replay."""

    def test_spoken_canister_count_triggers_overuse(self) -> None:
        module = get_module("asthma")
        score = ScoreResult(
            total=20, band="controlled", band_label="Well controlled", crisis_override=False
        )
        findings = module.risk_rules(
            [RiskAnswer(link_id="risk-reliever-canisters", value="about four canisters")],
            score,
        )
        codes = [f.code for f in findings]
        self.assertIn("reliever-overuse", codes)
        overuse = next(f for f in findings if f.code == "reliever-overuse")
        self.assertEqual(overuse.severity, "critical")
        self.assertIn("4 reliever canisters", overuse.message)

    def test_refusal_does_not_fabricate_a_count(self) -> None:
        module = get_module("asthma")
        score = ScoreResult(
            total=20, band="controlled", band_label="Well controlled", crisis_override=False
        )
        findings = module.risk_rules(
            [RiskAnswer(link_id="risk-reliever-canisters", value="I would rather not say")],
            score,
        )
        self.assertNotIn("reliever-overuse", [f.code for f in findings])

    def test_negated_answer_is_not_affirmative(self) -> None:
        module = get_module("asthma")
        score = ScoreResult(
            total=20, band="controlled", band_label="Well controlled", crisis_override=False
        )
        findings = module.risk_rules(
            [RiskAnswer(link_id="risk-hospitalisation", value="no, never")], score
        )
        self.assertNotIn("prior-hospitalisation", [f.code for f in findings])


if __name__ == "__main__":
    unittest.main()
