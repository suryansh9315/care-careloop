# CareLoop

CareLoop turns a structured pre-visit phone conversation into a clinician-reviewable, coded FHIR CarePlan.

A voice agent calls the patient before their appointment, works through a validated instrument (ACT for asthma, PHQ-9 for depression), records what the patient raises in their own words, and hands off. After the call, a deterministic protocol picks the plan, a safety screen runs against the patient's recorded allergies and active medications, and optional workers attach evidence, peer review and eligibility. The clinician sees all of it in a review queue and approves — or doesn't.

**Nothing CareLoop produces is active until a clinician approves it.** The CarePlan is written as `draft`, every medication as `draft`/`proposal`, and a critical safety flag blocks approval until it is explicitly acknowledged.

---

## What runs where

| Layer | Implementation | Responsibility |
| --- | --- | --- |
| Telephony | Twilio Programmable Voice | Outbound call, bidirectional media stream |
| Voice agent | Deepgram Voice Agent | STT, turn-taking, response generation, TTS |
| Bridge | Node 22 + TypeScript + `ws` | Audio bridge, per-call session, prompts, tools, post-call trigger |
| Source of truth | Medplum (hosted FHIR R4) | Patient, chart, coverage, plan, tasks, artifacts |
| Retrieval | Moss | Patient-safe condition knowledge |
| Evidence synthesis | Groq or Anthropic | Cited rationales and expert-panel critiques |
| Eligibility | Stedi | Real-time 270/271 |
| Dashboard | Vite + React + Medplum user auth | Review queue, plan editing, approval |
| Runtime | Ubuntu 24.04 on EC2, Caddy, systemd, SSM | Public HTTPS/WSS endpoint |

## Try it without any credentials

Every integration has a live path and a labelled mock path. The simulation runs the entire pipeline offline:

```bash
npm install
npm run simulate
```

```bash
npm run simulate depression
```

The depression scenario endorses PHQ-9 item 9, so it demonstrates the crisis override: the numeric band is discarded, no antidepressant is drafted, and the plan escalates. The asthma scenario has a propranolol interaction, duplicate reliever therapy and reliever overuse, so it demonstrates the safety screen.

Everything printed in that mode is deterministic test data. The run says so, and so does the dashboard banner.

## Running it for real

```bash
cp .env.example .env      # fill in credentials
npm run moss:index        # push the condition corpora (once)
npm run seed              # create a demo patient, prints ids for .env
npm run dev               # bridge on :3000
```

```bash
cd web && cp .env.example .env && npm install && npm run dev
```

Twilio needs to reach the bridge over public HTTPS. For local development, point a tunnel at `localhost:3000` and set `PUBLIC_HOST` to the tunnel hostname — the TwiML and WebSocket URLs are derived from it.

Start a call from the dashboard's **Intake** tab, or directly:

```bash
curl -X POST localhost:3000/call -H 'Content-Type: application/json' -H 'X-CareLoop-Secret: dev-secret' -d '{"patientId":"<id>"}'
```

`GET /health` reports which integrations are live and which are mocked.

## How a call becomes a plan

```
intake ─▶ outbound call ─▶ Twilio media stream ─▶ Deepgram agent
                                                       │
                          server-side tools ◀───────────┘
                                │
       chart answers, retrieve education, check coverage  (Medplum / Moss / Stedi)
                                │
                  questionnaire submitted ─▶ post-call pipeline
                                                  │
              ┌───────────────────────────────────┼──────────────────────┐
              ▼                                   ▼                      ▼
     deterministic core                  optional enrichment         FHIR write
   score → band → protocol step        research, expert panel,     draft CarePlan,
   safety screen, risk rules              Stedi eligibility        draft meds, Task
                                                  │
                                        clinician review + approval
```

The split down the middle is the design. The left branch decides the plan and must succeed; the right branch explains it and is allowed to fail. When enrichment fails, the dashboard says it did not run rather than implying it agreed.

### The parts that are deliberately not the model's job

- **Banding and medication selection** are pure functions of the answers (`src/orchestration/scoring.ts`). Same answers, same plan.
- **Emergency rules** live in the condition module and come first in the prompt, ahead of the flow.
- **The tool surface** (`src/orchestration/tools.ts`) is the complete set of actions the voice model can trigger. It holds no credentials and reaches no external system directly.
- **Approval** is a human action. The expert panel is a set of model personas, not a sign-off.

## Adding a condition

A `ConditionModule` (`src/conditions/types.ts`) is the whole extension point: instrument and LOINC codes, score bands, protocol steps with RxNorm-coded orders, risk rules, emergency rules, expert personas, and a patient-safe Moss corpus. Add the file, register it in `src/conditions/registry.ts`, run `npm run moss:index`. The bridge, dashboard and pipeline pick it up without changes.

