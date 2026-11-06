# CareLoop on CARE — revamp plan

Target: re-platform CareLoop from Medplum/Deepgram/Moss/Stedi onto **OHC Network CARE**
plugins with **Sarvam Voice Agents** as the voice orchestration layer, keeping the use case
unchanged — a **care-gap outbound campaign** that turns a structured phone conversation into a
clinician-reviewable, coded record.

Nothing in this plan requires a change to `care` or `care_fe`. That is a hard acceptance
criterion, not an aspiration.

---

## 0. Decisions locked

| # | Decision | Chosen |
| --- | --- | --- |
| 1 | Deterministic clinical core | **Ported to Python**, inside the CARE backend plugin. The Node service is deleted. |
| 2 | Clinician review + approval UI | **`care_fe` federated plugin** (Module Federation remote) |
| 3 | Sarvam agent configuration | **Spec file in the repo**, applied to Sarvam via their hosted MCP server; committed version pinned per campaign |
| 4 | Call language + telephony | **English on bring-your-own Twilio** first; Hindi as a second committed agent version. **Bulbul V4** from day one |

Rationale for (3) and the call-path design is in §7. The short version: Sarvam runs the
ASR→LLM→TTS loop itself, so per-question round trips would turn the call into an IVR. Context
and instrument wording load **once** at call start; only crisis handling justifies a mid-call tool.

---

## 1. What gets built

Three artifacts, two of them installable into any CARE deployment, all in **this one repo**.

| Artifact | Path | Unit | Mounted at |
| --- | --- | --- | --- |
| Backend plugin | `care_careloop/` | Django app (pip package) | `/api/care_careloop/` |
| Frontend plugin | `care_careloop_fe/` | Vite app, Module Federation remote | `manifest.routes` + extension points |
| Voice agent | `agent/careloop.agent.yaml` | Sarvam multi-state agent spec | Sarvam workspace, versioned |

### Why one repo rather than the scaffold's two

`care_scaffold` generates each plugin as its own git root inside the workspace checkout. We keep
both in a single repo instead, because the three artifacts are one deliverable: the agent spec
declares the tool and hook contracts that the backend serves, and the frontend renders what the
backend drafts. Splitting them across repos means a three-way version dance for one feature.

Nothing in CARE requires two repos — `ADDITIONAL_PLUGS` and the Compose bind mount take a **path**,
and `pip install -e <repo>/care_careloop` works with `setup.py` in that subdirectory. The read-only
core checkouts (`care`, `care_fe`) stay in the scaffold workspace and never enter this repo.

The one cost: installing straight from git needs `?subdirectory=care_careloop` on the URL rather
than a bare repo URL. Worth knowing before publishing the plugin for someone else to install.

---

## 2. Target architecture

```
                      ┌──────────────────────────────────────────┐
                      │  CARE (core — read-only, zero changes)   │
                      │  Patient · Encounter · Questionnaire     │
                      │  Observation · AllergyIntolerance        │
                      │  MedicationRequest · Notes · ValueSet    │
                      └───────────────┬──────────────────────────┘
                                      │ in-process Django ORM (reads)
                                      │ CARE service layer (writes, on approval)
  ┌───────────────────────────────────┴───────────────────────────────────┐
  │  care_careloop  (Django plugin — /api/care_careloop/)                 │
  │                                                                       │
  │  care-gap cohort builder ── campaign runner ── Sarvam client          │
  │  clinical/  scoring · bands · crisis override · safety · numbers      │
  │  models/    Campaign · Candidate · CallAttempt · CheckInDraft         │
  │  hooks/     on_start (context + instrument)  on_end (outcome)         │
  │  tools/     raise_crisis_flag  (the only mid-call tool)               │
  │  webhook/   post-call: transcript + final_agent_variables → pipeline  │
  └───────┬──────────────────────────────────────────────┬────────────────┘
          │ X-API-Key, server-side only                  │ CARE JWT
          ▼                                              ▼
  ┌───────────────────────────┐              ┌──────────────────────────────┐
  │  Sarvam Voice Agents      │              │  care_careloop_fe            │
  │  Saaras ASR · 105B · V4   │              │  review queue · campaigns    │
  │  multi-state agent        │              │  extension points · routes   │
  │  BYO Twilio telephony     │              └──────────────────────────────┘
  │  knowledge base · evals   │
  └───────────┬───────────────┘
              │ outbound call
              ▼
          the patient
```

---

## 3. Layer swap

