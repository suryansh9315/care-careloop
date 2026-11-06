"""The questionnaire we register, independent of a database.

These are the properties that break the write path silently if they regress, so
they are pinned here rather than left to an integration run:

* ``subject_type`` must be ``"encounter"`` — a ``"patient"`` questionnaire
  returns HTTP 200 and produces zero observations (C13).
* The **total-score question must exist**. Without it the chart gets item
  observations but no total, and the care-gap detector — which matches on the
  total-score code — never sees a completed check-in, so the campaign re-dials
  the same patient forever.
* Question ids must be **stable** across re-registration, because stored
  responses reference them by id.
* Codes must be the corrected ACT set (C12).
"""

from __future__ import annotations

import unittest
import uuid

from care_careloop.clinical import get_module
from care_careloop.services.questionnaire import (
    QUESTION_NAMESPACE,
    build_questions,
    build_spec_payload,
    question_id,
    questionnaire_slug,
    total_link_id,
)

CORRECT_ACT_ITEM_CODES = ["82669-3", "82670-1", "82671-9", "82672-7", "82673-5"]
ACT_TOTAL_CODE = "82668-5"
PHQ9_TOTAL_CODE = "44261-6"


class TestQuestionnaireShape(unittest.TestCase):
    def test_subject_type_is_encounter(self) -> None:
        """The single most consequential field. See C13."""
        for module_id in ("asthma", "depression"):
            with self.subTest(module=module_id):
                payload = build_spec_payload(get_module(module_id), [uuid.uuid4()])
                self.assertEqual(payload["subject_type"], "encounter")

    def test_question_count_is_items_plus_total(self) -> None:
        for module_id, expected_items in (("asthma", 5), ("depression", 9)):
            with self.subTest(module=module_id):
                questions = build_questions(get_module(module_id))
                self.assertEqual(len(questions), expected_items + 1)

    def test_total_question_present_and_coded(self) -> None:
        for module_id, total_code in (
            ("asthma", ACT_TOTAL_CODE),
            ("depression", PHQ9_TOTAL_CODE),
        ):
            with self.subTest(module=module_id):
                module = get_module(module_id)
                questions = build_questions(module)
                totals = [
                    q for q in questions if q["link_id"] == total_link_id(module)
                ]
                self.assertEqual(len(totals), 1, "exactly one total question")
                self.assertEqual(totals[0]["code"]["code"], total_code)
                self.assertTrue(totals[0]["is_observation"])

    def test_total_code_is_not_reused_by_an_item(self) -> None:
        """The original ACT defect reused the total code as item 1's code."""
        for module_id in ("asthma", "depression"):
            with self.subTest(module=module_id):
                module = get_module(module_id)
                questions = build_questions(module)
                total_q = next(
                    q for q in questions if q["link_id"] == total_link_id(module)
                )
                item_codes = [
                    q["code"]["code"]
                    for q in questions
                    if q["link_id"] != total_link_id(module)
                ]
                self.assertNotIn(total_q["code"]["code"], item_codes)

    def test_act_item_codes_are_the_corrected_set(self) -> None:
        module = get_module("asthma")
        questions = build_questions(module)
        item_codes = [
            q["code"]["code"]
            for q in questions
            if q["link_id"] != total_link_id(module)
        ]
        self.assertEqual(item_codes, CORRECT_ACT_ITEM_CODES)

    def test_every_question_is_an_observation(self) -> None:
        """A question with is_observation False produces no Observation row."""
        for module_id in ("asthma", "depression"):
            with self.subTest(module=module_id):
                for q in build_questions(get_module(module_id)):
                    self.assertTrue(q["is_observation"], q["link_id"])

    def test_items_are_not_required(self) -> None:
        """A patient may decline an item; the call must still submit.

        A required question would make `handle_response` reject a partial
        check-in outright, losing everything the patient did answer.
        """
        for module_id in ("asthma", "depression"):
            with self.subTest(module=module_id):
                for q in build_questions(get_module(module_id)):
                    self.assertFalse(q["required"], q["link_id"])

    def test_slug_is_stable_and_namespaced(self) -> None:
        self.assertEqual(questionnaire_slug(get_module("asthma")), "careloop-asthma")
        self.assertEqual(
            questionnaire_slug(get_module("depression")), "careloop-depression"
        )


class TestQuestionIdStability(unittest.TestCase):
    """Question ids are derived, not generated. Re-registration must not change them."""

    def test_deterministic(self) -> None:
        module = get_module("asthma")
        first = [q["id"] for q in build_questions(module)]
        second = [q["id"] for q in build_questions(module)]
        self.assertEqual(first, second)

    def test_matches_uuid5_derivation(self) -> None:
        """Pins the derivation so the submit path can compute ids from code alone."""
        module = get_module("asthma")
        expected = str(uuid.uuid5(QUESTION_NAMESPACE, "asthma:act-1"))
        self.assertEqual(question_id(module, "act-1"), expected)

    def test_unique_within_and_across_modules(self) -> None:
        ids = [q["id"] for q in build_questions(get_module("asthma"))]
        ids += [q["id"] for q in build_questions(get_module("depression"))]
        self.assertEqual(len(ids), len(set(ids)))

    def test_module_scoped(self) -> None:
        """Two modules sharing a link id must not share a question id."""
        self.assertNotEqual(
            question_id(get_module("asthma"), "shared"),
            question_id(get_module("depression"), "shared"),
        )


if __name__ == "__main__":
    unittest.main()
