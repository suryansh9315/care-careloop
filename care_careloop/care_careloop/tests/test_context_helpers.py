"""Pure-function tests for the context reader's defensive parsing.

CARE stores codings as free-form JSON (`code`, `medication`, `main_code` are all
JSONFields), so shapes vary: a bare Coding, a CodeableConcept with a nested
`coding` list, or something with only a `text`. Getting a display name out of
that is fiddly and silent when wrong — an unparsed allergy means the safety
screen has nothing to match against.

Database-backed tests for `load_patient_context` and `has_open_care_gap` arrive
with Phase 3, once the questionnaire registration gives them real fixtures.
"""

from __future__ import annotations

import unittest

from care_careloop.services.context import _coding_display, _ingredient_tokens


class TestCodingDisplay(unittest.TestCase):
    def test_bare_coding(self) -> None:
        self.assertEqual(
            _coding_display({"system": "http://snomed.info/sct", "code": "91143003",
                             "display": "Salbutamol-containing product"}),
            "Salbutamol-containing product",
        )

    def test_codeable_concept_with_nested_coding(self) -> None:
        self.assertEqual(
            _coding_display({"coding": [{"code": "x", "display": "Budesonide"}], "text": "ignored"}),
            "Budesonide",
        )

    def test_text_only(self) -> None:
        self.assertEqual(_coding_display({"text": "Peanut allergy"}), "Peanut allergy")

    def test_falls_back_to_code_when_no_display(self) -> None:
        """A code is worse than a display, but far better than silence."""
        self.assertEqual(_coding_display({"code": "91143003"}), "91143003")

    def test_empty_and_malformed_are_safe(self) -> None:
        for value in (None, {}, {"coding": []}, {"display": ""}, "not-a-dict", 42):
            with self.subTest(value=value):
                self.assertEqual(_coding_display(value), "")


class TestIngredientTokens(unittest.TestCase):
    def test_strips_dose_and_units(self) -> None:
        """Short tokens and bare numbers must not become ingredients.

        Without the filter, "80" or "mcg" would match across unrelated products
        and the duplicate-therapy check would fire on everything.
        """
        tokens = _ingredient_tokens("Budesonide 80 mcg / formoterol 4.5 mcg inhaler")
        self.assertIn("budesonide", tokens)
        self.assertIn("formoterol", tokens)
        self.assertIn("inhaler", tokens)
        self.assertNotIn("80", tokens)
        self.assertNotIn("mcg", tokens)
        self.assertNotIn("4", tokens)

    def test_lowercases(self) -> None:
        self.assertEqual(_ingredient_tokens("PROPRANOLOL"), ["propranolol"])

    def test_empty_input(self) -> None:
        self.assertEqual(_ingredient_tokens(""), [])

    def test_tokens_feed_the_safety_screen(self) -> None:
        """The tokens produced here must actually trip a real interaction rule."""
        from care_careloop.clinical import MedicationSummary, check_regimen_safety
        from care_careloop.clinical import get_module

        display = "Propranolol 40 mg tablet"
        current = MedicationSummary(display=display, ingredients=_ingredient_tokens(display))
        regimen = get_module("asthma").steps["very-poor"].medications

        findings = check_regimen_safety(regimen, [], [current])
        self.assertIn("interaction", [f.code for f in findings])


if __name__ == "__main__":
    unittest.main()
