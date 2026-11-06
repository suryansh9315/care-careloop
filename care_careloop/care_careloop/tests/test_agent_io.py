"""The agent contract, tested without a call.

`parse_agent_output` sits on the boundary where a third-party voice platform's
output becomes clinical input, so it is treated as untrusted. These tests pin
the two properties that matter: nothing the agent sends can crash the pipeline,
and nothing it sends can be silently *lost* either — a dropped answer is a
missed safety finding.
"""

from __future__ import annotations

import unittest

from care_careloop.clinical import get_module
from care_careloop.services.agent_io import (
    CONCERNS_VARIABLE,
    CRISIS_VARIABLE,
    agent_input_variables,
    expected_output_variables,
    from_variable,
    parse_agent_output,
    to_variable,
)
from care_careloop.services.context import PatientContext


class TestVariableNaming(unittest.TestCase):
    def test_round_trips(self) -> None:
        for link_id in ("act-1", "phq9-9", "risk-reliever-canisters"):
            with self.subTest(link_id=link_id):
                self.assertEqual(from_variable(to_variable(link_id)), link_id)

    def test_identifier_safe(self) -> None:
        """Sarvam variable names must be identifier-safe."""
        for module_id in ("asthma", "depression"):
            for name in expected_output_variables(get_module(module_id)):
                with self.subTest(name=name):
                    self.assertTrue(name.isidentifier(), name)

    def test_declares_every_item_and_risk_question(self) -> None:
        for module_id in ("asthma", "depression"):
            with self.subTest(module=module_id):
                module = get_module(module_id)
                names = expected_output_variables(module)
                for item in module.instrument.items:
                    self.assertIn(to_variable(item.link_id), names)
                for question in module.risk_questions:
                    self.assertIn(to_variable(question.link_id), names)


class TestInputVariables(unittest.TestCase):
    def _context(self) -> PatientContext:
        return PatientContext(
            patient_id="p1",
            full_name="Asha Menon",
            first_name="Asha",
            phone="+910000000000",
            module_id="asthma",
            condition_display="Asthma",
            allergies=["budesonide"],
        )

    def test_ships_question_text_verbatim(self) -> None:
        """The wording must travel as data, so it stays in version control."""
        module = get_module("asthma")
        variables = agent_input_variables(module, self._context())
        for item in module.instrument.items:
            with self.subTest(item=item.link_id):
                self.assertEqual(
                    variables[f"question_{to_variable(item.link_id)}"], item.prompt
                )

    def test_ships_emergency_rules(self) -> None:
        """Emergency rules go into the instruction ahead of the flow."""
        variables = agent_input_variables(get_module("asthma"), self._context())
        self.assertIn("emergency", variables["emergency_rules"].lower())

    def test_carries_no_identifiers_beyond_the_first_name(self) -> None:
        """This crosses a trust boundary into a third-party platform.

        The agent needs a name to greet with and clinical context to avoid
        re-asking. It does not need the full name, an id, a phone number or an
        address, so none of those should appear.
        """
        variables = agent_input_variables(get_module("asthma"), self._context())
        blob = " ".join(variables.values())
        self.assertNotIn("Menon", blob, "surname leaked to the agent")
        self.assertNotIn("+910000000000", blob, "phone number leaked to the agent")
        self.assertNotIn("p1", variables.values(), "patient id leaked to the agent")