| Layer | Was | Becomes | Note |
| --- | --- | --- | --- |
| Telephony | Twilio Programmable Voice (own bridge) | Sarvam telephony, **BYO Twilio connection** | Sarvam owns the media path; no bridge, no TwiML, no WebSocket audio |
| Voice agent | Deepgram Voice Agent (`gpt-4o` think model) | Sarvam multi-state agent (Saaras v4 ASR, `sarvam-105b-conversations`, **Bulbul V4** TTS) | Bulbul V3 reaches EOL on Voice Agents **2026-11-10** — start on V4 |
| Audio bridge | Node 22 + `ws`, `src/bridge/` (864-line session) | **deleted** | Largest single simplification in the project |
| Source of truth | Medplum hosted FHIR R4 | **CARE** (FHIR R5-aligned) | In-process ORM reads; no HTTP client, no client-credential secret |
| Retrieval / KB | Moss (`@moss-dev/moss`, native binding, glibc 2.39) | **Sarvam knowledge base** attached to the agent | Removes the native dependency that forced Ubuntu 24.04 |
| Eligibility | Stedi 270/271 | **removed** | US payer EDI; no analogue in the CARE/India context. CARE has no `Coverage` resource |
| Post-call LLM | Groq / Anthropic | **Sarvam-105B** (optional, keeps the stack in-region) | Enrichment stays allowed-to-fail |
| Dashboard | standalone Vite + Medplum auth | `care_careloop_fe` inside CARE | CARE auth, roles, design system for free |
| Simulation harness | `npm run simulate` | **Sarvam Tests + AI judge**, plus pytest over the ported core | Two layers: pure-function tests and simulated-call evals |
| Runtime | EC2 + Caddy + systemd + SSM | whatever CARE already runs on | The plugin ships inside CARE's image |

---

## 4. Resource mapping — Medplum FHIR → CARE

Every resource the current code touches, and where it lands.