Modules are also **data**: they persist as FHIR `PlanDefinition`s and the
Treatments screen edits them live, so a treatment can be changed without a
deploy. Saving validates hard — bands must be contiguous and cover the whole
instrument range, every band needs a protocol step, and one expert must be the
safety reviewer — and a module that fails is rejected rather than partially
applied. Built-ins are overlaid last on hydration, so a broken stored module
can never shadow a known-good one mid-demo.

The two shipped modules are `asthma` (ACT) and `depression` (PHQ-9).

## Operating it

```bash
npm run doctor          # check every integration; reports ok / mock / fail
npm run demo:history    # backfill a demo patient's trend, meds and prior plan
npm run demo:call       # run a scripted check-in through the real pipeline, no phone
npm run reset           # clear generated artifacts (dry run; --apply to write)
npm run update-phones -- +13215550123 --apply   # repoint patients at a handset
```

`npm run doctor` is the one to run before a demo. It talks to every configured
service, checks one patient's real context, and says plainly which results are
live and which are mock.

## Two orchestration modes, one flow

The interview is described once, in `src/orchestration/flow.ts`, and rendered
two ways:

- **`prompt`** flattens the whole flow into one system prompt with every tool
  available. It remains available for comparison with `ORCH_MODE=prompt`.
- **`state`** is the live default. It walks the flow node by node; for scored
  and risk questions the bridge speaks the exact question once while the model
  only interprets the patient's natural-language answer.

`npm run simulate` prints both renderings so they can be compared
deterministically. Because both come from one spec, they cannot drift into
asking different questions.

## Tests

```bash
npm test
```

91 tests over the parts where being wrong matters: band boundaries, the crisis
override, clamping of malformed answers, spoken-number parsing ("about four
canisters" must not score as zero), allergy/duplicate/interaction detection,
escalation rules, 271 mapping, panel consensus aggregation, the tool dispatch
contract (idempotency, unknown-tool rejection, out-of-range answers), flow
termination and tool gating, and condition-module validation (band gaps,
missing protocol steps, missing safety reviewer).

## Deployment

`deploy/terraform` provisions the bridge on EC2 with an Elastic IP, Caddy for TLS and WebSocket forwarding, and systemd. There is no SSH ingress — operational access is SSM Session Manager. Runtime secrets come from an SSM `SecureString` fetched at boot, so rotating a credential is a parameter update and a restart.

Ubuntu 24.04 is required rather than incidental: Moss ships a native binding that needs glibc 2.39.

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # edit
terraform init && terraform apply
aws ssm put-parameter --name /careloop/bridge-env --type SecureString --value file://../../.env --overwrite
```

## Limits worth stating plainly

- The RxNorm CUIs in the condition modules are **seed values for a demonstration formulary**. They are re-validated through Medplum's terminology service at write time, but they must be reviewed against a real formulary before any clinical use.
- A 270/271 eligibility check is **not a formulary query**. It says whether coverage is active; it does not guarantee a specific NDC will be paid. The prior-auth step-up flag is a labelled heuristic, not a payer answer.
- The fallback citations are generic public guidance. A production evidence program needs reviewed, versioned sources and citation verification.
- `loadPatientContext` reads allergies, triggers and prior scores from Medplum, but a production context needs field minimisation, tenant authorisation and read auditing.
- The dashboard's bridge shared secret is a local-development convenience. A real deployment should have the dashboard present the clinician's own Medplum token.
- CareLoop does not send prescriptions, guarantee payment, diagnose, or replace emergency care.

## Repository layout

```
src/
  config/env.ts          credentials + the live/mock flags every integration checks
  conditions/            ConditionModule definitions — the extension point
  integrations/          Medplum, Moss, Stedi, LLM, Twilio, Deepgram (each with a mock)
  orchestration/
    context.ts           PatientContext assembly from Medplum
    scoring.ts           scoreInstrument / stepForBand — deterministic
    safety.ts            allergy, duplicate, interaction and risk screening
    prompt.ts            live-call system prompt
    tools.ts             the model's complete action surface
    research.ts          evidence synthesis
    panel.ts             expert personas + consensus aggregation
    plan.ts              FHIR draft writer + approval transaction
    postcall.ts          the pipeline
  bridge/                Express + Twilio media stream + CallSession
  scripts/               seed, simulate, moss:index
web/                     clinician dashboard
docs/                    architecture notes per subsystem
deploy/terraform/        AWS bridge infrastructure
```

`docs/` covers each subsystem in more depth: [care plan lifecycle](docs/care-plan.md), [voice and infrastructure](docs/voice-ai-and-infrastructure.md), [Medplum](docs/medplum.md), [Moss](docs/moss.md), [Stedi](docs/stedi.md), [deep research](docs/deep-research.md), [historical data](docs/historical-data.md).
