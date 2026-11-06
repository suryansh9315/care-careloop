# Phase 0 verification spikes — results

Workspace: the `care_scaffold` checkout (core checkouts live there; this repo holds the plugins)
Plan: `docs/REVAMP-PLAN.md`

## Recorded revisions

| Repo | Revision | Note |
| --- | --- | --- |
| `care_scaffold` | `a3ecf5e` (2026-10-11) | workspace root; both self-tests pass |
| `care` | `5bc81d522a4363ae93294e7dcd3b0b66ac522456` | shallow, read-only core |
| `care_fe` | `6e21fe297102c1339eb0516301fe2e49faa7c3e6` | shallow, read-only core |

Allocated ports: API `25768` · host FE `25769` · plugin FE `25770` (DB/Redis/MinIO/debug also saved
in `care-scaffold.env`).

Runtime: colima 0.10.3 VM (4 cpu / 8 GB / 60 GB), docker 29.9.3, compose 5.7.0.
`~/.docker/config.json` registers `/opt/homebrew/lib/docker/cli-plugins` so `docker compose` resolves.

---

## V4 — extension points in the checked-out `care_fe` — **DONE, with a finding**

Authority: `care_fe/src/pluginTypes.ts`, `SupportedPluginComponents` at revision `6e21fe29`.

