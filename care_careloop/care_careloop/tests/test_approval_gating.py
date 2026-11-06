"""The approval gate, tested without a database.

`CheckInDraft.blocks_approval` is the safety-critical predicate in the whole
plugin: it is what stops a plan with an unacknowledged critical finding from
reaching the chart. Model properties can be exercised on unsaved instances, so
this runs as plain `unittest` with no fixtures — which means it is fast enough
to never be skipped.

The full transaction (encounter, observations, medication requests, note, status)
is verified end to end against the running workspace; see `docs/REVAMP-PLAN.md`
§8 Phase 5 for that output.
"""

from __future__ import annotations

import unittest

from care_careloop.models import CheckInDraft
from care_careloop.services.approval import _item_answers, _note_body

CRITICAL = {"severity": "critical", "code": "reliever-overuse", "message": "m"}
WARNING = {"severity": "warning", "code": "uncontrolled-score", "message": "m"}
INFO = {"severity": "info", "code": "note", "message": "m"}


def _draft(**kwargs) -> CheckInDraft:
    """An unsaved draft with the fields the gate reads."""
    defaults = dict(
        module_id="asthma",
        instrument_answers=[],
        risk_answers=[],
        concerns=[],
        score_total=14,
        band="poor",
        band_label="Poorly controlled",
        crisis_override=False,
        protocol_step_id="poor",
        follow_up_days=21,
        safety_findings=[],
        risk_findings=[],
        escalated=False,
        critical_acknowledged=False,
    )
    defaults.update(kwargs)
    return CheckInDraft(**defaults)


class TestBlocksApproval(unittest.TestCase):
    def test_clean_draft_does_not_block(self) -> None:
        self.assertFalse(_draft().blocks_approval)

    def test_warnings_and_info_do_not_block(self) -> None:
        """Warnings are a clinician's call, not a gate."""
        self.assertFalse(
            _draft(safety_findings=[WARNING, INFO], risk_findings=[WARNING]).blocks_approval
        )

    def test_critical_safety_finding_blocks(self) -> None:
        self.assertTrue(_draft(safety_findings=[CRITICAL]).blocks_approval)

    def test_critical_risk_finding_blocks(self) -> None:
        """A critical *risk* finding gates too, not just an allergy match."""
        self.assertTrue(_draft(risk_findings=[CRITICAL]).blocks_approval)

    def test_acknowledgement_releases_the_gate(self) -> None:
        self.assertFalse(
            _draft(safety_findings=[CRITICAL], critical_acknowledged=True).blocks_approval
        )

    def test_acknowledgement_without_a_critical_finding_is_harmless(self) -> None:
        self.assertFalse(_draft(critical_acknowledged=True).blocks_approval)

    def test_mixed_severities_still_block(self) -> None:
        self.assertTrue(
            _draft(
                safety_findings=[INFO, WARNING],
                risk_findings=[WARNING, CRITICAL, INFO],
            ).blocks_approval
        )

    def test_malformed_finding_does_not_crash_the_gate(self) -> None:
        """A finding missing `severity` must not throw — it just is not critical.

        The gate running at all matters more than it being clever: an exception
        here would turn a review into a 500 rather than a decision.
        """
        self.assertFalse(_draft(safety_findings=[{}, {"code": "x"}]).blocks_approval)


class TestItemAnswers(unittest.TestCase):
    def test_extracts_link_id_to_int(self) -> None:
        draft = _draft(
            instrument_answers=[
                {"link_id": "act-1", "value": 5.0},
                {"link_id": "act-2", "value": 2.0},
            ]
        )
        self.assertEqual(_item_answers(draft), {"act-1": 5, "act-2": 2})

    def test_skips_null_values(self) -> None:
        """A declined item is absent, not zero — zero is a real ACT answer."""
        draft = _draft(
            instrument_answers=[
                {"link_id": "act-1", "value": 3.0},
                {"link_id": "act-2", "value": None},
            ]
        )
        self.assertEqual(_item_answers(draft), {"act-1": 3})


class TestNoteBody(unittest.TestCase):
    def test_states_score_and_band(self) -> None:
        body = _note_body(_draft())
        self.assertIn("Asthma Control Test (ACT)", body)
        self.assertIn("14", body)
        self.assertIn("Poorly controlled", body)

    def test_discloses_automated_collection(self) -> None:
        """The note must say a machine collected the answers.

        A clinical note that reads as if a person took the history would
        misrepresent how the data was gathered.
        """
        body = _note_body(_draft())
        self.assertIn("automated voice agent", body)

    def test_crisis_override_is_called_out(self) -> None:
        body = _note_body(_draft(module_id="depression", crisis_override=True, band="crisis"))
        self.assertIn("Crisis pathway", body)

    def test_patient_concerns_are_quoted_verbatim(self) -> None:
        body = _note_body(_draft(concerns=["I get breathless on the stairs"]))
        self.assertIn('"I get breathless on the stairs"', body)

    def test_findings_appear_with_severity(self) -> None:
        body = _note_body(_draft(risk_findings=[CRITICAL]))
        self.assertIn("[critical]", body)


if __name__ == "__main__":
    unittest.main()
