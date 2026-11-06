"""Sarvam's post-call webhook.

**Sarvam does not sign its webhooks.** The documented payload carries
``attempt_id``, ``status``, ``channel_info``, ``duration``, ``interaction_id``,
``failure_reason``, ``final_agent_variables``, ``interaction_transcript`` and an
echoed ``webhook_config`` — and no signature header of any kind (constraint C8).

So authentication is a **per-call single-use nonce**: each `CallAttempt` mints an
unguessable nonce, the dial embeds it in the webhook URL, and this view matches
it against the stored attempt. That gives capability-style auth scoped to one
call, which is the best available given an unsigned sender.

The three rules that keep a webhook endpoint healthy, all deliberate here:

* ``authentication_classes = []`` — leaving DRF's default on makes it reject the
  request before the nonce check ever runs.
* **200 for anything unrecognised.** A 404 or 500 makes providers retry, and
  most back off exponentially into a retry storm. "Ignored" is a success.
* **Idempotent.** Delivery is at-least-once and can be out of order, so a second
  delivery must change nothing rather than build a second draft.
"""

from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from care_careloop.models import CallAttempt, CallStatus, CandidateState
from care_careloop.settings import plugin_settings
from care_careloop.services.agent_io import parse_agent_output
from care_careloop.services.draft import build_draft

logger = logging.getLogger(__name__)

#: Sarvam's documented `status` values.
_TERMINAL_STATUSES = {
    "connected": CallStatus.CONNECTED,
    "no_answer": CallStatus.NO_ANSWER,
    "busy": CallStatus.BUSY,
    "failed": CallStatus.FAILED,
}

#: Returned for every outcome, including the ignored ones. See the docstring.
_OK = {"detail": "ok"}


class SarvamWebhookView(APIView):
    """Receive one call attempt's outcome.

    Not protected by the CARE JWT — Sarvam has no CARE session. See the module
    docstring for what replaces it.
    """

    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        nonce = request.query_params.get("n") or ""
        payload = request.data if isinstance(request.data, dict) else {}
        attempt_id = str(payload.get("attempt_id") or "").strip()

        if not nonce:
            logger.warning("careloop.webhook.missing_nonce")
            return Response(_OK)

        attempt = CallAttempt.objects.filter(webhook_nonce=nonce).first()
        if attempt is None:
            # Unknown nonce. Do not distinguish "wrong" from "expired" in the
            # response: a probe should learn nothing from the status code.
            logger.warning("careloop.webhook.unknown_nonce")
            return Response(_OK)

        # The nonce identifies the call; attempt_id must agree with it. A
        # mismatch means a replayed or crossed payload, not a new call.
        if attempt_id and attempt.sarvam_attempt_id and attempt_id != attempt.sarvam_attempt_id:
            logger.warning(
                "careloop.webhook.attempt_id_mismatch attempt=%s", attempt.external_id
            )
            return Response(_OK)

        if attempt.nonce_consumed_at is not None:
            logger.info(
                "careloop.webhook.replay_ignored attempt=%s", attempt.external_id
            )
            return Response(_OK)

        try:
            self._record(attempt, payload, attempt_id)
        except Exception:
            # A bug in our own pipeline must not make Sarvam retry a call that
            # already happened; the attempt row is on the record either way and
            # the failure is in the log.
            logger.exception(
                "careloop.webhook.processing_failed attempt=%s", attempt.external_id
            )

        return Response(_OK)

    @transaction.atomic
    def _record(self, attempt: CallAttempt, payload: dict, attempt_id: str) -> None:
        status = str(payload.get("status") or "").strip().lower()
        attempt.status = _TERMINAL_STATUSES.get(status, CallStatus.FAILED)
        if attempt_id:
            attempt.sarvam_attempt_id = attempt_id
        attempt.sarvam_interaction_id = str(payload.get("interaction_id") or "")
        attempt.failure_reason = str(payload.get("failure_reason") or "")
        duration = payload.get("duration")
        attempt.duration_seconds = float(duration) if duration is not None else None
        transcript = payload.get("interaction_transcript")
        attempt.transcript = transcript if isinstance(transcript, list) else []
        variables = payload.get("final_agent_variables")
        attempt.final_agent_variables = variables if isinstance(variables, dict) else {}
        # Consume the nonce in the same transaction as the state change, so a
        # concurrent redelivery cannot both pass the replay check.
        attempt.nonce_consumed_at = timezone.now()
        attempt.completed_at = timezone.now()
        attempt.save(
            update_fields=[
                "status",
                "sarvam_attempt_id",
                "sarvam_interaction_id",
                "failure_reason",
                "duration_seconds",
                "transcript",
                "final_agent_variables",
                "nonce_consumed_at",
                "completed_at",
                "modified_date",
            ]
        )

        candidate = attempt.candidate
        if attempt.status != CallStatus.CONNECTED:
            # Not reached is not the same as not reachable. Return the candidate
            # to the queue while the attempt budget allows another try, and only
            # give up once it is spent — otherwise one busy signal would drop a
            # patient out of the campaign permanently.
            budget = plugin_settings.CARELOOP_MAX_CALL_ATTEMPTS
            exhausted = candidate.attempt_count >= budget
            candidate.state = (
                CandidateState.UNREACHABLE if exhausted else CandidateState.PENDING
            )
            candidate.save(update_fields=["state", "modified_date"])
            logger.info(
                "careloop.webhook.not_connected attempt=%s status=%s attempts=%s/%s",
                attempt.external_id,
                attempt.status,
                candidate.attempt_count,
                budget,
            )
            return

        candidate.state = CandidateState.REACHED
        candidate.save(update_fields=["state", "modified_date"])

        from care_careloop.clinical import get_module

        module = get_module(candidate.campaign.module_id)
        parsed = parse_agent_output(module, attempt.final_agent_variables)

        if not parsed["item_answers"]:
            # Connected but nothing scoreable: a voicemail, a wrong number, or
            # an immediate hang-up. The attempt and transcript stay on the
            # record; there is nothing to draft.
            logger.info(
                "careloop.webhook.no_answers attempt=%s", attempt.external_id
            )
            return

        draft = build_draft(
            attempt,
            item_answers=parsed["item_answers"],
            risk_answers=parsed["risk_answers"],
            concerns=parsed["concerns"],
        )
        logger.info(
            "careloop.webhook.draft_created attempt=%s draft=%s band=%s",
            attempt.external_id,
            draft.external_id,
            draft.band,
        )