**`AppShellOverlay` does not exist in this revision.** The scaffold skill catalog lists it; the
checked-out host does not have it. This is exactly the snapshot-vs-reality gap constraint C11 warns
about. **Consequence:** there is no supported surface for a global ambient banner (the "call in
progress anywhere in the app" idea borrowed from the LiveKit walkthrough). Do not plan one, and do
not add the hook to core.

Confirmed present and relevant to CareLoop:

| Surface | Use for |
| --- | --- |
| `routes` | `/careloop/queue`, `/careloop/draft/:id`, `/careloop/campaigns` — primary, always available |
| `navItems`, `adminNavItems` | sidebar entry to the queue and campaign console |
| `PatientHomeActions`, `PatientHomeQuickActions` | "Call for check-in" / "View last check-in" on the patient page |
| `PatientInfoCardActions`, `PatientInfoCardQuickActions` | per-patient quick actions |
| `PatientSearchActions` | bulk "build care-gap cohort from this search" |
| `EncounterActions`, `EncounterOverviewTop` | surface the check-in draft against the virtual encounter |
| `FacilityHomeActions` | campaign entry point at facility level |
| `encounterTabs` | a dedicated check-in tab on the encounter |
| `overrides` | last resort only |
| `NoteMessageInput`, `Scribe`, `UserProfileSections` | available, not currently needed |

`UserProfileSections` is present in the host but absent from the scaffold catalog — the catalog is
stale in both directions.

---

## V3 — SNOMED medicinal-product concepts resolve — **PASS**

The terminology server is reachable from the workspace and `system-medication`
(`<< 763158003 |Medicinal product|`) expands correctly. Every drug referenced by both condition
modules resolves:

| Drug | SNOMED concept | Display |
| --- | --- | --- |
| salbutamol | `91143003` | Salbutamol-containing product |
| budesonide | `108622005` | Budesonide-containing product |
| formoterol | `386171009` | Formoterol-containing product |
| sertraline | `321958004` | Sertraline-containing product |
| propranolol | `55745002` | Propranolol-containing product (the asthma interaction case) |

So constraint C2's resolution is fully viable: protocol steps can carry real SNOMED concepts, and
the review UI's clinician-binds-product flow works against `POST /api/v1/valueset/system-medication/expand/`.

API shapes (both took a wrong guess first — record them):
- expand: `POST /api/v1/valueset/{slug}/expand/` body `{"search": str, "count": int<100}`
- validate: `POST /api/v1/valueset/{slug}/validate_code/` body is a **flat Coding**
  (`{"system": ..., "code": ...}`), *not* nested under a `code` key → 400 otherwise.

---

## V1 — LOINC-coded questionnaire items validate — **SPLIT, and it exposed a real defect**

LOINC validation works (`system-observation` includes all of `http://loinc.org`). But:

- **All 11 PHQ-9 codes in `depression.ts` are valid**, and spot-checked semantically correct —
  including `44260-8` = *"Thoughts that you would be better off dead, or of hurting yourself in some
  way in last 2 weeks"*, which the crisis override depends on. `44261-6` total and `44249-1` panel
  both correct. **No change needed.**
- **All 7 ACT codes in `asthma.ts` are invalid LOINC**, and wrong in two independent ways: every
  check digit is incorrect, *and* the item→code assignment is shifted one position because the
  panel's total-score code was used as the first item's code.

Medplum never validated these codes, so the defect was invisible. CARE validates, so it surfaces
immediately. The item *prompts* in `asthma.ts` are correct — only the codes are wrong.

### Corrected ACT panel (verified against the live terminology server)

| Purpose | `asthma.ts` has | Correct code | Verified display |
| --- | --- | --- | --- |
| Panel | `82674-1` | **`82674-3`** | Asthma Control Test [ACT] |
| Total score | `82673-3` | **`82668-5`** | Total score [ACT] |
| Item 1 — activity limitation | `82668-3` | **`82669-3`** | How much of the time did your asthma keep you from getting as much done at work, school or at home |
| Item 2 — shortness of breath | `82669-1` | **`82670-1`** | How often have you had shortness of breath during the past 4 weeks [ACT] |
| Item 3 — night-time waking | `82670-9` | **`82671-9`** | How often did your asthma symptoms wake you… |
| Item 4 — rescue inhaler use | `82671-7` | **`82672-7`** | How often have you used your rescue inhaler or nebulizer medication |
| Item 5 — self-rated control | `82672-5` | **`82673-5`** | How would you rate your asthma control during the past 4 weeks [ACT] |

**Action:** fix the codes during the Phase 2 port. Do **not** carry them over as-is. Note that the
golden-file cross-check compares *scoring behaviour*, which these codes do not affect — so the
golden file will not catch this. It has to be fixed deliberately.

---

## V2 — questionnaire submit → Observations with provenance — **PASS**, with a silent-failure trap

Proven end to end by `v2b_spike.py`: facility → patient → virtual encounter → encounter-scoped
questionnaire → submit → **5 Observations**, all carrying the corrected ACT LOINC codes, status
`final`, with `created_by` and `data_entered_by` both set from the submitting user.

```
82669-3 value=5   82670-1 value=2   82671-9 value=3   82672-7 value=2   82673-5 value=2
status=final   created_by=<submitter>   data_entered_by=<submitter>
```

So the service-account provenance design works exactly as planned: submit as the CareLoop service
account and `data_entered_by` becomes the service account, while the clinician is recorded
separately as the approver.

### ⚠️ The trap: `subject_type` must be `encounter`, or Observations are silently skipped

`care/emr/resources/questionnaire/utils.py:handle_response`:

```python
if questionnaire_obj.subject_type == "patient":
    encounter = None
...
if encounter:
    Observation.objects.bulk_create(bulk)   # ← only ever runs with an encounter
```

A `subject_type: "patient"` questionnaire returns **HTTP 200**, creates a `QuestionnaireResponse`,
and produces **zero Observations** — no error, no warning. The first V2 attempt hit exactly this
and looked successful. Consequences for CareLoop:

1. The instrument questionnaire must be registered with `subject_type: "encounter"`.
2. The virtual `Encounter` is a **hard prerequisite** for coded observations, not a nice-to-have —
   it must exist *before* the submit, which fixes the ordering of the approval transaction.
3. Any test asserting "submit worked" must assert on the **Observation count**, never on the
   submit's status code.

### Verified call sequence and field requirements

| Step | Endpoint | Notes |
| --- | --- | --- |
| Facility | `POST /api/v1/facility/` | needs `facility_type` as a **name** (`"Primary Health Centres"`), `description`, `pincode`, `address`, `phone_number`, `is_public`, `features: []`, and a **district** `geo_organization` |
| Patient | `POST /api/v1/patient/` | only `geo_organization` — no facility needed |
| Encounter | `POST /api/v1/encounter/` | `encounter_class: "vr"` (virtual), `status: "in_progress"`, `period.start`. **`priority: "callback_results"`** exists and is semantically right for a care-gap callback |
| Questionnaire | `POST /api/v1/questionnaire/` | `organizations` is **required**, `min_length=1`, and `can_write_questionnaire` must pass in it |
| Submit | `POST /api/v1/questionnaire/{slug}/submit/` | **`lookup_field = "slug"`** — a UUID here returns 404. Body: `resource_id` (the encounter), `patient`, `encounter`, `results[].question_id` = the question's **UUID** (not `link_id`) |
| Observations | `GET /api/v1/patient/{pid}/observation/?encounter={eid}` | read-only; `ignore_group=true` drops group rows |

Other gotchas banked:
- `validate_code` takes a **flat** `Coding` body (`{"system", "code"}`), not nested under `code` → 400.
- Observation `value` serialises as `{"value": "2"}`, with `value_type` from the question type.
- The total score is **not** auto-computed unless the question carries a `formula`. CareLoop scores
  in Python and writes the total itself (`82668-5`).
- Questionnaire write permission: the fixture org `role | Administrator` was **denied**;
  `role | Health Department` was accepted. Probe, don't assume.
- `can_submit_encounter_questionnaire` / `can_submit_patient_questionnaire` resolve through
  `find_roles_on_patient`, so the **service account needs a role on the patient's organization or
  facility** — not merely a global permission. This is a Phase 3 provisioning task.

**Spike-only shortcut:** `care-admin` was promoted to superuser to get past the role-on-patient
check. That is not the production design — the service account must be granted a real scoped role.
A pre-existing `admin` superuser also exists in the fixtures.
## V5 — Sarvam workspace readiness — **PARTIAL PASS**, one item blocked

MCP server `https://mcp.sarvam.ai/voice-agents` authenticated and connected. It binds to a single
org/workspace resolved from the login and cannot switch orgs.

| Item | Result |
| --- | --- |
| Workspace resolves | **yes** — reads succeed |
| Existing agents | **0** — nothing to inherit; the agent is created from our spec in Phase 4 |
| Telephony connections | **0** — ⚠️ no `connection_id` or `agent_phone_number` yet |
| Bulbul V4 available | **yes** — 58 English voices on `sarvam-tts-v4.0-beta` ("Sarvam TTS v4"). The V3 EOL on 2026-11-10 is a non-issue; some `sarvam-tts-v3.1-rl-hd` voices also exist and should be avoided |

### Voice choice — two strong candidates, same speaker

| `voice_id` | Display | Why |
| --- | --- | --- |
| `Soniya_Mali-English_Medical_Customer_Care` | Ishita - Medical Support | "warm, soft-spoken and expressive… best for healthcare and patient support calls" — purpose-built for this use case |
| `Soniya_Mali-English_Numbers` | Ishita - English Numbers Specialist | "best for number-heavy support calls" — ACT/PHQ-9 are 0–5 scales read aloud repeatedly |

Both are the same underlying speaker, so switching between them keeps the voice identity stable.
Start with the medical voice; if digit intelligibility is weak in testing, the numbers voice is a
drop-in A/B with no other change. `Ria_Rao` ("Ishita - Hinglish Support Agent") is the natural
Hindi/code-mixed successor for the second committed version.

**Blocked:** bring-your-own Twilio needs a connection configured with the Twilio Account SID and
Auth Token before any outbound call can be placed. That is the one remaining input needed from the
user.

## V6 — Sarvam can reach the workspace webhook — UNBLOCKS WITH V5

`cloudflared` is already installed, so the tunnel to the saved `CARE_API_PORT` (25768) is
available. Full test needs a telephony connection (V5) to place a real call. Remember the webhook
URL changes whenever the tunnel restarts — re-apply the agent config from the spec rather than
hardcoding it.


---

## Phase 3 write path — verified in the workspace

`manage.py careloop_setup` is idempotent and registers both instruments:

| Questionnaire | subject_type | Questions | LOINC codes |
| --- | --- | --- | --- |
| `careloop-asthma` | `encounter` | 6 (5 items + total) | 82669-3, 82670-1, 82671-9, 82672-7, 82673-5, **82668-5** |
| `careloop-depression` | `encounter` | 10 (9 items + total) | 44250-9, 44255-8, 44259-0, 44254-1, 44251-7, 44258-2, 44252-5, 44253-3, 44260-8, **44261-6** |

The questionnaires attach to an `Organization` (defaulting to the first `govt` one — Kerala in the
fixtures). Creating the `QuestionnaireOrganization` row is what populates
`Questionnaire.organization_cache`, and that cache is what makes the questionnaire visible to
non-superusers via `get_filtered_questionnaires`. Creating the questionnaire by ORM without it
would leave it invisible.

### Service account

`careloop-agent`, `is_service_account=True`, with an unusable password — there is no credential to
leak, and nothing authenticates as it over HTTP; it is only passed in-process to CARE's service
layer.

It is granted the **`Staff`** role in the facility's **root** `FacilityOrganization`. Staff is the
least-privileged role carrying `can_submit_encounter_questionnaire`. Granting per facility is also
the scoping mechanism: the agent can only record answers for facilities it has been added to.
Without the grant, submission fails with "Permission Denied to submit patient questionnaire" — the
failure spike V2 hit before taking a superuser shortcut. `find_roles_on_patient` resolves roles
through the encounter's `facility_organization_cache`, the patient's `organization_cache`, or a
direct `PatientUser` row; a global permission is not enough.

### Gate 3 result

6 observations written, the total among them, all `data_entered_by = careloop-agent`, and
`has_open_care_gap` flips to `False` afterwards. Full output in `docs/REVAMP-PLAN.md` §8 Phase 3.
