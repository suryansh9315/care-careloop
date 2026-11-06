# Medplum and the FHIR record

## Role of Medplum

Medplum is the system of record. CareLoop does not maintain a separate application database. The bridge and dashboard read/write FHIR R4 resources through the Medplum API; the dashboard's review queue is a view over those resources.

## Intake resources

The intake transaction creates:

- `Patient`: name, date of birth, and phone;
- `Condition`: module ICD-10 and SNOMED coding, linked to the patient;
- `Coverage`: active coverage and subscriber/member information when supplied;
- `Questionnaire`: the module's LOINC-coded instrument, condition-scoped and reused across patients.

The condition module is also persisted as a FHIR `PlanDefinition` when treatments are authored from the dashboard. On bridge startup, the registry hydrates stored modules and overlays built-in seed modules.

## Live call writes

After each answer, the `chartLive` tool stores:

- a preliminary coded `Observation` using the instrument item's LOINC code and integer value;
- an in-progress `Communication` containing a human-readable chart line.

Patient concerns are stored as Communications. The final `submitQuestionnaire` tool creates a completed `QuestionnaireResponse` with instrument answers, risk answers, and concern items. Writes are best-effort during the call so chart latency does not make Maya stall.

## Post-call resources

The Bot writes:

| Resource | Purpose |
| --- | --- |
| Final `Observation`s | instrument item values and total score for longitudinal trends |
| `MedicationRequest` | one draft/proposal per structured regimen medication, coded in RxNorm |
| `CarePlan` | draft plan, condition reference, medication activities, follow-up activity, and goal |
| `Task` | urgent care-team work item when protocol/risk escalation is warranted |
| `Communication` | research rationale, citations, peer review, coverage, and patient recap |

FHIR terminology is used deliberately: LOINC for instruments, RxNorm for medication codes, ICD-10/SNOMED for conditions. Runtime validation/lookup is handled through Medplum terminology services with safe fallback behavior where configured.

## Clinician approval

The dashboard edits the draft regimen and then approves it. Approval changes the CarePlan from `draft` to `active`, changes its MedicationRequests to `active`, and completes the review Task. A critical safety flag (for example an allergy match) gates approval until the clinician explicitly acknowledges it.

## Medplum subscriptions and pipeline trigger

The intended production trigger is a Medplum Subscription on completed `QuestionnaireResponse`. The handler resolves the condition module, reconstructs the patient context, scores the instrument, builds the plan, runs optional workers, and persists the resources. In the hosted bridge path, the same post-call orchestration is invoked after questionnaire submission.

## Data access boundary

The bridge uses a server-side Medplum client credential. The dashboard uses Medplum user authentication and should not receive the bridge's client secret. The dashboard reads only the resources needed for the signed-in clinician's workflow. Production authorization must enforce patient/tenant scope, audit access, and restrict sensitive communications.

