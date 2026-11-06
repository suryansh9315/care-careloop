# Stedi and insurance

## How insurance is represented

Insurance is captured during intake and stored as a FHIR `Coverage` associated with the Patient. CareLoop also carries a typed `CoverageInfo` in call context:

- payer/trading-partner ID and display name;
- member ID;
- subscriber first/last name;
- subscriber date of birth.

The member and subscriber data are used to build an eligibility request. They are not put into Moss and should never be logged in full.

## Two points in the workflow

### During the call

If a patient asks about plan, coverage, cost, or prior authorization, Maya invokes `checkCoverage`. The bridge calls the coverage client and returns a patient-friendly summary: active/not confirmed, estimated copay, and whether prior authorization may be needed. It also charts a short coverage event in Medplum.

### After the call

Once the deterministic protocol chooses the primary medication, the post-call pipeline calls Stedi and attaches a coverage summary to the clinician review artifacts. The dashboard shows plan name, covered status, prior-auth indicator, estimated out-of-pocket amount, and notes.

## 270/271 technical flow

`src/integrations/stedi.ts` posts a subset 270 JSON request to:

`https://healthcare.us.stedi.com/change/medicalnetwork/eligibility/v3`

The request contains the trading partner, provider NPI/name, subscriber, and service type. The returned 271 is mapped as follows:

| 271 data | CareLoop result |
| --- | --- |
| active coverage benefit (`code: 1`) or active plan status | `covered` |
| co-payment benefit (`code: B`) | `copayUsd` |
| authorization indicator | contributes to `priorAuthRequired` |
| plan description | `planName` |
| missing benefit lines/errors | deterministic fallback plus warning log |

Eligibility is not a complete drug formulary query. The implementation therefore combines payer authorization signals with a transparent step-up heuristic for ICS-formoterol. That is an estimate for workflow support, not a guarantee that a specific NDC will be paid.

## Live versus mock

Stedi is live only when `STEDI_API_KEY` and sufficient payer/subscriber parameters are configured. Without them, or after a network/HTTP/shape error, the deterministic mock returns a clearly patterned test result. Test fixtures may return a realistic 271 only when the exact payer/member fixture is used.

The system must communicate uncertainty: “estimated,” “not confirmed,” or “prior authorization may be needed.” It should not tell a patient that a medication is guaranteed covered.

## Operational and compliance notes

Production use needs payer-specific testing, eligibility freshness rules, minimum-necessary logging, encryption, access controls, and a process for handling inactive coverage. A 270/271 check does not replace pharmacy formulary verification, benefit accumulator details, or a prior-authorization submission.

