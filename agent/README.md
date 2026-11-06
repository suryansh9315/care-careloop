# Sarvam voice agent spec

`careloop.agent.yaml` lands here in **Phase 4**. It is the source of truth for the agent and is
applied to the Sarvam workspace through their hosted MCP server
(`https://mcp.sarvam.ai/voice-agents`), not hand-edited in the dashboard.

## Why a spec file rather than the Canvas

The agent definition is clinical content — the instruction, the emergency rules, the state order,
the output variables. It belongs in version control where it can be diffed and reviewed, not in a
dashboard. The MCP server exposes agent authoring, so the spec can be applied from a coding agent.

## What it will hold

- **States**: `verify_identity → instrument → risk_questions → recap → close`
- **Instruction**: emergency rules **first**, ahead of the flow
- **Input variables**: patient context, loaded once by the `on_start` hook — including the
  instrument wording verbatim, so the questions stay in this repo rather than arriving one
  round-trip at a time
- **Output variables**: the collected answers, the patient's concerns, a disposition. The model
  never computes a score; Python bands the answers server-side
- **Tools**: exactly one mid-call tool, `raise_crisis_flag`, plus built-in call transfer. Every
  other tool is an `on_start` / `on_end` lifecycle hook
- **Voice**: `Soniya_Mali-English_Medical_Customer_Care` on `sarvam-tts-v4.0-beta` (Bulbul V4).
  Bulbul V3 reached end of life on Voice Agents on 2026-11-10

## Verified workspace facts

From spike V5 — see `../docs/spike-results.md`:

- The MCP server binds to **one org and one workspace**, resolved from the login; it cannot switch.
- The workspace starts empty: 0 agents, 0 telephony connections.
- Sarvam calls our endpoints from `4.213.167.70` and `35.154.84.150`; API tools cap at a 30s timeout.
- The post-call webhook is **not signed** — verify the per-call nonce instead (constraint C8).

## Versioning

Commit an immutable version after every change, run the eval suite against it, and pin that
`app_version` on the campaign. Every `CallAttempt` records `app_id`, `app_version`, `attempt_id`
and `interaction_id`, so any call in the review queue is traceable to the exact agent that made it.
