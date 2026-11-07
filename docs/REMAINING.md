# What remains

State as of **2026-11-07**. Everything here was verified against the running workspace, not
recalled. The plan and its gates are in [`REVAMP-PLAN.md`](REVAMP-PLAN.md); this file is only the
outstanding work.

**Short version:** the product works end to end without a phone. What is missing is the phone, and
the proof that the agent speaks the way the spec says it should.

---

## 1. Blocked on credentials — the only hard blocker

Nothing in this section can move without a Sarvam telephony connection. Each step depends on the
one above it.

| # | Step | Who | Notes |
| --- | --- | --- | --- |
| 1.1 | Add Twilio Account SID + Auth Token to the Sarvam workspace as a telephony connection | **You** | indus.sarvam.ai/samvaad → Deploy → Phone Numbers → Bring your own → Twilio. Done in the dashboard deliberately, so a live Twilio auth token never enters a conversation transcript. |
| 1.2 | Onboard a number to that connection | **You** | Read back the `connection_id` and `agent_phone_number` afterwards. |
| 1.3 | Apply `agent/careloop.agent.yaml` to the workspace via the MCP server | Claude | `mcp.sarvam.ai/voice-agents`. Needs a daily re-auth — the token lasts 24h with no refresh. |
| 1.4 | Commit an immutable agent version; record the `app_version` | Claude | Then set `CARELOOP_SARVAM_APP_ID` / `_APP_VERSION` so campaigns pin it. |
| 1.5 | Tunnel the workspace so Sarvam can reach the webhook | Claude | `cloudflared` is installed. `CARELOOP_PUBLIC_BASE_URL` → the tunnel host. **The hostname changes on restart**, so re-apply the agent config rather than hardcoding it anywhere. |
| 1.6 | **Spike V6**: prove a Sarvam request lands on the workspace | Claude | Allowlist is not needed outbound, but Sarvam calls *us* from `4.213.167.70` and `35.154.84.150`. |
| 1.7 | **One live call** end to end | Claude | Closes Gate 4's outstanding half. |
| 1.8 | Apply and run the **eval suite** | Claude | The 8 cases are written in `agent/careloop.agent.yaml` but have never executed. This is the **last unticked acceptance item** (§12). |

### Why 1.8 matters more than it looks

The eval suite is the only thing that tests whether the agent *speaks* correctly. The Python side is
proven by 95 tests; the conversation is proven by nothing yet. Its first case asserts **verbatim
instrument delivery** — the property a managed voice platform cannot guarantee and which the README
lists as a real regression. Until it runs, that mitigation is a claim rather than a measurement.

The cases: verbatim delivery · PHQ-9 item-9 crisis · "about four canisters" · refusal mid-instrument
· wrong person answers · voicemail · asks-for-advice · code-switching.

### Note on the number

`TWILIO_PHONE_NUMBER` in the old `.env` is a **+44 UK number**. It will dial, but Indian carriers
routinely flag or drop unknown international caller IDs for automated calls. Fine for dialling your
own handset in a demo; a poor look if you dial an Indian mobile in front of judges. Renting an Indian
number from Sarvam avoids it but needs KYC.

---

## 2. Unverified — small, and worth closing

| Item | Why it is open |
| --- | --- |
| Browser check that `window.__CARE_PLUGIN_RUNTIME__.meta` carries the plugin slug | No browser tooling in the session that built this. Everything the server can attest to is green: build clean, 2.5 kB manifest chunk, `remoteEntry.js` served, host inlined `REACT_ENABLED_APPS`. Open `http://127.0.0.1:25769/careloop?facility=<uuid>` and check the console. |
| Four commits authored as `suryansh@Suryanshs-MacBook-Air.local` | `426ba8d`, `0398d96`, `83ecd1c`, `a711ac5`. Git was auto-deriving the email from the hostname and the hostname changed. Already pushed, so rewriting is a decision, not a cleanup. |

### Trap worth knowing: `npm install` dirties the `care_fe` lockfile

Running `npm install` in the host checkout rewrites three unicode escapes in its
`package-lock.json` (`\u2764` → `❤`). Cosmetic, but it is a **tracked** change in a read-only core
checkout, which breaks the prime directive. It happened once and was restored with:

```bash
git -C care_fe checkout -- package-lock.json
```

`node_modules/` is gitignored, so restoring the lockfile does not undo the install and the host
keeps running. Check both checkouts before claiming zero core changes:

```bash
for d in care care_fe; do
  printf "%-8s %s\n" "$d" "$([ -z "$(git -C $d status --porcelain)" ] && echo CLEAN || echo DIRTY)"
done
```

---

## 3. Real gaps in what was built

