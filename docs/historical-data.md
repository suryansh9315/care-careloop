# Historical patient data

## What is used

At call start, CareLoop builds a `PatientContext` from Medplum. The intended context includes:

- identity and DOB for verification;
- anchor Condition and coded diagnosis;
- active MedicationRequests as current medications;
- allergies and triggers when recorded;
- prior instrument totals, oldest to newest, for the greeting/recap and dashboard trend;
- Coverage information for Stedi.

The call prompt uses this context to make Maya history-aware without asking the patient to repeat known facts. The dashboard uses prior finalized score Observations to render the trend chart.

## How longitudinal scores are stored

During the call, item answers are preliminary Observations. After submission, the Bot creates final item Observations and a final total-score Observation using the module's LOINC codes. The total scores can therefore be searched and ordered by effective date for a longitudinal view. The QuestionnaireResponse remains the source of the complete answer set, including risk answers and concerns.

## How history affects a new plan

History is context and evidence, not an automatic override:

- prior scores show trajectory and are visible to the clinician;
- current medication and allergy data feed the deterministic safety check;
- prior active CarePlans are linked through `CarePlan.replaces`;
- prior exacerbation/reliever/adherence answers can produce future-risk findings;
- current therapy and score trend can be used by the research/peer-review prompts;
- prior therapy can support a prior-authorization rationale, but Stedi eligibility is still checked separately.

## Current implementation limits

The repository's `loadPatientContext` path currently reads active medications and the anchor condition directly. Allergy, trigger, and prior-score loading is implemented as a seam but must be wired to the corresponding Medplum searches/observations for a fully populated production context. The intake `Coverage` stores payer/member basics; subscriber details used for a complete 270 may also be supplied through environment/test configuration.

Historical data is never sent to Moss. It is passed only to the server-side orchestration and, where configured, the evidence/peer-review LLM prompts. Production deployments should minimize fields, redact unnecessary identifiers, enforce tenant authorization, and audit every read.