| Medplum FHIR | CARE home | Mechanism |
| --- | --- | --- |
| `Patient` | `Patient` | `/api/v1/patient/` · ORM `care.emr.models.Patient` |
| `Condition` (active) | `Diagnosis` / `Symptom` | `/api/v1/patient/{id}/diagnosis/`, `/symptom/` |
| `AllergyIntolerance` | `AllergyIntolerance` | `/api/v1/patient/{id}/allergy_intolerance/` |
| `MedicationRequest` | `MedicationRequest` | `/api/v1/patient/{id}/medication/request/` — **supports `status: draft` + `intent: proposal`**, so the draft-safety semantics carry over exactly |
| *(active meds for safety screen)* | `MedicationStatement` | `/api/v1/patient/{id}/medication/statement/` |
| `Observation` | `Observation` | **read-only over REST** — see constraint C1 |
| `Questionnaire` | `Questionnaire` | `/api/v1/questionnaire/` |
| `QuestionnaireResponse` | `QuestionnaireResponse` | created by `POST /api/v1/questionnaire/{id}/submit/` |
| `Encounter` *(new)* | `Encounter`, class **`vr`** (virtual) | the telephonic check-in becomes a real encounter |
| `Coverage` | — | **dropped** with Stedi |
| `CarePlan` | — | **plugin-owned** `CheckInDraft` |
| `Task` | — | **plugin-owned** (review queue is the plugin's own model) |
| `Communication` (call log, recap, concerns) | `NoteThread` + `NoteMessage`, and plugin-owned `CallAttempt` | `/api/v1/patient/{id}/thread/` + `/note/` |
| `PlanDefinition` (editable condition modules) | **plugin-owned** `ConditionModuleRecord` | keeps the Treatments screen's live-edit capability |

---

## 5. Hard constraints — verified in CARE and Sarvam source, not assumed

These are the things that sink a sprint on day three. Each was checked against
`ohcnetwork/care@develop` or Sarvam's API reference.

**C1 — `Observation` cannot be created over REST.**
`ObservationViewSet` is an `EMRModelReadOnlyViewSet`. Observations are only ever produced by
submitting a questionnaire response. *Forces:* the instrument must be registered as a **CARE
`Questionnaire`** with LOINC-coded items, and scores are written by
`POST /api/v1/questionnaire/{slug}/submit/` — **by slug, not id** (`lookup_field = "slug"`; a UUID
404s), and only with an encounter (C13). This is more CARE-native than the Medplum version and
gives a `QuestionnaireResponse` → `Observation` provenance chain for free.

**C2 — medications are bound to SNOMED CT, not RxNorm.**
`MedicationRequest.medication` is `ValueSetBoundCoding[CARE_MEDICATION_VALUESET]`, whose compose
is `include system=http://snomed.info/sct filter=constraint << 763158003 |Medicinal product|`.
Route is bound to SNOMED descendants of `284009009`. *Forces:* **every RxNorm CUI in
`src/conditions/asthma.ts` and `depression.ts` is unusable as-is.** Resolution — and it is a
clinical improvement, not a workaround: protocol steps carry a *therapeutic intent* (class, dose
intent, PRN flag, duration), and the clinician binds the actual product in the review UI through
CARE's own medication ValueSet search. This deletes the current README's "seed values for a
demonstration formulary" liability outright.

**C3 — questionnaire item codes are ValueSet-bound and validated against a terminology server.**
`Question.code` is `ValueSetBoundCoding[CARE_OBSERVATION_VALUSET]`; that valueset includes all of
`http://loinc.org`, so ACT and PHQ-9 item codes are *in scope* — but validation calls the
terminology server. *Forces:* verification spike V1 before any questionnaire is authored, and a
documented fallback if the workspace has no reachable terminology service.

**C4 — the plugin runs in-process with CARE.**
It is a Django app inside the same process, so **reads use the ORM directly**
(`care.emr.models.Patient.objects...`) — no HTTP, no tokens, no client-credential secret, none of
`src/integrations/medplum.ts`. But **writes must go through CARE's own service layer**, never raw
ORM, or audit fields and validation are bypassed.

**C5 — provenance: use a CARE service account.**
`User.is_service_account` exists. The voice agent's collected answers are attributed to a
**"CareLoop Voice Agent" service account** as `data_entered_by`, and the approving clinician is
recorded separately on the draft and as the author of any medication order and clinical note.
Attributing agent-collected answers to the clinician as though they asked the questions would be
a provenance lie.

**C6 — plugin permissions must register at import time.**
`PermissionController.register_permission_handler(...)` has to run on module import, not in
`AppConfig.ready()` — core builds its role-permission enum before `ready()` fires.
(`care_filly/security/permissions.py` is the reference.)

**C7 — credential system checks must be `Warning`, never `Error`.**
An `Error`-level Django check raises `SystemCheckError` and breaks `manage.py migrate` and
`collectstatic` on any box without credentials — CI, and the release phase of a deploy. Keep
`REQUIRED_SETTINGS` empty and warn instead. (Documented in `care_filly/apps.py`.)

**C8 — Sarvam's post-call webhook is not signed.**
The documented payload carries `attempt_id`, `status`, `channel_info`, `duration`,
`interaction_id`, `failure_reason`, `final_agent_variables`, `interaction_transcript`,
`webhook_config` — and **no signature header**. *Forces:* the plugin mints a single-use,
unguessable nonce per call, embeds it in the `webhook_config.url` and `metadata`, and matches it
against the stored `CallAttempt` alongside `attempt_id`. `authentication_classes = []`,
idempotent handling, and **200 on unknown events** (a 404 triggers provider retry storms).

**C9 — Sarvam API tools: 30s timeout ceiling, fixed source IPs.**
Calls arrive from `4.213.167.70` and `35.154.84.150`; allowlist them. A mid-call tool is a pause
on the line — hence exactly one of them (§7).

**C10 — any serializer field backed by `meta` must be `write_only=True`.**
Otherwise DRF's `to_representation` raises `AttributeError` → 500 → no CORS header → the browser
reports a *CORS error* and you lose hours chasing the wrong thing.

**C11 — extension points must be verified in the checked-out `care_fe`.**
The catalog in `care-extension-points` is a snapshot. `pluginTypes.ts`
(`SupportedPluginComponents`) in the actual revision is the only authority. A missing hook is a
`care_scaffold` issue, never a core edit. **Confirmed by spike V4:** `AppShellOverlay` is in the
catalog and the LiveKit walkthrough but **not** in `care_fe@6e21fe2` — so no global ambient call
banner exists. `UserProfileSections` is in the host but absent from the catalog. Stale both ways.

**C12 — every ACT LOINC code in the current `asthma.ts` is wrong (found by spike V1).**
Two independent defects: all seven check digits are invalid, *and* the item→code assignment is
shifted one position because the panel's total-score code (`82668-5`) was used as item 1's code.
Medplum never validated codes, so this was invisible; CARE rejects them outright. The item prompts
are correct — only the codes are wrong. The corrected panel is tabulated in
`docs/spike-results.md` and must be applied during the Phase 2 port.
**The golden-file cross-check will not catch this**, because codes do not affect scoring — it is a
deliberate fix, not a mechanical one. PHQ-9's 11 codes were checked the same way and are correct,
including `44260-8` for the item-9 crisis trigger.

**C13 — the questionnaire must be `subject_type: "encounter"`, and it fails silently otherwise
(found by spike V2).** In `handle_response`, a `"patient"` questionnaire forces `encounter = None`,
and the `Observation.objects.bulk_create` is guarded by `if encounter:`. A patient-subject
submission therefore returns **HTTP 200**, creates a `QuestionnaireResponse`, and produces **zero
Observations** — no error raised. *Forces:* the virtual `Encounter` (class `vr`) is a **hard
prerequisite** for any coded result, not an optional nicety, so the approval transaction must create
it before submitting. And every test must assert on the **Observation count**, never on the submit's
status code. CARE's `callback_results` encounter priority is the apt choice for a care-gap callback.
Full verified call sequence and field requirements are in `docs/spike-results.md`.

---

## 6. Plugin-owned data model

CARE has no `CarePlan`, `Task`, `Communication` or `Coverage`. Per the architecture decision
tree, a new domain concept becomes a plugin model with FKs *into* core; core never references the
plugin.

| Model | Holds | Key fields |
| --- | --- | --- |
| `ConditionModuleRecord` | the editable condition module (replaces the `PlanDefinition` store) | slug, instrument spec, bands, protocol steps, risk rules, emergency rules, version, validation state |
| `CareGapCampaign` | one outbound campaign | facility FK, module, gap criteria, window, Sarvam `app_id` + **pinned `app_version`**, status |
| `CareGapCandidate` | one patient in a campaign | patient FK, gap reason, priority, call state, attempt count, DND/consent flags |
| `CallAttempt` | one Sarvam call | candidate FK, `attempt_id`, `interaction_id`, webhook nonce, status, duration, failure reason, transcript, `final_agent_variables` |
| `CheckInDraft` | the un-approved plan | attempt FK, answers, score, band, protocol step, safety findings, escalation, status, approved_by, resulting `QuestionnaireResponse`/`Encounter` ids |
| `DraftMedicationProposal` | proposed therapy, pre-approval | draft FK, therapeutic intent, dose/frequency/PRN/duration, optional SNOMED concept, clinician-bound product |

**Nothing reaches the patient's chart before approval.** This is stronger than the Medplum
design, which wrote `draft` resources into the record. Here the chart is untouched until a
clinician acts, and the approval is a single transaction performed in *their* auth context.

---

## 7. The call path, end to end

```
 1  cohort build        plugin ORM query → patients with an open care gap
                        (e.g. asthma diagnosis + no ACT observation in N days)
 2  campaign launch     Sarvam campaign + cohort upload, or per-patient
                        POST /api/outbounds/v1/orgs/{org}/workspaces/{ws}/outbounds
                        app_config{app_id, app_version, connection_config, agent_variables}
                        user_config{user_phone_number}
                        webhook_config{url: …/webhook/?n=<nonce>, metadata{nonce, candidate}}
                        → {attempt_id}   ← stored on CallAttempt
 3  on_start hook       ONE call, before the agent speaks. Plugin returns:
                        first name · condition · prior score + date · allergies ·
                        active relievers · triggers · emergency rules ·
                        item_1_text … item_n_text  ← the instrument, VERBATIM
 4  conversation        Sarvam multi-state agent, zero round trips:
                        verify_identity → instrument → risk_questions → recap → close
                        answers accumulate in declared OUTPUT variables
 5  crisis (only)       raise_crisis_flag tool → immediate server-side write +
                        built-in call transfer to a human / SIP.
                        Latency is irrelevant here; this is the one earned pause.
 6  on_end + webhook    final_agent_variables + interaction_transcript
 7  pipeline (celery)   clamp + parse answers  →  score  →  band  →  protocol step
                        →  safety screen (allergy · duplicate · interaction · overuse)
                        →  risk + escalation rules       [all pure Python, all tested]
                        →  CheckInDraft
 8  review              care_careloop_fe queue; clinician sees answers, transcript,
                        score, band, safety flags, proposed therapy, and what did NOT run
 9  approval (one txn)  ensure Encounter (class vr, priority callback_results)
                        — MANDATORY: no encounter means no Observations (C13)
                        → questionnaire submit  → QuestionnaireResponse + Observations
                        → MedicationRequest(s), clinician-bound product
                        → clinical note on a NoteThread
                        → draft marked approved
```

**The model never scores.** It collects into declared variables; Python bands them server-side.
Same answers, same plan — the property the whole design rests on, preserved.

---

## 8. Phases, each with a gate

No phase starts until the previous gate is answered **in writing**. A failed gate is a blocker to
report, not something to patch around.

### Phase 0 — Workspace and verification spikes *(blocking, do not skip)*

1. `git init` this repo. **It is currently not under version control** — the first commit is the
   pre-revamp baseline, and the port in Phase 2 depends on being able to diff against it.
2. Clone `care_scaffold` as the workspace; `python3 scripts/configure-workspace.py`;
   `source ./care-scaffold.env`; `.agent/compose.sh up -d --wait --build`; `migrate`;
   `load_fixtures`.
3. `./scripts/new-plugin.sh --name careloop --title "CareLoop"` generates both skeletons. They
   were then moved into **this single repo** as `care_careloop/` and `care_careloop_fe/`, with
   their generated per-plugin git roots dropped — see §1.
4. Install the OHC skills (`ohcnetwork/skills`) and the scaffold's nine `skills/` into
   `~/.claude/skills/`.
5. `claude mcp add --transport http sarvam-voice-agents https://mcp.sarvam.ai/voice-agents`,
   then authenticate via `/mcp`. Token lasts 24h, no refresh — expect a daily re-auth.

**Verification spikes — answer all six before writing feature code:**

| # | Question | Pass criterion | Fallback if it fails |
| --- | --- | --- | --- |
| V1 | Does a LOINC-coded questionnaire item validate? (C3) | **ANSWERED — split.** Terminology server is live; LOINC validates. All 11 PHQ-9 codes valid and semantically correct (incl. `44260-8` for the crisis item). **All 7 ACT codes in `asthma.ts` are invalid** — see C12 | n/a — no fallback needed; the ACT codes must simply be corrected |
| V2 | Does questionnaire submit produce Observations with service-account provenance? (C1, C5) | **ANSWERED — pass.** 5 Observations, corrected ACT codes, `status: final`, `created_by`/`data_entered_by` from the submitter. **But only with `subject_type: "encounter"`** — see C13 | n/a — proven working |
| V3 | Which medication concepts actually resolve in `system-medication`? (C2) | **ANSWERED — pass.** salbutamol `91143003`, budesonide `108622005`, formoterol `386171009`, sertraline `321958004`, propranolol `55745002`. Full list in `docs/spike-results.md` | Clinician binds the product in the review UI with no pre-filled concept — the planned design anyway |
| V4 | Which extension points exist in the checked-out `care_fe`? (C11) | **ANSWERED** at `care_fe@6e21fe29`: `routes`, `navItems`, `PatientHomeActions`, `PatientInfoCardActions`, `PatientSearchActions`, `EncounterActions`, `EncounterOverviewTop`, `encounterTabs`, `FacilityHomeActions` all present. **`AppShellOverlay` does not exist in this revision** — no global ambient call banner; do not plan one | Use `routes` only — it is the cheapest surface and always available |
| V5 | Sarvam workspace readiness | `app_id`, `connection_id`, `agent_phone_number` in hand; on_start/on_end hooks and API tools available on the plan; **Bulbul V4** selectable | Web/WebSocket channel for the demo; phone as stretch |
| V6 | Can Sarvam reach the workspace? (C8, C9) | `cloudflared`/`ngrok` tunnel to the saved `CARE_API_PORT`; a test POST from Sarvam lands on the webhook | Tunnel URLs change on restart — re-point the agent each session, and never hardcode one |

**Gate 0:** six answers recorded; both core checkouts unchanged.

### Phase 1 — Backend skeleton

`settings.py` with `PluginSettings`, correctly-typed `DEFAULTS`, **empty `REQUIRED_SETTINGS`** and
a `Warning`-level credential check (C7). Import-time permission registration (C6):
`can_run_careloop_campaign` and `can_review_careloop_draft`, both `PermissionContext.FACILITY`,
plus an `AuthorizationHandler`. Models + migrations. `urls.py`, `config/` endpoint publishing only
the client-safe subset (never the Sarvam key). Patient-context reader as a direct ORM port of
`context.ts` (C4).

**Gate 1: PASSED.** `GET /api/care_careloop/config/` returns `enabled`, capability flags
(`calling_available`, `sarvam_configured`, `telephony_configured`) and the clinical core's module
metadata — and **no secrets**. Five tables migrated; all three permissions registered and visible
in `PermissionController.get_permissions()`; the `W001` credential check fires at **Warning** level,
so `makemigrations` and `migrate` still complete (C7 confirmed working, not just intended).
`load_patient_context` and `has_open_care_gap` verified against the real spike patient. 49 tests
green (40 clinical + 9 plugin).

### Phase 2 — Clinical core port *(the crown jewel — port test-first)*

Order matters: **port the tests before the implementation.**

1. ~~Freeze a **golden file**~~ — **DONE.** `cd legacy && npm run golden` → `care_careloop/care_careloop/clinical/tests/data/core-golden.json`,
   **363 frozen cases**, 355 KB. Coverage verified non-trivial: all 4 asthma bands and all 6
   depression bands, crisis override firing on exactly `phq9-9 ≥ 1` (15 of 20 rows), 21 critical
   safety findings across allergy / duplicate-therapy / interaction, a 32-row escalation truth
   table, and an 86-entry spoken-language corpus.
   Two notes for the port:
   - **Quirk to preserve, not fix:** `parseCount("-2") === 2` — the sign is stripped. Also
     `parseCount("3.5") === 3`. The port must reproduce these; "fixing" either breaks the golden
     check. If they should change, change them *after* the port lands, in both languages, with the
     golden file regenerated deliberately.
   - The golden file covers **behaviour only**, never codes — so it cannot catch C12.
2. ~~Port the tests~~ — **DONE**, as **stdlib `unittest`, not pytest**. The CARE backend image
   does not ship pytest, and the clinical core should be testable without adding a dependency to
   it. `unittest.subTest` gives per-case failure output, so nothing was lost.
3. ~~Port the core~~ — **DONE.** `clinical/{numbers,scoring,safety}.py`, `clinical/models.py`,
   `clinical/modules/{asthma,depression}.py`.
   **The data/logic split is the thing worth knowing:** a `ConditionModule` is mostly clinical
   *data* (items, bands, protocol steps, prompts, medication orders) and only a little *code*
   (`risk_rules`, `crisis_override`). Retyping ~600 lines of clinical data into Python would
   introduce exactly the class of silent error that C12 already is, so the data is
   **machine-exported** to `clinical/modules/<id>.json` by `legacy/src/scripts/export-modules.ts`,
   which applies the seven ACT code corrections with an explicit, auditable old→new map and fails
   if any of them stops matching. Only the two hooks are hand-written.
4. ~~Cross-implementation test~~ — **DONE.** `clinical/tests/test_golden.py`.

**Gate 2: PASSED.** 40 tests green; all 363 frozen cases replay exactly.

Three things the cross-check caught that would otherwise have shipped silently:

- **`Math.round` vs `round`.** JavaScript rounds half up; Python uses banker's rounding, so
  `round(2.5) == 2` where `Math.round(2.5) === 3`. Five ACT answers of 2.5 total 15 in the frozen
  output and would have totalled 10. Hence `scoring.js_round`.
- **`NaN` and `±Infinity` cannot be expressed in JSON.** `JSON.stringify` wrote `null` for all
  three, so the non-finite malformed cases would have been *replayed as `None`* — a different input
  path than the one frozen. The generator now tags them and the test decodes the tags.
- **The golden file only held medication display names** for safety cases, which would have forced
  the test to reconstruct inputs by mirroring generator logic. It now carries full `MedOrder`s: a
  golden file has to hold complete inputs or the port is guessing.

The suite was **mutation-tested** rather than trusted: swapping `js_round` for `round` produced 2
failures, and changing a single em-dash in one finding message produced 7. A golden test that
passes vacuously is worse than none.

Codes are covered separately in `clinical/tests/test_modules.py`, since the golden file is blind to
them by design — which is how C12 survived in the original.

### Phase 3 — Questionnaire registration and provenance

Idempotent management command that registers one CARE `Questionnaire` per condition module with
LOINC-coded items, and bootstraps the **"CareLoop Voice Agent" service account** (C5). Submit path
through CARE's own service layer, never raw ORM (C4).

**The questionnaire must include a total-score question.** Found while testing the context reader
against real CARE data: the spike patient had five ACT *item* observations and **zero** total-score
observations, so `has_open_care_gap` correctly reported "No recorded ACT result" — meaning a
campaign would have re-dialled that patient forever. CARE only computes a total server-side if a
question carries a `formula`, and we deliberately score in Python instead, so the instrument
questionnaire needs a sixth question coded `82668-5` (ACT) / `44261-6` (PHQ-9) whose answer is the
total our core computed. Without it the care-gap detector can never see a completed check-in.

**Gate 3:** a synthetic submission yields the expected `Observation` set with correct codes and
`data_entered_by`, **including the total-score observation**, and re-running the gap detector on
that patient afterwards returns `False`. That second assertion is the one that proves the loop
closes.

### Phase 4 — Sarvam agent, hooks, webhook

Author `agent/careloop.agent.yaml`: states (`verify_identity → instrument → risk_questions →
recap → close`), instruction with **emergency rules first**, declared input and output variables,
Bulbul V4 voice, low temperature, interruption/nudge/max-length settings, voicemail detection.
Apply it through the MCP server, commit an immutable version, record the version id in the repo.

Endpoints: `on_start` (context + verbatim instrument text), `on_end`, `raise_crisis_flag`, and the
nonce-guarded `webhook` (C8: `authentication_classes = []`, idempotent, 200 on unknown). Allowlist
Sarvam's IPs (C9).

**Gate 4:** one real test call, placed from Sarvam through the tunnel, produces a `CheckInDraft`
with the right band — and a *second* delivery of the same webhook changes nothing.

### Phase 5 — Approval transaction

One atomic operation in the clinician's auth context: ensure `Encounter` (class `vr`) → questionnaire
submit → `MedicationRequest` as `status: draft` / `intent: proposal` with the clinician-bound
product → clinical note → draft marked approved.

**Gate 5:** approval writes all five artifacts or none; an unacknowledged critical safety flag
**blocks** approval; rejection writes nothing to the chart.

### Phase 6 — Frontend plugin

`manifest.routes` for `/careloop/queue`, `/careloop/draft/:id`, `/careloop/campaigns`, plus the
extension points V4 confirmed. Port `ReviewQueue.tsx` and `Review.tsx` — the two largest and most
valuable UI files. `RxNormSelect` becomes a **CARE medication ValueSet search** (C2). i18n keys
prefixed `careloop__` in the plugin's own locale file. Heavy imports stay lazy and out of the
manifest chunk.

**Gate 6:** federation remote loads in the host; review and approval work end-to-end through the
UI; `git status` in both core checkouts is clean.

### Phase 7 — Campaign and cohorts

Cohort builder (ORM care-gap query), Sarvam campaign + cohort upload, retries, concurrency, and the
org-wide DND list. Per-call `CallAttempt` records pinning `app_id` + `app_version` +
`interaction_id` so any reviewed call is traceable to the exact agent that made it.

**Gate 7:** a 5-contact synthetic campaign completes with per-candidate outcomes recorded,
including `no_answer` and `failed`.

### Phase 8 — Evals, demo, documentation

Sarvam **Tests + AI judge** suite — this is the real agent-quality lever. Minimum cases: each score
band; PHQ-9 item-9 endorsement (must trigger transfer, must not band normally); *"about four
canisters"*; refusal mid-instrument; voicemail; wrong person answers; code-switching mid-sentence;
**verbatim-delivery assertion for each instrument item**. Gate the deploy on the suite.

Keep a phone-free demo path: a management command that feeds a synthetic Sarvam webhook payload
through the real pipeline (the current `demo:call` idea, which is worth preserving).

Then: Hindi as a second committed agent version with its own suite (stretch), README rewrite, and
the limitations in §11.

**Gate 8:** eval suite green on the pinned version; both core checkouts unchanged; demo rehearsed.

---

## 9. Disposition of every file in the current repo

### Port to Python (`care_careloop`)

| From | To | Note |
| --- | --- | --- |
| `src/orchestration/scoring.ts` | `clinical/scoring.py` | pure; golden-file checked |
| `src/orchestration/numbers.ts` | `clinical/numbers.py` | spoken-number parsing; keep the corpus |
| `src/orchestration/safety.ts` | `clinical/safety.py` | allergy, duplicate, interaction, overuse |
| `src/conditions/types.ts` | `clinical/modules/base.py` | the extension contract — keep it recognisable |
| `src/conditions/asthma.ts`, `depression.ts` | `clinical/modules/*.py` | **minus** the Moss corpus and **minus** RxNorm (C2) |
| `src/conditions/registry.ts`, `store.ts` | registry + `ConditionModuleRecord` | keeps live editing |
| `src/orchestration/context.ts` | `services/context.py` | ORM, not HTTP (C4) |
| `src/orchestration/plan.ts` | `services/draft.py` + `services/approval.py` | split: build draft vs. write chart |
| `src/orchestration/postcall.ts` | `tasks/pipeline.py` | celery |
| `src/types.ts` | pydantic schemas | |
| all `*.test.ts` | `tests/` (pytest) | tests ported **first** |

### Replaced by the platform

| File | Replaced by |
| --- | --- |
| `src/orchestration/flow.ts`, `statemachine.ts`, `renderers.ts`, `prompt.ts` *(747 lines)* | the Sarvam agent spec — states, instruction, and on_start variables |
| `src/orchestration/tools.ts` *(497)* | output variables + the post-call pipeline; only `raise_crisis_flag` survives as a mid-call tool |
| `src/scripts/simulate.ts` *(256)* | Sarvam Tests + AI judge, plus the pytest golden-file harness |
| `src/scripts/doctor.ts` *(366)* | a narrower `careloop_doctor` management command |
| `src/scripts/seed.ts`, `demo-history.ts`, `reset.ts`, `demo-call.ts` | management commands against CARE fixtures |
| `src/orchestration/research.ts`, `panel.ts` | optional enrichment on Sarvam-105B — **deferred, not core** |

### Delete

`src/bridge/` (1,279 lines — server, session, tests) · `src/integrations/` (medplum, deepgram,
twilio, moss, stedi, calllog, llm) · `src/scripts/moss-index.ts`, `update-phones.ts`,
`offline.ts`, `quiet.ts`, `.ws.tmp.ts` · `deploy/terraform/` (the plugin ships inside CARE's
image) · `docs/medplum.md`, `docs/moss.md`, `docs/stedi.md` · root `package.json`,
`tsconfig.json`, `vitest.config.ts` · the `@moss-dev/moss` optional dependency and with it the
glibc-2.39/Ubuntu-24.04 constraint.

### Frontend

| From | To |
| --- | --- |
| `web/src/pages/ReviewQueue.tsx` *(603)*, `Review.tsx` *(865)* | the plugin's queue and draft pages — the highest-value port |
| `web/src/clinical/*` (charts, items, scale, triage) | port largely as-is |
| `web/src/components/Trend.tsx` | port |
| `web/src/components/RxNormSelect.tsx` | **rewrite** as CARE medication ValueSet search (C2) |
| `web/src/pages/Treatments.tsx` | condition-module editor |
| `web/src/pages/Intake.tsx`, `components/CallDialog.tsx` | campaign / trigger surfaces |
| `web/src/pages/Patients.tsx`, `Patient.tsx` | **drop** — CARE owns these; attach via extension points instead |
| `web/src/medplum.ts`, `components/SignIn.tsx`, `bridge.ts`, `mock.ts` | **delete** — CARE auth and CARE API client |
| `web/src/App.tsx`, `router.ts`, `ui.tsx`, `styles.css` | **delete** — CARE shell and design system |
| `web/src/pages/Live.tsx` | re-point at Sarvam analytics, or drop |

---

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| No terminology server → LOINC/SNOMED codes rejected (C2, C3) | Medium | **High** — guts the "coded record" claim | Spike V1/V3 on day one; notes-only fallback documented honestly |
| Verbatim instrument delivery is now probabilistic, not guaranteed | **High** | High — clinical validity | Low temperature, explicit instruction, eval assertion per item, full transcript shown at review, server-side clamping. **State it in the README.** |
| Python port introduces a scoring discrepancy | Medium | High | Golden-file cross-check (Gate 2) — the whole reason it exists |
| Unsigned Sarvam webhook accepts a forged payload (C8) | Medium | High | Per-call single-use nonce + `attempt_id` match + idempotency |
| Required extension point absent from the checked-out `care_fe` (C11) | Medium | Medium | `routes` + `navItems` always work; file a `care_scaffold` issue, never edit core |
| Tunnel URL churn breaks the agent's webhook between sessions | **High** | Low | Re-apply the agent config from the spec at session start; never hardcode a tunnel URL |
| Sarvam MCP token expires daily (no refresh) | High | Low | Expect one re-auth per working day |
| Bulbul V3 EOL **2026-11-10** | Certain | Medium | Build on **V4** from the first commit |
| Instrument translation validity for Hindi/Indic | High if attempted | **High** | English primary; Indic only as a second version with the translation caveat stated, never claimed as validated |
| Scope creep from the enrichment workers (research, expert panel) | Medium | Medium | Explicitly deferred. The left branch must succeed; the right branch is allowed to not exist |
| Two-language stack confusion during the port | Low | Medium | The Node tree stays read-only as port source and is retained for provenance |

---

## 11. Limitations to state plainly in the README

Carried forward, revised, and newly introduced — all of them belong in the submission.

- **Verbatim delivery is no longer guaranteed.** A managed voice platform speaks every turn through
  an LLM. The instrument wording is supplied verbatim and asserted in the eval suite, but this is a
  probabilistic guarantee where the previous architecture had a hard one.
- **Instrument translation is not validated.** ACT and PHQ-9 in any Indic language require
  validated translations. Anything shipped beyond English is a prototype, not a validated instrument.
- **No medication is prescribed.** The plugin proposes a therapeutic step; the clinician binds the
  product from CARE's own SNOMED-backed medication ValueSet. Nothing is written to the chart before
  approval.
- **Eligibility and coverage checks are gone**, deliberately. The previous 270/271 path was US
  payer EDI with no analogue here, and CARE has no `Coverage` resource.
- **Synthetic data only.** Every demo patient, cohort and call is fabricated.
- **Patient context reads need field minimisation, tenant authorisation and read auditing** before
  any real deployment.
- **CareLoop does not diagnose, prescribe, guarantee payment, or replace emergency care.**
- Clinical use would require validation plus security and privacy review well beyond a hackathon
  prototype.

---

## 12. Acceptance checklist

- [ ] `git status` in `care` and `care_fe` is clean — **zero core changes**
- [ ] Backend mounts at `/api/care_careloop/`; frontend loads as a federation remote
- [ ] Plugin permissions registered at import time; credential check is `Warning` level
- [ ] Sarvam API key exists only in backend settings — never in `config/`, logs, or the bundle
- [ ] Webhook: `authentication_classes = []`, nonce-verified, idempotent, 200 on unknown
- [ ] Golden-file test proves the Python core matches the TypeScript original exactly
- [ ] Observations carry LOINC codes and service-account provenance (or the fallback is documented)
- [ ] Nothing reaches the patient chart before clinician approval
- [ ] An unacknowledged critical safety flag blocks approval
- [ ] Approval is one transaction — all five artifacts or none
- [ ] Every `CallAttempt` pins `app_id`, `app_version`, `attempt_id`, `interaction_id`
- [ ] Sarvam eval suite green on the pinned agent version, including the item-9 crisis case
- [ ] Phone-free demo path works (synthetic webhook → pipeline → draft → approval)
- [ ] README states every limitation in §11