Not blockers, but they are rough edges a reviewer would find.

### 3.1 The bare `/careloop` route needs a facility and has no picker

`manifest.tsx` reads `?facility=` from the URL. Without it the queue calls the API with an empty
facility and gets a `400`. The nav item points at `/careloop` with no parameter, so **clicking the
sidebar link shows an error**.

Fix: either a facility picker on the queue page, or default to the user's single facility when they
have exactly one. The `/facility/:facilityId/careloop` route already works correctly.

### 3.2 No `careloop_doctor` command

The old project's `npm run doctor` checked every integration and said plainly which results were
live and which were mocked. It was the thing to run before a demo. The plan called for a narrower
replacement (§9) and it was never built. Today you find out Sarvam is unconfigured by trying to
place a call and getting a `503`.

### 3.3 No reset / teardown command

The old project had `npm run reset`. `careloop_demo_call` creates a fresh patient, campaign,
candidate and attempt on **every run**, so the dev database accumulates synthetic residue with no
way to clear it.

### 3.4 No database-backed tests for the context reader

`tests/test_context_helpers.py` says integration tests for `load_patient_context` and
`has_open_care_gap` "arrive with Phase 3". They did not. Both are verified by hand against the
workspace and both are load-bearing — `has_open_care_gap` is what stops a patient being re-dialled
forever. They need a Django `TestCase` with a facility-organization fixture.

### 3.5 `npm run lint` fails in the frontend plugin

eslint is configured but not installed. `tsc -b` runs as part of `npm run build` so types *are*
checked, but nothing enforces lint rules.

### 3.6 `tasks/` is empty

No Celery anywhere. Not needed for the on-demand call flow, which is how this works by design — but
it means there is no retry sweep: a `no_answer` returns the candidate to `PENDING` and nothing ever
picks it up again. A clinician has to start the call a second time by hand.

---

## 4. Deliberately out of scope

Recorded so nobody rebuilds them by accident.

- **Cohort sweeps, scheduled campaigns, dialling pacing, DND lists.** Calls are started per patient
  by a clinician, exactly as the previous implementation's `POST /call {patientId}` did. The
  `CareGapCampaign` row survives only because it is the parent of a candidate and an attempt, which
  is what makes a call traceable; on-demand calls reuse one per-facility, per-module row.
- **The enrichment layer** — evidence synthesis and the expert panel (`legacy/src/orchestration/`
  `research.ts`, `panel.ts`). Deferred by the plan: the left branch must succeed, the right branch is
  allowed not to exist. `ExpertPersona` is still carried as module data if it is ever revived.
- **Eligibility / coverage checks.** The old Stedi 270/271 path was US payer EDI and CARE has no
  `Coverage` resource.
- **A Hindi agent version.** Would ship as a *separate committed version* with its own eval suite,
  not a language toggle — ACT and PHQ-9 need validated translations, and a TTS language switch is not
  a translated instrument.
- **Moss / semantic retrieval.** Replaced by Sarvam's own knowledge base if patient education is ever
  wanted; removing it also removed the native binding that forced Ubuntu 24.04.

---

## 5. Suggested order

1. **1.1–1.2** (you, ~10 minutes) — unblocks everything else in §1.
2. **1.3–1.8** — the live call and the eval suite. This is what turns "works on synthetic payloads"
   into "works".
3. **3.1** — the broken sidebar link is the first thing anyone clicking around will hit.
4. **3.2** — a `careloop_doctor` pays for itself the first time a demo misbehaves.
5. **3.4** — then the two riskiest untested functions are covered.

Everything else is cosmetic.

---

## 6. What is already done

For contrast, so this file is not read as a longer list than it is. All verified:

- Deterministic clinical core ported to Python, replaying **all 363 frozen TypeScript cases** exactly
- **95 tests green**; mutation-tested, not merely passing
- Plugin live inside CARE: settings, facility-scoped permissions, 5 migrated tables, client-safe
  `config/`, ORM patient-context reads
- Instruments registered as CARE questionnaires with **corrected ACT LOINC codes** and a total-score
  question, so the care-gap loop closes
- Approval transaction writes encounter + coded observations + medication proposal + clinical note,
  or refuses and writes nothing
- Sarvam contract: `on_start` / `on_end` / `raise_crisis_flag` / nonce-guarded webhook, idempotent
- Outbound client and the per-patient call trigger
- `care_fe` review UI: queue, draft review, product binding, patient-page action
- Phone-free demo path: `manage.py careloop_demo_call --module depression --scenario crisis`
- **Zero changes to either CARE checkout** — the acceptance criterion
- 13 of 14 acceptance items ticked (§12); the 14th is 1.8 above
