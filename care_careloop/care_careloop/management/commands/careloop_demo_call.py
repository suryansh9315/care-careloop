"""Drive a synthetic Sarvam call through the real pipeline. No phone needed.

This is not a mock of the pipeline — it posts a payload shaped exactly like
Sarvam's documented post-call webhook at the real webhook view, so the nonce
check, the variable parsing, the clinical core, the safety screen and the draft
build all run as they would on a live call. The only thing missing is the
telephony.

Worth having beyond demos: it is how the webhook's parsing and idempotency get
exercised without spending a call, and it is the fallback if a tunnel or a
telephony account is unavailable when it matters.

    manage.py careloop_demo_call --module asthma --scenario poor
    manage.py careloop_demo_call --module depression --scenario crisis
"""

import datetime
import uuid

from django.core.management.base import BaseCommand, CommandError
from django.test import Client
from django.utils import timezone

from care.emr.models.organization import Organization
from care.emr.models.patient import Patient
from care.facility.models.facility import Facility

from care_careloop.clinical import get_module
from care_careloop.models import (
    CallAttempt,
    CallStatus,
    CareGapCampaign,
    CareGapCandidate,
)
from care_careloop.services.agent_io import (
    CONCERNS_VARIABLE,
    CRISIS_VARIABLE,
    DISPOSITION_VARIABLE,
    to_variable,
)

WEBHOOK_PATH = "/api/care_careloop/sarvam/webhook/"

#: Answer vectors chosen to land in a specific band, plus the risk answers that
#: make each scenario clinically interesting.
SCENARIOS = {
    "asthma": {
        "controlled": ({"act-1": 5, "act-2": 5, "act-3": 4, "act-4": 4, "act-5": 4}, {}),
        "poor": (
            {"act-1": 3, "act-2": 2, "act-3": 3, "act-4": 2, "act-5": 3},
            {"risk-exacerbations": "twice", "risk-reliever-canisters": "about four canisters"},
        ),
        "very-poor": (
            {"act-1": 1, "act-2": 1, "act-3": 1, "act-4": 1, "act-5": 1},
            {"risk-hospitalisation": "yes", "risk-reliever-canisters": "loads of them"},
        ),
    },
    "depression": {
        "mild": ({f"phq9-{i}": (1 if i <= 5 else 0) for i in range(1, 10)}, {}),
        "severe": (
            {f"phq9-{i}": (3 if i <= 7 else 0) for i in range(1, 10)},
            {"risk-support": "no one really"},
        ),
        "crisis": (
            {**{f"phq9-{i}": 1 for i in range(1, 9)}, "phq9-9": 2},
            {"risk-prior-attempt": "yes"},
        ),
    },
}


