"""CareLoop's own domain models.

CARE has no `CarePlan`, `Task`, `Communication` or `Coverage` resource, so the
care-gap campaign, the call record and the un-approved plan are new domain
concepts and therefore belong to the plugin. They reference core by foreign key;
core never references them. No core migration is involved.

**The load-bearing design decision:** nothing here is written to the patient's
chart. A `CheckInDraft` and its proposed medications live only in these tables
until a clinician approves, at which point a single transaction creates the
`Encounter`, submits the questionnaire (which is what produces coded
`Observation`s — see C1/C13) and writes any `MedicationRequest`. This is
stronger than the previous Medplum design, which wrote `draft`-status resources
into the record itself.
"""

from django.conf import settings
from django.db import models

from care.emr.models.base import EMRBaseModel


class CampaignStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    ACTIVE = "active", "Active"
    PAUSED = "paused", "Paused"
    COMPLETED = "completed", "Completed"
    CANCELLED = "cancelled", "Cancelled"


class CandidateState(models.TextChoices):
    PENDING = "pending", "Pending"
    QUEUED = "queued", "Queued"
    CALLING = "calling", "Calling"
    REACHED = "reached", "Reached"
    UNREACHABLE = "unreachable", "Unreachable"
    EXCLUDED = "excluded", "Excluded"


class CallStatus(models.TextChoices):
    """Mirrors Sarvam's post-call webhook `status`, plus a pre-result state."""

    REQUESTED = "requested", "Requested"
    CONNECTED = "connected", "Connected"
    NO_ANSWER = "no_answer", "No answer"
    BUSY = "busy", "Busy"
    FAILED = "failed", "Failed"


class DraftStatus(models.TextChoices):
    PENDING_REVIEW = "pending_review", "Pending review"
    APPROVED = "approved", "Approved"
    REJECTED = "rejected", "Rejected"


