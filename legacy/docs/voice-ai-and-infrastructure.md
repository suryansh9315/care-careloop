# Voice AI and infrastructure

## What the patient experiences

1. A clinician creates an intake from the dashboard. The intake creates a Patient, an anchor Condition, an optional Coverage, and a shared condition Questionnaire in Medplum.
2. The clinician starts an outbound call. Twilio calls the patient's phone and requests `POST /voice` from the bridge.
3. The bridge returns TwiML containing `<Connect><Stream>`. Twilio sends bidirectional audio over a WebSocket to `/twilio`.
4. The bridge opens a Deepgram Voice Agent WebSocket. Deepgram performs speech recognition, turn-taking, language-model response generation, and text-to-speech.
5. Maya follows a condition module's flow: greeting, identity/DOB verification, questionnaire items, future-risk questions, open concerns, recap, and goodbye.
6. During the call, server-side tools write answers to Medplum, retrieve education from Moss, and answer insurance questions with Stedi. The model does not receive database credentials or call these systems directly.
7. When the questionnaire is submitted and the call ends, the bridge starts the off-call pipeline. The patient does not wait on research, peer review, or coverage enrichment.

```mermaid
sequenceDiagram
  participant C as Clinician/dashboard
  participant B as Node bridge
  participant T as Twilio
  participant D as Deepgram
  participant M as Medplum
  participant R as Moss
  participant S as Stedi
  C->>B: POST /call or /intake
  B->>T: outbound call REST API
  T->>B: POST /voice
  B-->>T: TwiML + WebSocket stream URL
  T<->>B: bidirectional audio
  B<->>D: Voice Agent WebSocket
  D->>B: server tool call
  B->>M: chart answer / final response
  B->>R: clinical education retrieval
  B->>S: eligibility request
  B-->>D: grounded tool result
  D-->>T: synthesized speech
  T-->>B: hangup
  B->>M: draft CarePlan, review artifacts
  C->>M: clinician approves in dashboard
```

## Technical components

| Layer | Current implementation | Responsibility |
| --- | --- | --- |
| Telephony | Twilio Programmable Voice | Outbound call, phone audio, call status, media stream |
| Speech/voice agent | Deepgram Voice Agent | STT, turn-taking, LLM response, TTS |
| Bridge | Node.js + TypeScript + `ws` | Audio bridge, per-call session, prompts, tools, post-call trigger |
| Source of truth | Medplum hosted FHIR R4 | Patient/chart/coverage/plan/tasks/artifacts |
| Clinical retrieval | Moss SDK | Patient-safe condition knowledge retrieval |
| Evidence synthesis | Groq or Anthropic | Research paragraphs and expert-review rationales |
| Eligibility | Stedi | Real-time 270/271 eligibility response |
| Frontend | Vite + React + Medplum auth | Live chart, review queue, plan editing/approval |
| Runtime | Ubuntu 24.04 EC2, Caddy, systemd, SSM | Public HTTPS/WSS endpoint and process supervision |

## AWS deployment

Terraform in `deploy/terraform` provisions the bridge in AWS account `006215409341` and `us-east-1`:

- default VPC and a public subnet;
- security group exposing only TCP 80 and 443;
- Ubuntu 24.04 LTS AMI resolved through Canonical's public SSM parameter;
- Elastic IP (currently `3.224.10.136`);
- EC2 instance profile with Systems Manager access and permission to read the encrypted `/careloop/bridge-env` parameter;
- Caddy reverse proxy for HTTPS and WebSocket forwarding;
- systemd `careloop-bridge.service` running `dist/src/bridge/server.js`;
- SSM Parameter Store `SecureString` for runtime environment variables.

SSH is not required. SSM is the operational access path. GitHub Actions can assume `CareloopGitHubDeployRole` using GitHub OIDC and send a pull/build/restart command through SSM.

## Runtime isolation and failure behavior

Each call has its own `CallSession`, tool-call idempotency set, Deepgram socket, answer map, concerns, and call identifier. Medplum is accessed through a stateless client. Live chart writes are best-effort so a temporary Medplum failure does not interrupt the conversation.

Heavy work is deliberately off the live path. Moss, Stedi, LLM synthesis, and peer review have fallbacks; failures are logged and should leave a draft or an explicit incomplete artifact for clinician review. A fallback is not equivalent to a verified external result.

## Safety boundary

Maya is not an autonomous prescriber. Emergency/crisis rules in each condition module take precedence over the normal flow. The protocol selection and FHIR writes are deterministic, while research and peer review are advisory. A critical allergy safety flag blocks plan approval until a clinician acknowledges it.

