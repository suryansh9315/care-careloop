# care-careloop

CareLoop on **CARE** — a care-gap outbound campaign that turns a structured phone conversation
into a clinician-reviewable, coded record inside [CARE](https://github.com/ohcnetwork/care).

A voice agent phones patients with an open care gap, works through a validated instrument
(ACT for asthma, PHQ-9 for depression) and records what the patient raises in their own words.
After the call a deterministic core scores and bands the answers, runs a safety screen against the
patient's recorded allergies and active medications, and produces a **draft**. A clinician reviews
it inside CARE and approves — or doesn't.

**Nothing reaches the patient's chart before a clinician approves it.** An unacknowledged critical
safety flag blocks approval.

> Hackathon prototype on synthetic data. Not for clinical use. See the limitations in
> [`docs/REVAMP-PLAN.md`](docs/REVAMP-PLAN.md).

## What's here

| Path | What it is |
| --- | --- |
| `care_careloop/` | **Backend plugin** — Django app, pip-installed into CARE, mounted at `/api/care_careloop/`. Owns the care-gap cohorts, the Sarvam hooks and webhook, the deterministic clinical core, drafts and the approval transaction. |
| `care_careloop_fe/` | **Frontend plugin** — Vite app loaded into `care_fe` at runtime via Module Federation. The clinician review queue and campaign console. |
| `agent/` | The **Sarvam voice agent spec** — source of truth for the agent, applied to the workspace via Sarvam's MCP server and pinned per campaign by committed version. |
| `golden/core-golden.json` | 363 frozen input/output cases for the deterministic core. The Python port must reproduce this exactly. |
| `docs/REVAMP-PLAN.md` | The plan: locked decisions, thirteen constraints verified against CARE and Sarvam source, phase gates. **Read this first.** |
| `docs/spike-results.md` | Verification spike results, including the corrected ACT LOINC panel. |
| `docs/plugin-brief.md` | Short orientation for an agent picking this up mid-build. |
| `workspace/` | Scaffold wiring (`plugin.compose.yaml` and `.env.example` files). Live config is gitignored. |
| `legacy/` | The previous implementation — Medplum, Deepgram, Moss, Stedi. **Port source only; deleted at Gate 2.** |

## Architecture in one line

CARE holds the record; a Django plugin owns the campaign, the clinical core and the approval; a
Vite federation remote owns the clinician UI; **Sarvam Voice Agents** runs the call.

Both CARE repositories stay **completely unmodified** — that is an acceptance criterion, not an
aspiration. See `docs/REVAMP-PLAN.md` §12.

## Why `legacy/` exists

The deterministic clinical core is being ported from TypeScript to Python. A port is only
trustworthy if it is provably behaviour-preserving, so `legacy/` stays runnable until the Python
core reproduces `golden/core-golden.json` byte for byte:

```bash
cd legacy && npm install && npm run golden   # regenerate the freeze
cd legacy && npm test                        # 125 tests, the pre-port baseline
```

It is deleted once Gate 2 passes. The history keeps it recoverable.

## Status

Phase 0 complete: workspace bootstrapped, plugin skeletons generated, and four of six verification
spikes answered — two of which found real defects. Phase 2 step 1 complete: the core is frozen.
Remaining blocker is a Sarvam telephony connection (Twilio credentials). Details in
`docs/spike-results.md`.
