# Plugin brief — CareLoop

**Full plan, constraints and phase gates:** `docs/REVAMP-PLAN.md`.
This brief is the short orientation; the plan is authoritative and is not duplicated here.

## What it does

A **care-gap outbound campaign**. CARE identifies patients with an open gap (e.g. an asthma
diagnosis with no ACT score in N days). A Sarvam voice agent phones them, works through a validated
instrument (ACT, PHQ-9) and records concerns in the patient's own words. After the call a
deterministic Python core scores and bands the answers, runs a safety screen against the patient's
recorded allergies and active medications, and produces a **draft** that a clinician reviews and
approves inside CARE.

**Nothing reaches the patient's chart before a clinician approves it.**

## Repositories

| Side | Path | Mounts at |
| --- | --- | --- |
| Backend | `care_careloop/` | `/api/care_careloop/` |
| Frontend | `care_careloop_fe/` | `manifest.routes` + extension points, port `25770` |
| Agent spec | `agent/careloop.agent.yaml` | Sarvam workspace, version pinned per campaign |

## The four decisions already made

1. The deterministic clinical core is **Python inside the backend plugin**. No Node service.
2. The review UI is a **`care_fe` federated plugin**.
3. The Sarvam agent is defined by a **spec file in the backend repo**, applied via Sarvam's MCP server.
4. **English on bring-your-own Twilio** first; Hindi later as a second committed agent version.
   **Bulbul V4** from the start — V3 reaches EOL on Voice Agents 2026-11-10.

## Non-negotiables

- **Zero tracked core changes** in `care` and `care_fe`. A missing capability is a `care_scaffold`
  issue, not a core edit.
- The Sarvam API key lives only in backend settings — never in `config/`, logs, or the frontend bundle.
- The post-call webhook is **not signed** by Sarvam: verify a per-call single-use nonce,
  `authentication_classes = []`, be idempotent, return 200 on unknown events.
- Agent-collected answers are attributed to a **service account**, not to the approving clinician.
- Register plugin permissions at **import time**, not in `AppConfig.ready()`.
- Credential system checks are **Warning** level, never Error.
- Observations can only be created by **questionnaire submit** — never raw ORM writes to the chart.
- Medications bind to **SNOMED CT**, not RxNorm; the clinician selects the product at review.

## Order of work

Models and migrations → serializers, viewsets, urls → **verify with curl** → frontend types and API
client → components and manifest → i18n (`careloop__` prefix) → celery and webhooks.