class Command(BaseCommand):
    help = "Run a synthetic Sarvam call through the real webhook and pipeline."

    def add_arguments(self, parser):
        parser.add_argument("--module", default="asthma", choices=sorted(SCENARIOS))
        parser.add_argument("--scenario", default="poor")
        parser.add_argument("--facility", help="Facility external id. Defaults to the newest.")

    def handle(self, *args, **options):
        module_id = options["module"]
        scenario = options["scenario"]
        if scenario not in SCENARIOS[module_id]:
            raise CommandError(
                f"Unknown scenario '{scenario}' for {module_id}. "
                f"Choose from: {', '.join(SCENARIOS[module_id])}"
            )
        answers, risks = SCENARIOS[module_id][scenario]
        module = get_module(module_id)

        facility = (
            Facility.objects.filter(external_id=options["facility"]).first()
            if options.get("facility")
            else Facility.objects.order_by("-id").first()
        )
        if facility is None:
            raise CommandError("No facility available. Create one first.")
        geo = facility.geo_organization or Organization.objects.filter(org_type="govt").first()

        tag = uuid.uuid4().hex[:6]
        patient = Patient.objects.create(
            name=f"Demo Patient {tag}",
            gender="female",
            phone_number="+919999900000",
            date_of_birth=datetime.date(1985, 6, 15),
            geo_organization=geo,
        )
        campaign = CareGapCampaign.objects.create(
            facility=facility,
            name=f"Demo {module_id} {scenario} {tag}",
            module_id=module_id,
            sarvam_app_id="demo-app",
            sarvam_app_version=1,
        )
        candidate = CareGapCandidate.objects.create(
            campaign=campaign,
            patient=patient,
            gap_reason=f"Synthetic demo candidate ({scenario}).",
        )
        attempt = CallAttempt.objects.create(
            candidate=candidate,
            webhook_nonce=uuid.uuid4().hex,
            status=CallStatus.REQUESTED,
            app_id="demo-app",
            app_version=1,
        )

        variables = {to_variable(k): str(v) for k, v in answers.items()}
        variables.update({to_variable(k): v for k, v in risks.items()})
        variables[CONCERNS_VARIABLE] = (
            "I get breathless on the stairs | My inhaler runs out quickly"
            if module_id == "asthma"
            else "I have not been sleeping | I feel like a burden"
        )
        variables[CRISIS_VARIABLE] = "true" if scenario == "crisis" else "false"
        variables[DISPOSITION_VARIABLE] = "completed"

        payload = {
            "attempt_id": str(uuid.uuid4()),
            "status": "connected",
            "channel_info": {
                "channel_type": "v2v",
                "channel_provider": "demo",
                "agent_phone_number": "+440000000000",
            },
            "duration": 212.4,
            "interaction_id": f"{timezone.now():%Y%m%d}/demo{tag}",
            "failure_reason": None,
            "final_agent_variables": variables,
            "webhook_config": {
                "url": f"{WEBHOOK_PATH}?n={attempt.webhook_nonce}",
                "metadata": {"nonce": attempt.webhook_nonce},
            },
            "interaction_transcript": [
                {"role": "agent", "en_text": f"Hello, am I speaking with {patient.name}?"},
                {"role": "user", "en_text": "Yes, speaking."},
                {"role": "agent", "en_text": module.instrument.items[0].prompt},
                {"role": "user", "en_text": str(list(answers.values())[0])},
            ],
        }

        self.stdout.write(f"posting synthetic {module_id}/{scenario} payload to {WEBHOOK_PATH}")
        client = Client()
        response = client.post(
            f"{WEBHOOK_PATH}?n={attempt.webhook_nonce}",
            data=payload,
            content_type="application/json",
        )
        self.stdout.write(f"  webhook responded {response.status_code} {response.json()}")

        attempt.refresh_from_db()
        draft = getattr(attempt, "draft", None)
        if draft is None:
            self.stdout.write(self.style.ERROR("  no draft was created"))
            return

        self.stdout.write(self.style.SUCCESS("  draft created"))
        self.stdout.write(f"    patient        {patient.name} ({patient.external_id})")
        self.stdout.write(f"    score          {draft.score_total} — {draft.band_label}")
        self.stdout.write(f"    crisis         {draft.crisis_override}")
        self.stdout.write(f"    escalated      {draft.escalated}")
        self.stdout.write(f"    safety         {[f['code'] for f in draft.safety_findings]}")
        self.stdout.write(f"    risks          {[(f['code'], f['severity']) for f in draft.risk_findings]}")
        self.stdout.write(f"    proposals      {draft.medication_proposals.count()}")
        self.stdout.write(f"    blocks approval {draft.blocks_approval}")
        self.stdout.write(f"    concerns       {draft.concerns}")

        self.stdout.write("  replaying the same payload (must be ignored)")
        replay = client.post(
            f"{WEBHOOK_PATH}?n={attempt.webhook_nonce}",
            data=payload,
            content_type="application/json",
        )
        from care_careloop.models import CheckInDraft

        count = CheckInDraft.objects.filter(call_attempt=attempt).count()
        self.stdout.write(
            f"    replay {replay.status_code}, drafts for this attempt: {count} "
            + ("(idempotent)" if count == 1 else "(*** DUPLICATED ***)")
        )
