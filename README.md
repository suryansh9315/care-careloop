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
| `care_careloop/` | **Backend plugin** — Django app, pip-installed into CARE, mounted at `/api/care_careloop/`. Owns the Sarvam hooks and webhook, the deterministic clinical core, drafts and the approval transaction. |
| `care_careloop_fe/` | **Frontend plugin** — Vite app loaded into `care_fe` at runtime via Module Federation. The clinician review queue, draft review and the patient-page call action. |
| `agent/` | The **Sarvam voice agent spec** — source of truth for the agent, applied to the workspace via Sarvam's MCP server and pinned per campaign by committed version. |
| `care_careloop/care_careloop/clinical/tests/data/core-golden.json` | 363 frozen input/output cases for the deterministic core. The Python port reproduces this exactly; it ships with the plugin so the proof is re-runnable. |
| `docs/REVAMP-PLAN.md` | The plan: locked decisions, thirteen constraints verified against CARE and Sarvam source, phase gates. **Read this first.** |
| `docs/REMAINING.md` | **What is still outstanding**, what is blocked on credentials, and what is deliberately out of scope. |
| `docs/spike-results.md` | Verification spike results, including the corrected ACT LOINC panel. |
| `docs/plugin-brief.md` | Short orientation for an agent picking this up mid-build. |
| `workspace/` | Scaffold wiring (`plugin.compose.yaml` and `.env.example` files). Live config is gitignored. |
| `legacy/` | The previous implementation — Medplum, Deepgram, Moss, Stedi. Kept as the port source and the provenance record: it is how `core-golden.json` is regenerated and how the comparison can be re-run. |

## Architecture in one line

CARE holds the record; a Django plugin owns the campaign, the clinical core and the approval; a
Vite federation remote owns the clinician UI; **Sarvam Voice Agents** runs the call.

Both CARE repositories stay **completely unmodified** — that is an acceptance criterion, not an
aspiration. See `docs/REVAMP-PLAN.md` §12.

## Limitations — read these

This is a hackathon prototype on synthetic data. The honest caveats, not the ones
that sound best:

- **Verbatim delivery of the instrument is no longer guaranteed.** The previous
  implementation spoke each ACT/PHQ-9 item itself, so the wording was certain. A managed voice
  platform speaks every turn through an LLM. The wording is supplied verbatim, the temperature is
  low, and the eval suite asserts it — but this is now a probabilistic guarantee where it used to
  be a hard one. That is a real regression in clinical validity.
- **Instrument translation is not validated.** ACT and PHQ-9 in any Indic language need validated
  translations. Running them in a language other than English would make this a prototype of an
  instrument, not the instrument. English only, deliberately.
- **No medication is prescribed.** The protocol proposes a therapeutic step; a clinician binds the
  product from CARE's SNOMED-backed ValueSet, and what is written is a `draft` / `proposal`, not an
  active order. An accepted proposal with no bound product is skipped rather than guessed at.
- **Scores are computed, not interpreted.** Banding and the safety screen are pure functions of the
  recorded answers. Nothing in this system diagnoses, and the agent never states a score.
- **Eligibility and coverage checks are gone**, deliberately: the previous 270/271 path was US payer
  EDI with no analogue here, and CARE has no `Coverage` resource.
- **Patient context crosses a trust boundary** into a third-party voice platform. It carries a first
  name and clinical context and nothing else — but field minimisation, tenant authorisation and read
  auditing all need real work before any deployment.
- **Synthetic data only.** Every patient, call and draft in this repo's demos is fabricated.
- **CareLoop does not diagnose, prescribe, guarantee payment, or replace emergency care.** Clinical
  use would need validation plus security and privacy review well beyond a prototype.

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

**Everything works end to end except the phone.** All six phases are through their gates and
**95 tests pass**, including a replay of all 363 frozen cases from the TypeScript implementation
this was ported from.

What is outstanding, and what is deliberately out of scope, is in
**[`docs/REMAINING.md`](docs/REMAINING.md)**. The short version: a Sarvam telephony connection
(needs Twilio credentials) unblocks the live call and the agent eval suite, which is the last
unticked acceptance item.

Run the whole thing without a phone:

```bash
# from the care_scaffold workspace
./.agent/compose.sh exec -T backend python manage.py careloop_setup --facility <uuid>
./.agent/compose.sh exec -T backend python manage.py careloop_demo_call \
    --module depression --scenario crisis
```

That posts a payload shaped exactly like Sarvam's post-call webhook at the **real** webhook view, so
the nonce check, variable parsing, clinical core, safety screen and draft build all run as they
would on a live call. The crisis scenario is the one to look at: PHQ-9 total 10 would band as
*moderate*, but item 9 diverts it to the crisis pathway with **zero** medication proposals.

Tests:

```bash
./.agent/compose.sh exec -T backend python manage.py test care_careloop        # all 95

# the golden cross-check alone — no Django needed
./.agent/compose.sh exec -T backend \
  python -m unittest discover -s /plugins/care_careloop/care_careloop/clinical/tests \
                              -t /plugins/care_careloop
```