class TestParseAgentOutput(unittest.TestCase):
    def setUp(self) -> None:
        self.module = get_module("asthma")

    def test_digits(self) -> None:
        parsed = parse_agent_output(
            self.module, {"act_1": "5", "act_2": "2", "act_3": "3", "act_4": "2", "act_5": "2"}
        )
        self.assertEqual(
            parsed["item_answers"],
            {"act-1": 5.0, "act-2": 2.0, "act-3": 3.0, "act-4": 2.0, "act-5": 2.0},
        )

    def test_spoken_numbers_are_recovered(self) -> None:
        """"three" must not be discarded as unanswered.

        The agent is told to emit a digit, but it speaks to humans. Dropping a
        word-number would turn an answered item into a missing one and quietly
        change the score.
        """
        parsed = parse_agent_output(self.module, {"act_1": "three", "act_2": "two"})
        self.assertEqual(parsed["item_answers"], {"act-1": 3.0, "act-2": 2.0})

    def test_out_of_range_is_passed_through_not_rejected(self) -> None:
        """Clamping belongs in the clinical core, in one place."""
        parsed = parse_agent_output(self.module, {"act_1": "99"})
        self.assertEqual(parsed["item_answers"], {"act-1": 99.0})

    def test_missing_and_blank_items_are_omitted(self) -> None:
        parsed = parse_agent_output(
            self.module, {"act_1": "4", "act_2": "", "act_3": None}
        )
        self.assertEqual(parsed["item_answers"], {"act-1": 4.0})

    def test_unparseable_answer_is_omitted_not_zeroed(self) -> None:
        """Zero is a real answer on PHQ-9. "don't know" is not zero."""
        parsed = parse_agent_output(self.module, {"act_1": "I don't remember"})
        self.assertEqual(parsed["item_answers"], {})

    def test_risk_answers_keep_the_patient_words(self) -> None:
        """Risk rules parse these themselves; the raw words must survive."""
        parsed = parse_agent_output(
            self.module, {"risk_reliever_canisters": "about four canisters"}
        )
        self.assertEqual(
            parsed["risk_answers"], {"risk-reliever-canisters": "about four canisters"}
        )

    def test_unknown_variables_are_ignored(self) -> None:
        parsed = parse_agent_output(self.module, {"act_1": "4", "made_up": "x"})
        self.assertEqual(parsed["item_answers"], {"act-1": 4.0})

    def test_empty_and_none_payloads_are_safe(self) -> None:
        for payload in (None, {}):
            with self.subTest(payload=payload):
                parsed = parse_agent_output(self.module, payload)
                self.assertEqual(parsed["item_answers"], {})
                self.assertEqual(parsed["risk_answers"], {})
                self.assertEqual(parsed["concerns"], [])
                self.assertFalse(parsed["agent_flagged_crisis"])

    def test_concerns_split_on_pipe(self) -> None:
        parsed = parse_agent_output(
            self.module, {CONCERNS_VARIABLE: "breathless on stairs | inhaler runs out"}
        )
        self.assertEqual(
            parsed["concerns"], ["breathless on stairs", "inhaler runs out"]
        )

    def test_single_concern_is_not_split(self) -> None:
        parsed = parse_agent_output(self.module, {CONCERNS_VARIABLE: "just tired"})
        self.assertEqual(parsed["concerns"], ["just tired"])

    def test_concerns_accepts_a_list(self) -> None:
        parsed = parse_agent_output(self.module, {CONCERNS_VARIABLE: ["a", "b"]})
        self.assertEqual(parsed["concerns"], ["a", "b"])

    def test_crisis_flag_truthiness(self) -> None:
        for raw, expected in (
            ("true", True), ("True", True), ("yes", True), ("1", True),
            ("false", False), ("no", False), ("", False), (None, False),
        ):
            with self.subTest(raw=raw):
                parsed = parse_agent_output(self.module, {CRISIS_VARIABLE: raw})
                self.assertEqual(parsed["agent_flagged_crisis"], expected)

    def test_agent_crisis_flag_is_advisory_only(self) -> None:
        """The agent's flag is a cross-check, never the decision.

        Our own scoring of the crisis item is authoritative. An agent that
        forgets to set the flag must not be able to suppress the crisis pathway.
        """
        from care_careloop.clinical import InstrumentAnswer, score_instrument

        depression = get_module("depression")
        parsed = parse_agent_output(
            depression, {"phq9_9": "2", CRISIS_VARIABLE: "false"}
        )
        self.assertFalse(parsed["agent_flagged_crisis"])
        score = score_instrument(
            depression,
            [
                InstrumentAnswer(link_id=k, value=v)
                for k, v in parsed["item_answers"].items()
            ],
        )
        self.assertTrue(score.crisis_override, "our scoring must override the agent")
        self.assertEqual(score.band, "crisis")


if __name__ == "__main__":
    unittest.main()
