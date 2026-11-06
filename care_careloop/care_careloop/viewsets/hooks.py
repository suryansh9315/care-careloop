"""Sarvam lifecycle hooks and the one mid-call tool.

All three authenticate the same way as the webhook — a per-call nonce — because
Sarvam has no CARE session and does not sign its requests (C8). Unlike the
webhook, the nonce is **not** consumed here: these fire before the call ends,
and `on_start` must still work if Sarvam retries it.

``on_start`` is the reason the call does not need a round-trip per question: it
returns the patient context *and the instrument wording* as agent variables,
once, before the agent speaks.

``raise_crisis_flag`` is the only mid-call tool in the system. A mid-call tool
costs a pause on the line, so it has to earn it — and a disclosure of suicidal
ideation is the one case where the server needs to know immediately rather than
when the webhook arrives minutes later.
"""

from __future__ import annotations

import logging

from django.utils import timezone
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from care_careloop.clinical import get_module
from care_careloop.models import CallAttempt
from care_careloop.services.agent_io import agent_input_variables
from care_careloop.services.context import load_patient_context

logger = logging.getLogger(__name__)


class _NonceAuthenticatedView(APIView):
    """Shared nonce lookup. No CARE auth; see the module docstring."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def _attempt(self, request) -> CallAttempt | None:
        nonce = request.query_params.get("n") or ""
        if not nonce:
            logger.warning("careloop.hook.missing_nonce path=%s", request.path)
            return None
        attempt = CallAttempt.objects.filter(webhook_nonce=nonce).first()
        if attempt is None:
            logger.warning("careloop.hook.unknown_nonce path=%s", request.path)
        return attempt


class OnStartView(_NonceAuthenticatedView):
    """Load the patient's context before the agent speaks."""

    def post(self, request, *args, **kwargs):
        attempt = self._attempt(request)
        if attempt is None:
            # An agent with no context must not read a stranger's chart, and
            # must not crash either: return nothing and let the prompt's
            # fallbacks handle an empty name.
            return Response({"variables": {}}, status=200)

        candidate = attempt.candidate
        module = get_module(candidate.campaign.module_id)
        context = load_patient_context(candidate.patient, module)
        variables = agent_input_variables(module, context)

        # on_start firing is the earliest reliable signal that a dial actually
        # happened, so the attempt budget is counted here rather than at request
        # time — a call Sarvam never placed should not burn an attempt.
        candidate.attempt_count = candidate.attempt_count + 1
        candidate.save(update_fields=["attempt_count", "modified_date"])

        logger.info(
            "careloop.hook.on_start attempt=%s module=%s variables=%s",
            attempt.external_id,
            module.id,
            len(variables),
        )
        return Response({"variables": variables})

    # Sarvam may issue the hook as GET while testing a tool from the builder.
    def get(self, request, *args, **kwargs):
        return self.post(request, *args, **kwargs)


class OnEndView(_NonceAuthenticatedView):
    """Note that the conversation finished.

    Deliberately thin. The post-call webhook carries the transcript and the
    final variables and is the authority; duplicating that work here would give
    two code paths that can disagree about one call.
    """

    def post(self, request, *args, **kwargs):
        attempt = self._attempt(request)
        if attempt is None:
            return Response({"detail": "ok"})

        attempt.meta = {**(attempt.meta or {}), "on_end_at": timezone.now().isoformat()}
        attempt.save(update_fields=["meta", "modified_date"])
        logger.info("careloop.hook.on_end attempt=%s", attempt.external_id)
        return Response({"detail": "ok"})


class RaiseCrisisFlagView(_NonceAuthenticatedView):
    """The one mid-call tool: the patient disclosed thoughts of self-harm.

    Recorded immediately rather than waiting for the webhook, and returned with
    the words the agent should say. The guidance is served from here, not held
    in the prompt, so it can be corrected without redeploying an agent version.
    """

    def post(self, request, *args, **kwargs):
        attempt = self._attempt(request)
        payload = request.data if isinstance(request.data, dict) else {}

        if attempt is not None:
            candidate = attempt.candidate
            module = get_module(candidate.campaign.module_id)
            attempt.meta = {
                **(attempt.meta or {}),
                "crisis": {
                    "flagged_at": timezone.now().isoformat(),
                    "quote": str(payload.get("quote") or "")[:500],
                    "module": module.id,
                },
            }
            attempt.save(update_fields=["meta", "modified_date"])
            logger.warning(
                "careloop.hook.crisis_flagged attempt=%s patient=%s",
                attempt.external_id,
                candidate.patient.external_id,
            )

        # Returned even when the nonce is unknown: if someone is disclosing
        # suicidal ideation on a live call, the agent must have something safe
        # to say regardless of our bookkeeping.
        return Response(
            {
                "acknowledged": True,
                "transfer_to_human": True,
                "say": (
                    "Thank you for telling me — that took courage, and I'm glad "
                    "you did. I'm going to stay on the line with you and connect "
                    "you to someone from the care team right now. You don't have "
                    "to answer any more questions."
                ),
                "instruction": (
                    "Stop the questionnaire. Do not ask any further items. Call "
                    "tool:transfer_to_human. Stay on the line until the transfer "
                    "completes."
                ),
            }
        )
