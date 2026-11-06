"""Serializers for the clinician review surface.

Shaped for the reviewer, not for the database. A clinician opening a draft needs
to answer one question — *should this go in the chart?* — so the payload leads
with the score, the findings and what the patient actually said, and carries the
transcript alongside it because the score is only trustworthy if you can see the
conversation it came from.
"""

from rest_framework import serializers

from care_careloop.models import CheckInDraft, DraftMedicationProposal


class DraftMedicationProposalSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(source="external_id", read_only=True)
    bound = serializers.SerializerMethodField()

    class Meta:
        model = DraftMedicationProposal
        fields = [
            "id",
            "display",
            "role",
            "sig",
            "route",
            "frequency",
            "prn",
            "duration_days",
            "quantity",
            "refills",
            "ingredients",
            "snomed_code",
            "snomed_display",
            "accepted",
            "bound",
            "medication_request_id",
        ]
        read_only_fields = ["medication_request_id"]

    def get_bound(self, obj) -> bool:
        """Whether a real product has been chosen.

        Surfaced explicitly because an accepted-but-unbound proposal is silently
        skipped at approval (C2), and the UI has to be able to say so before the
        clinician presses the button rather than after.
        """
        return bool(obj.snomed_code)


class DraftListSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(source="external_id", read_only=True)
    patient_id = serializers.UUIDField(source="patient.external_id", read_only=True)
    patient_name = serializers.CharField(source="patient.name", read_only=True)
    blocks_approval = serializers.BooleanField(read_only=True)
    has_critical = serializers.SerializerMethodField()
    call_status = serializers.CharField(source="call_attempt.status", read_only=True)

    class Meta:
        model = CheckInDraft
        fields = [
            "id",
            "patient_id",
            "patient_name",
            "module_id",
            "score_total",
            "band",
            "band_label",
            "crisis_override",
            "escalated",
            "status",
            "blocks_approval",
            "has_critical",
            "critical_acknowledged",
            "call_status",
            "created_date",
        ]

    def get_has_critical(self, obj) -> bool:
        return any(
            f.get("severity") == "critical"
            for f in [*obj.safety_findings, *obj.risk_findings]
        )


class DraftDetailSerializer(DraftListSerializer):
    medication_proposals = DraftMedicationProposalSerializer(many=True, read_only=True)
    transcript = serializers.JSONField(source="call_attempt.transcript", read_only=True)
    interaction_id = serializers.CharField(
        source="call_attempt.sarvam_interaction_id", read_only=True
    )
    agent_app_id = serializers.CharField(source="call_attempt.app_id", read_only=True)
    agent_app_version = serializers.IntegerField(
        source="call_attempt.app_version", read_only=True
    )
    reviewed_by_username = serializers.CharField(
        source="reviewed_by.username", read_only=True, default=None
    )

    class Meta(DraftListSerializer.Meta):
        fields = DraftListSerializer.Meta.fields + [
            "instrument_answers",
            "risk_answers",
            "concerns",
            "protocol_step_id",
            "follow_up_days",
            "safety_findings",
            "risk_findings",
            "medication_proposals",
            "transcript",
            "interaction_id",
            # Pinned per attempt so a reviewed call is traceable to the exact
            # agent definition that made it.
            "agent_app_id",
            "agent_app_version",
            "reviewed_by_username",
            "reviewed_at",
            "rejection_reason",
            "encounter",
            "questionnaire_response_id",
        ]
