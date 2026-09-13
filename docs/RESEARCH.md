# Gateway benchmark notes

Research date: 2026-09-13.

The implementation was benchmarked against current behavior in:

- OpenClaw Gateway/agent execution: accepted run IDs, serialized session execution, streaming events, abort/timeout behavior, session persistence, and explicit Goal controls.
- Open WebUI-compatible providers: `/v1/models`, `/v1/chat/completions`, streaming, and OpenAI tool-call compatibility as the lowest-friction temporary UI edge.
- Hermes API server: durable run IDs/idempotency, SSE run events, session APIs, API-key identity, and profile isolation.
- OpenAI Agents SDK: explicit loop primitives, sessions, human-in-the-loop, guardrails, tracing, and tool/MCP boundaries.
- Existing AI-Verse Dashboard gateway: loopback binding, origin checking, body bounds, system-bound sessions and event subscriptions.
- Existing AI-Verse Multiple Bots: runtime adapter interface, narrowing budgets, loop/no-progress guards, durable recovery/dead-letter concepts, and remote authority controls.

AI-Verse does not copy any one implementation wholesale. The Gateway keeps the strongest edge/runtime patterns while preserving the AI-Verse rule that every domain truth has exactly one canonical owner.

## Primary references

- OpenClaw agent loop: https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md
- Open WebUI OpenAI-compatible provider contract: https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/
- Hermes API server: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/

These are benchmark inputs, not copied implementations. AI-Verse owner boundaries remain authoritative.
