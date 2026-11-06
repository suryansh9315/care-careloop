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
| `care_careloop/care_careloop/clinical/tests/data/core-golden.json` | 363 frozen input/output cases for the deterministic core. The Python port reproduces this exactly; it ships with the plugin so the proof is re-runnable. |
| `docs/REVAMP-PLAN.md` | The plan: locked decisions, thirteen constraints verified against CARE and Sarvam source, phase gates. **Read this first.** |
| `docs/spike-results.md` | Verification spike results, including the corrected ACT LOINC panel. |
| `docs/plugin-brief.md` | Short orientation for an agent picking this up mid-build. |
| `workspace/` | Scaffold wiring (`plugin.compose.yaml` and `.env.example` files). Live config is gitignored. |
| `legacy/` | The previous implementation — Medplum, Deepgram, Moss, Stedi. Kept as the port source and the provenance record: it is how `core-golden.json` is regenerated and how the comparison can be re-run. |

## Architecture in one line

CARE holds the record; a Django plugin owns the campaign, the clinical core and the approval; a
Vite federation remote owns the clinician UI; **Sarvam Voice Agents** runs the call.

Both CARE repositories stay **completely unmodified** — that is an acceptance criterion, not an
aspiration. See `docs/REVAMP-PLAN.md` §12.

## Why `legacy/` exists

The deterministic clinical core was ported from TypeScript to Python. A port is only trustworthy
if it is provably behaviour-preserving, so `legacy/` stays runnable — it is the only way to
regenerate the frozen cases and re-run the comparison:

```bash
cd legacy && npm install && npm run golden   # regenerate the freeze
cd legacy && npm test                        # 125 tests, the pre-port baseline
```

It is retained deliberately. Nothing in the CARE plugins imports it, so it carries no runtime
weight; it is kept so the port stays auditable.

## Status

**Phases 1 and 2 complete.** The deterministic clinical core is ported to Python and the backend
plugin is live inside CARE: settings, facility-scoped permissions, five migrated tables, a
client-safe `config/` endpoint and ORM-based patient-context reads. **49 tests green**, including a
replay of all 363 frozen cases from the TypeScript original. Phase 0 is done bar one item: a Sarvam
telephony connection still needs Twilio credentials. Details in `docs/spike-results.md`.

```bash
# from the scaffold workspace
./.agent/compose.sh exec -T backend python manage.py test care_careloop   # all 49

# the golden cross-check alone, no Django needed
./.agent/compose.sh exec -T backend \
  python -m unittest discover -s /plugins/care_careloop/care_careloop/clinical/tests \
                              -t /plugins/care_careloop
```
