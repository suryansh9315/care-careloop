"""Start a check-in call for one patient.

This mirrors the previous implementation's trigger — `POST /call {patientId}`,
one patient, on demand — rather than introducing cohort sweeps and scheduling.
A clinician decides who gets called.

The `CareGapCampaign` row still exists because a `CallAttempt` hangs off a
candidate which hangs off a campaign, and that chain is what makes a call
traceable. For on-demand calls a single per-facility, per-module campaign is
reused rather than invented each time, so the model stays intact without
inventing campaign UX nobody asked for.
"""

from __future__ import annotations

import logging
import secrets

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from care.emr.models.patient import Patient
from care.facility.models.facility import Facility
from care.security.authorization import AuthorizationController

from care_careloop.clinical import ModuleValidationError, get_module
from care_careloop.integrations.sarvam import (
    SarvamCallFailed,
    SarvamNotConfigured,
    place_call,
)
from care_careloop.models import (
    CallAttempt,
    CallStatus,
    CampaignStatus,
    CandidateState,
    CareGapCampaign,
    CareGapCandidate,
)
from care_careloop.services.agent_io import agent_input_variables
from care_careloop.services.context import has_open_care_gap, load_patient_context
from care_careloop.settings import plugin_settings

logger = logging.getLogger(__name__)

ON_DEMAND_CAMPAIGN_NAME = "On-demand check-ins"


def _on_demand_campaign(facility: Facility, module_id: str) -> CareGapCampaign:
    campaign, _ = CareGapCampaign.objects.get_or_create(
        facility=facility,
        module_id=module_id,
        name=ON_DEMAND_CAMPAIGN_NAME,
        defaults={
            "status": CampaignStatus.ACTIVE,
            "gap_stale_days": plugin_settings.CARELOOP_GAP_STALE_DAYS,
            "sarvam_app_id": plugin_settings.CARELOOP_SARVAM_APP_ID,
            "sarvam_app_version": plugin_settings.CARELOOP_SARVAM_APP_VERSION,
            "sarvam_connection_id": plugin_settings.CARELOOP_SARVAM_CONNECTION_ID,
            "agent_phone_number": plugin_settings.CARELOOP_SARVAM_AGENT_PHONE_NUMBER,
            "notes": (
                "Auto-created to hold calls a clinician started from a patient's "
                "page. Not a scheduled campaign."
            ),
        },
    )
    return campaign


class StartCallView(APIView):
    """``POST /api/care_careloop/calls/`` — dial one patient now."""

    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        facility_id = request.data.get("facility")
        patient_id = request.data.get("patient")
        module_id = request.data.get("module_id")
        if not (facility_id and patient_id and module_id):
            raise ValidationError(
                {"detail": "facility, patient and module_id are all required."}
            )

        facility = get_object_or_404(Facility, external_id=facility_id)
        if not AuthorizationController.call(
            "can_run_careloop_campaign", request.user, facility
        ):
            raise PermissionDenied(
                "You cannot start CareLoop calls at this facility."
            )

        patient = get_object_or_404(Patient, external_id=patient_id)
        try:
            module = get_module(module_id)
        except ModuleValidationError as exc:
            raise ValidationError({"module_id": str(exc)}) from exc

        # The phone number comes from the record, never from the request body.
        # Letting a caller supply the destination would turn this endpoint into
        # a way to make CARE dial arbitrary numbers.
        phone = (patient.phone_number or "").strip()
        if not phone:
            raise ValidationError(
                {"detail": "This patient has no phone number on file."}
            )

        campaign = _on_demand_campaign(facility, module.id)
        gap_open, gap_reason = has_open_care_gap(
            patient, module, campaign.gap_stale_days
        )

        with transaction.atomic():
            candidate, _ = CareGapCandidate.objects.get_or_create(
                campaign=campaign,
                patient=patient,
                defaults={"gap_reason": gap_reason},
            )
            if candidate.attempt_count >= plugin_settings.CARELOOP_MAX_CALL_ATTEMPTS:
                raise ValidationError(
                    {
                        "detail": (
                            f"This patient has already been called "
                            f"{candidate.attempt_count} times for "
                            f"{module.display}. Reset the candidate to call again."
                        )
                    }
                )
            candidate.state = CandidateState.QUEUED
            candidate.save(update_fields=["state", "modified_date"])

            attempt = CallAttempt.objects.create(
                candidate=candidate,
                # 32 bytes of urlsafe entropy. This is the only thing standing
                # between an unsigned webhook and a forged payload (C8), so it
                # is generated with `secrets`, never a uuid4 hex.
                webhook_nonce=secrets.token_urlsafe(32),
                status=CallStatus.REQUESTED,
                app_id=campaign.sarvam_app_id,
                app_version=campaign.sarvam_app_version,
            )

        # Context is loaded here as well as in on_start: Sarvam's agent_variables
        # are available from the first spoken word, where the on_start hook can
        # land a moment later. Both derive from the same function, so they agree.
        context = load_patient_context(patient, module)
        variables = agent_input_variables(module, context)

        try:
            attempt_id = place_call(
                phone_number=phone,
                nonce=attempt.webhook_nonce,
                agent_variables=variables,
                app_id=campaign.sarvam_app_id,
                app_version=campaign.sarvam_app_version,
                connection_id=campaign.sarvam_connection_id,
                agent_phone_number=campaign.agent_phone_number,
            )
        except SarvamNotConfigured as exc:
            # The attempt row stays, marked failed: an operator should be able
            # to see that someone tried to call and why it did not happen.
            attempt.status = CallStatus.FAILED
            attempt.failure_reason = str(exc)
            attempt.save(update_fields=["status", "failure_reason", "modified_date"])
            return Response(
                {"detail": str(exc), "code": "sarvam_not_configured"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except SarvamCallFailed as exc:
            attempt.status = CallStatus.FAILED
            attempt.failure_reason = str(exc)
            attempt.save(update_fields=["status", "failure_reason", "modified_date"])
            return Response(
                {"detail": str(exc), "code": "sarvam_call_failed"},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        attempt.sarvam_attempt_id = attempt_id
        attempt.save(update_fields=["sarvam_attempt_id", "modified_date"])
        candidate.state = CandidateState.CALLING
        candidate.save(update_fields=["state", "modified_date"])

        logger.info(
            "careloop.call.started attempt=%s patient=%s module=%s",
            attempt.external_id,
            patient.external_id,
            module.id,
        )

        return Response(
            {
                "attempt": str(attempt.external_id),
                "sarvam_attempt_id": attempt_id,
                "module_id": module.id,
                "gap_open": gap_open,
                "gap_reason": gap_reason,
                "attempt_count": candidate.attempt_count,
            },
            status=status.HTTP_202_ACCEPTED,
        )