class CareGapCampaign(EMRBaseModel):
    """A cohort of patients with the same open care gap, and how to call them.

    The Sarvam agent id and **committed version** are pinned here rather than
    read from settings at dial time: a campaign's calls must all be traceable to
    one agent definition, even if the workspace default moves on mid-campaign.
    """

    facility = models.ForeignKey(
        "facility.Facility",
        on_delete=models.CASCADE,
        related_name="careloop_campaigns",
    )
    name = models.CharField(max_length=255)
    module_id = models.CharField(
        max_length=64,
        help_text="Condition module slug, e.g. 'asthma' or 'depression'.",
    )
    gap_stale_days = models.PositiveIntegerField(
        default=180,
        help_text="How stale the last instrument result must be to count as a gap.",
    )
    status = models.CharField(
        max_length=16, choices=CampaignStatus.choices, default=CampaignStatus.DRAFT
    )

    sarvam_app_id = models.CharField(max_length=128, blank=True, default="")
    sarvam_app_version = models.PositiveIntegerField(default=0)
    sarvam_connection_id = models.CharField(max_length=128, blank=True, default="")
    agent_phone_number = models.CharField(max_length=20, blank=True, default="")

    notes = models.TextField(blank=True, default="")

    class Meta:
        verbose_name = "CareLoop campaign"
        verbose_name_plural = "CareLoop campaigns"
        indexes = [models.Index(fields=["facility", "status"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.module_id})"


class CareGapCandidate(EMRBaseModel):
    """One patient in a campaign, and why they are in it."""

    campaign = models.ForeignKey(
        CareGapCampaign, on_delete=models.CASCADE, related_name="candidates"
    )
    patient = models.ForeignKey(
        "emr.Patient", on_delete=models.CASCADE, related_name="careloop_candidacies"
    )
    gap_reason = models.TextField(
        help_text="Why this patient has an open gap, in reviewable prose."
    )
    priority = models.IntegerField(
        default=0, help_text="Higher dials first. Derived, not hand-set."
    )
    state = models.CharField(
        max_length=16, choices=CandidateState.choices, default=CandidateState.PENDING
    )
    attempt_count = models.PositiveSmallIntegerField(default=0)
    excluded_reason = models.TextField(
        blank=True,
        default="",
        help_text="Set when the patient is skipped — no consent, no phone, on the DND list.",
    )

    class Meta:
        verbose_name = "CareLoop candidate"
        verbose_name_plural = "CareLoop candidates"
        constraints = [
            models.UniqueConstraint(
                fields=["campaign", "patient"],
                condition=models.Q(deleted=False),
                name="careloop_unique_patient_per_campaign",
            )
        ]
        indexes = [models.Index(fields=["campaign", "state", "-priority"])]

    def __str__(self) -> str:
        return f"candidate {self.external_id} ({self.state})"


class CallAttempt(EMRBaseModel):
    """One outbound call, and everything Sarvam told us about it.

    ``webhook_nonce`` is the security mechanism for the post-call webhook.
    Sarvam does **not** sign its webhooks (constraint C8), so each attempt mints
    a single-use, unguessable nonce which is embedded in the webhook URL and
    metadata, then matched here alongside the attempt id. ``nonce_consumed_at``
    makes replay visible.

    ``app_id`` and ``app_version`` are stored per attempt, not just per campaign,
    so a reviewed call is always traceable to the exact agent definition that
    made it.
    """

    candidate = models.ForeignKey(
        CareGapCandidate, on_delete=models.CASCADE, related_name="call_attempts"
    )

    sarvam_attempt_id = models.CharField(
        max_length=128, blank=True, default="", db_index=True
    )
    sarvam_interaction_id = models.CharField(max_length=128, blank=True, default="")
    webhook_nonce = models.CharField(max_length=64, unique=True, db_index=True)
    nonce_consumed_at = models.DateTimeField(null=True, blank=True)

    status = models.CharField(
        max_length=16, choices=CallStatus.choices, default=CallStatus.REQUESTED
    )
    duration_seconds = models.FloatField(null=True, blank=True)
    failure_reason = models.TextField(blank=True, default="")

    #: Sarvam's `interaction_transcript`: a list of {role, en_text} turns.
    transcript = models.JSONField(default=list, blank=True)
    #: Sarvam's `final_agent_variables`: the agent's declared output variables.
    final_agent_variables = models.JSONField(default=dict, blank=True)

    app_id = models.CharField(max_length=128, blank=True, default="")
    app_version = models.PositiveIntegerField(default=0)

    requested_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "CareLoop call attempt"
        verbose_name_plural = "CareLoop call attempts"
        indexes = [models.Index(fields=["candidate", "-requested_at"])]

    def __str__(self) -> str:
        return f"call {self.sarvam_attempt_id or self.external_id} ({self.status})"


class CheckInDraft(EMRBaseModel):
    """The un-approved plan produced from a call. Not in the chart.

    ``facility`` is denormalised from the campaign so the review queue can be
    permission-filtered without joining through three tables on every request.
    """

    call_attempt = models.OneToOneField(
        CallAttempt, on_delete=models.CASCADE, related_name="draft"
    )
    patient = models.ForeignKey(
        "emr.Patient", on_delete=models.CASCADE, related_name="careloop_drafts"
    )
    facility = models.ForeignKey(
        "facility.Facility", on_delete=models.CASCADE, related_name="careloop_drafts"
    )
    module_id = models.CharField(max_length=64)

    #: As collected. Lists of {link_id, value}.
    instrument_answers = models.JSONField(default=list, blank=True)
    risk_answers = models.JSONField(default=list, blank=True)
    #: What the patient raised unprompted, in their own words.
    concerns = models.JSONField(default=list, blank=True)

    score_total = models.IntegerField()
    band = models.CharField(max_length=64)
    band_label = models.CharField(max_length=128)
    crisis_override = models.BooleanField(default=False)
    protocol_step_id = models.CharField(max_length=64)
    follow_up_days = models.PositiveIntegerField()

    safety_findings = models.JSONField(default=list, blank=True)
    risk_findings = models.JSONField(default=list, blank=True)
    escalated = models.BooleanField(default=False)

    critical_acknowledged = models.BooleanField(
        default=False,
        help_text=(
            "A critical safety finding blocks approval until a clinician "
            "explicitly acknowledges it."
        ),
    )

    status = models.CharField(
        max_length=16, choices=DraftStatus.choices, default=DraftStatus.PENDING_REVIEW
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="careloop_reviewed_drafts",
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    rejection_reason = models.TextField(blank=True, default="")

    #: Written only on approval. The encounter is a hard prerequisite for coded
    #: observations (constraint C13), so it does not exist before then.
    encounter = models.ForeignKey(
        "emr.Encounter",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="careloop_drafts",
    )
    questionnaire_response_id = models.UUIDField(null=True, blank=True)

    class Meta:
        verbose_name = "CareLoop check-in draft"
        verbose_name_plural = "CareLoop check-in drafts"
        indexes = [
            models.Index(fields=["facility", "status", "-created_date"]),
            models.Index(fields=["patient", "-created_date"]),
        ]

    def __str__(self) -> str:
        return f"draft {self.external_id} ({self.module_id} {self.band}, {self.status})"

    @property
    def blocks_approval(self) -> bool:
        """True when an unacknowledged critical finding gates approval."""
        has_critical = any(
            f.get("severity") == "critical"
            for f in [*self.safety_findings, *self.risk_findings]
        )
        return has_critical and not self.critical_acknowledged


class DraftMedicationProposal(EMRBaseModel):
    """A proposed therapy, held outside the chart until approval.

    CARE binds medications to **SNOMED CT**, not the RxNorm the protocol steps
    carry (constraint C2). So the protocol proposes a *therapeutic step* and the
    clinician binds the actual product at review, through CARE's own medication
    ValueSet search. ``snomed_code`` stays null until they do.
    """

    draft = models.ForeignKey(
        CheckInDraft, on_delete=models.CASCADE, related_name="medication_proposals"
    )

    display = models.CharField(
        max_length=255, help_text="The therapeutic step as drafted, for the clinician to read."
    )
    role = models.CharField(max_length=32)
    sig = models.TextField()
    route = models.CharField(max_length=64)
    frequency = models.CharField(max_length=64)
    prn = models.BooleanField(default=False)
    duration_days = models.PositiveIntegerField(null=True, blank=True)
    quantity = models.FloatField(null=True, blank=True)
    refills = models.PositiveSmallIntegerField(null=True, blank=True)
    ingredients = models.JSONField(default=list, blank=True)

    #: Bound by the clinician at review time from CARE's medication ValueSet.
    snomed_code = models.CharField(max_length=32, blank=True, default="")
    snomed_display = models.CharField(max_length=255, blank=True, default="")

    accepted = models.BooleanField(
        default=False, help_text="Whether the clinician kept this proposal at review."
    )
    #: Set on approval, once the MedicationRequest exists in CARE.
    medication_request_id = models.UUIDField(null=True, blank=True)

    class Meta:
        verbose_name = "CareLoop medication proposal"
        verbose_name_plural = "CareLoop medication proposals"

    def __str__(self) -> str:
        return f"{self.display} ({'accepted' if self.accepted else 'proposed'})"
