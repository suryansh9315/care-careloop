"""The clinician review surface.

Authorization is **facility-scoped on every action**, and derived from CARE's
own authorization controller rather than re-implemented here. Listing requires
an explicit ``?facility=`` so a reviewer is always looking at one facility's
queue on purpose; a draft's own facility is what authorizes reading or approving
it.

Viewing and approving are separate permissions. Seeing a queue and signing a
plan into a patient's chart are different privileges, so
``can_approve_careloop_draft`` is checked independently of
``can_view_careloop_draft`` and is granted to fewer roles.
"""

from __future__ import annotations

from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet
from rest_framework.mixins import ListModelMixin, RetrieveModelMixin

from care.emr.models.patient import Patient
from care.facility.models.facility import Facility
from care.security.authorization import AuthorizationController

from care_careloop.models import CheckInDraft, DraftMedicationProposal, DraftStatus
from care_careloop.serializers.review import (
    DraftDetailSerializer,
    DraftListSerializer,
    DraftMedicationProposalSerializer,
)
from care_careloop.services.approval import (
    ApprovalBlocked,
    ApprovalError,
    ApprovalStateError,
    approve_draft,
    reject_draft,
)


class CheckInDraftViewSet(ListModelMixin, RetrieveModelMixin, GenericViewSet):
    """Read the review queue; approve or reject a draft."""

    permission_classes = [IsAuthenticated]
    lookup_field = "external_id"
    queryset = CheckInDraft.objects.none()  # replaced by get_queryset

    def get_serializer_class(self):
        return DraftListSerializer if self.action == "list" else DraftDetailSerializer

    # -- authorization ----------------------------------------------------

    def _authorize_view(self, facility: Facility) -> None:
        if not AuthorizationController.call(
            "can_view_careloop_draft", self.request.user, facility
        ):
            raise PermissionDenied("You cannot view CareLoop drafts at this facility.")

    def _authorize_approve(self, facility: Facility) -> None:
        if not AuthorizationController.call(
            "can_approve_careloop_draft", self.request.user, facility
        ):
            raise PermissionDenied(
                "You cannot approve CareLoop drafts at this facility."
            )

    def get_queryset(self):
        base = (
            CheckInDraft.objects.all()
            .select_related("patient", "facility", "call_attempt", "reviewed_by")
            .prefetch_related("medication_proposals")
            .order_by("-created_date")
        )

        if self.action != "list":
            # Retrieve and the detail actions authorize against the object's own
            # facility, so the queryset stays unfiltered and `get_object` is
            # what enforces access.
            return base

        facility_id = self.request.query_params.get("facility")
        if not facility_id:
            raise ValidationError(
                {"facility": "A facility is required to list the review queue."}
            )
        facility = get_object_or_404(Facility, external_id=facility_id)
        self._authorize_view(facility)

        queryset = base.filter(facility=facility)

        draft_status = self.request.query_params.get("status")
        if draft_status:
            queryset = queryset.filter(status=draft_status)
        patient_id = self.request.query_params.get("patient")
        if patient_id:
            patient = get_object_or_404(Patient, external_id=patient_id)
            queryset = queryset.filter(patient=patient)
        return queryset

    def get_object(self) -> CheckInDraft:
        draft = get_object_or_404(
            self.get_queryset(), external_id=self.kwargs["external_id"]
        )
        self._authorize_view(draft.facility)
        return draft

    # -- actions ----------------------------------------------------------

    @action(detail=True, methods=["POST"])
    def acknowledge_critical(self, request, *args, **kwargs):
        """Record that a clinician has seen the critical finding.

        Separate from approval on purpose: acknowledging and approving are two
        decisions, and collapsing them into one button would make the
        acknowledgement meaningless.
        """
        draft = self.get_object()
        self._authorize_approve(draft.facility)
        if draft.status != DraftStatus.PENDING_REVIEW:
            raise ValidationError({"detail": f"Draft is {draft.status}."})

        draft.critical_acknowledged = True
        draft.save(update_fields=["critical_acknowledged", "modified_date"])
        return Response(self.get_serializer(draft).data)

    @action(detail=True, methods=["PATCH"], url_path=r"proposals/(?P<proposal_id>[^/.]+)")
    def update_proposal(self, request, proposal_id=None, *args, **kwargs):
        """Accept a proposal and bind it to a real product.

        The protocol proposes a therapeutic step; CARE binds medications to
        SNOMED CT, not the RxNorm the protocol carries (C2), so the clinician
        chooses the product here from CARE's own medication ValueSet. An
        accepted proposal with no bound product is skipped at approval, and the
        serializer exposes `bound` so the UI can say that in advance.
        """
        draft = self.get_object()
        self._authorize_approve(draft.facility)
        if draft.status != DraftStatus.PENDING_REVIEW:
            raise ValidationError({"detail": f"Draft is {draft.status}."})

        proposal = get_object_or_404(
            DraftMedicationProposal.objects.filter(draft=draft),
            external_id=proposal_id,
        )

        if "accepted" in request.data:
            proposal.accepted = bool(request.data["accepted"])
        if "snomed_code" in request.data:
            code = str(request.data.get("snomed_code") or "").strip()
            display = str(request.data.get("snomed_display") or "").strip()
            if code and not display:
                raise ValidationError(
                    {"snomed_display": "A display name is required with a code."}
                )
            proposal.snomed_code = code
            proposal.snomed_display = display
        proposal.save(
            update_fields=["accepted", "snomed_code", "snomed_display", "modified_date"]
        )
        return Response(DraftMedicationProposalSerializer(proposal).data)

    @action(detail=True, methods=["POST"])
    def approve(self, request, *args, **kwargs):
        """Write the draft to the chart. All of it, or none of it."""
        draft = self.get_object()
        self._authorize_approve(draft.facility)

        try:
            result = approve_draft(
                draft,
                request.user,
                acknowledge_critical=bool(request.data.get("acknowledge_critical")),
            )
        except ApprovalBlocked as exc:
            # 409, not 400: the request is well-formed, the draft's state refuses
            # it. The UI needs to tell them to acknowledge, not to fix input.
            return Response(
                {"detail": str(exc), "code": "critical_not_acknowledged"},
                status=status.HTTP_409_CONFLICT,
            )
        except ApprovalStateError as exc:
            return Response(
                {"detail": str(exc), "code": "invalid_state"},
                status=status.HTTP_409_CONFLICT,
            )
        except ApprovalError as exc:
            raise ValidationError({"detail": str(exc)}) from exc

        draft.refresh_from_db()
        return Response({**self.get_serializer(draft).data, "written": result})

    @action(detail=True, methods=["POST"])
    def reject(self, request, *args, **kwargs):
        """Reject a draft. Writes nothing to the chart."""
        draft = self.get_object()
        self._authorize_approve(draft.facility)

        reason = str(request.data.get("reason") or "")
        try:
            reject_draft(draft, request.user, reason)
        except ApprovalStateError as exc:
            return Response(
                {"detail": str(exc), "code": "invalid_state"},
                status=status.HTTP_409_CONFLICT,
            )
        except ApprovalError as exc:
            raise ValidationError({"reason": str(exc)}) from exc

        draft.refresh_from_db()
        return Response(self.get_serializer(draft).data)
