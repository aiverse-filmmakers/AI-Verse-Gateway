# Protocol

## OpenAI-compatible surface

`GET /v1/models` publishes model id `aiverse`.

`POST /v1/chat/completions` accepts standard role/content messages, a model, and `stream`. AI-Verse-specific metadata may include:

```json
{
  "metadata": {
    "workspace_id": "operator",
    "session_id": "sess_optional",
    "goal_id": "goal_optional",
    "budget": {
      "max_goal_continuation_turns": 10,
      "wall_clock_seconds": 60,
      "max_actions": 4,
      "max_tokens": 20000,
      "max_cost": 1.0
    }
  }
}
```

The authenticated bearer credential, not `metadata`, determines the principal.

## Run API

`POST /v1/runs` creates the same underlying run without waiting for a chat-shaped result. `GET /v1/runs/:id` returns run metadata without transcript bodies. `GET /v1/runs/:id/events` replays and follows SSE run events.

Mutating run controls accept an `operation_id`. An identical retry is safe. The same operation ID with a changed payload is rejected.

## Runtime subprocess contract

Request:

```json
{
  "protocol": "ai-verse-gateway-runtime/1.0",
  "request_id": "run_...",
  "operation": "invoke",
  "payload": {
    "run_id": "run_...",
    "messages": [],
    "tools": []
  }
}
```

Response:

```json
{
  "protocol": "ai-verse-gateway-runtime/1.0",
  "request_id": "run_...",
  "ok": true,
  "result": {
    "content": "...",
    "tool_calls": [],
    "finish_reason": "stop",
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "cost": 0
    }
  }
}
```

## Brain Goal owner adapter

Gateway expects owner operations equivalent to:

```text
goal.get
goal.evaluate
```

The adapter is intentionally minimal for the Gateway-owned continuation loop. Goal creation/edit/pause/resume/clear remain Brain public operations and should be proxied/routed only once Brain publishes their canonical transport.

## Canonical Gateway client integration contract (G0.2, 2026-10-23)

This section describes the **already implemented** Gateway API, for Dashboard MC2 and other clients. It is **not** a new API, a new Gateway service, a promise of a ready Brain Goal provider, or evidence that the Dashboard has completed a real Mission Control dispatch. Source of behavior: [`src/server.mjs`](../src/server.mjs), [`src/run-engine.mjs`](../src/run-engine.mjs), [`src/goal-owner.mjs`](../src/goal-owner.mjs) and native `test/clean-install.test.mjs` / `test/loop-contracts.test.mjs`.

### Which service owns a request?

| Component | Existing client contract | Owns |
| --- | --- | --- |
| **AI-Verse-Gateway** (this repository, Node >=20) | HTTP `/v1/models`, `/v1/chat/completions`, `/v1/runs` and run event/control endpoints; default loopback `127.0.0.1:8787` | Authenticated execution ingress, bounded run/session/checkpoint/idempotency/audit truth; selected OS host/runtime routing |
| **AI-Verse-Dashboard** (separate repository, Node >=22) | Its existing local Dashboard `POST /rpc` and `/ws` interface, ordinarily port `3100`; local read-model and preview projection | Presentation, registered-system selection and disposable projections, **not** Gateway run or Brain Goal truth |
| **Stock Mission Control MC1 proof** | Temporarily sends `local/aiverse` through an OpenAI-compatible `LOCAL_LLM_ENDPOINT=<canonical Gateway>/v1` | Disposable proof only; NOT the permanent Dashboard MC2 client |

The Dashboard must select the right **configured Gateway instance and secret** for its selected registered system. One canonical Gateway config binds one `system.id`; a caller-supplied `systemId` does not retarget that process. Never bridge `/rpc` by fabricating canonical run IDs or writing to Gateway-owned state directly. Dashboard's MC2.1–MC2.5 tracker owns the first-class typed client; Gateway remains the target service, not a competing Dashboard backend.

### Safe preflight, authentication and readiness

1. `GET /health` is an **unauthenticated** lifecycle probe: `{ok, component, version, state}`, with HTTP 200 only when ready, otherwise 503. It is not permission to run a task.
2. `GET /status` requires `Authorization: Bearer <Gateway token>` and returns `component`, `version`, `state`, `system_id`, `runtime`, `binding`, `remote`, `goal_owner_configured` and `at`. Bind the expected `system_id` from the selected local owner config; do not infer identity from a Dashboard tab label or URL.
3. `GET /v1/models` requires bearer authentication **and ready lifecycle**. It lists the model id `aiverse` and selected `gateway_runtime`. A model listing does **not** prove the upstream model service or Brain Goal adapter is working; a real bounded request is separate proof.
4. All chat/run/control requests require bearer verification, current enabled lifecycle and per-principal rate admission. A missing or bad bearer rejects the call. A browser request with `Origin` must use a configured allowed origin; no `Origin` is accepted for non-browser local clients.
5. Loopback is the default. Non-loopback requires explicit `allow_remote` plus `behind_tls_proxy`, a trusted proxy and appropriate allowed origins. Do not automatically expose this service when Dashboard is remote.

`goal_owner_configured` is only the **presence of a configured path**, not a runtime transport handshake, canonical Brain acceptance or a promise of a supported Goal operation. Treat a missing/unresponsive owner as **unavailable**; do not present an enabled autonomous-Goal UI solely because this boolean is true.

### Normal chat and run creation

- `POST /v1/chat/completions` accepts `model`, role/content `messages`, optional `stream`, and optional `metadata` such as `workspace_id`, `session_id`, `goal_id`, and bounded `budget`. For `stream:false`, a completed run returns an OpenAI-style chat completion; any non-completion returns an explicit `RUN_NOT_COMPLETED` failure, not a fictional assistant message.
- `stream:true` returns OpenAI-style SSE `data:` chunks with assistant text deltas, terminal finish and `[DONE]` on the Gateway's handled terminal/interrupt events. The richer per-run event stream below remains the source for approval, control and status UI.
- `POST /v1/runs` uses the same run engine and returns HTTP **202** with sanitized run metadata, including `run_id` and scope. Read `GET /v1/runs/:run_id` for status/results, `GET /v1/runs/:run_id/diagnostics` for scoped diagnostics, and `GET /v1/runs/:run_id/events` for the **Gateway-specific** SSE event replay+follow stream (`event: <type>`, `data: <event-json>`). The latter can remain subscribed until the client disconnects; do not confuse it with the OpenAI chat chunk stream.
- Gateway derives `principal` only from the bearer and `system_id` only from server config; `metadata.workspace_id` or `x-aiverse-workspace` supplies a **requested** workspace and must pass scope/owner checks. When none is provided, an existing session retains its previously bound workspace; otherwise the configured default applies. Existing session wrong-`system_id`/principal rebind is rejected as `SESSION_BINDING_MISMATCH`.
- Client-created text and model output are not an OS action approval or an authorization grant. Only owner-backed authorization at the final effect boundary permits actions; approvals are explicit checkpoints.
- Optional HTTP `Idempotency-Key` on creation protects retries of the **same** payload; reuse with changed body/scope conflicts. For run controls, submit stable `operation_id` for safe replay and changed-payload rejection. Do not rely on randomly generated operation IDs for client retry safety.
- Run responses strip full `messages`. They are suitable for run UI state, **not** a canonical Memory source or a substitute for an owner-controlled transcript.

### Run controls and failure behavior

`POST /v1/runs/:id/cancel`, `/pause`, `/resume`, `/approval` are supported; `/approval` expects an explicit `decision` of `approve` or `deny` and optionally a stable `operation_id`. Other control bodies may include `reason`. Do not show a control as usable until the current run state and owner policy allow it. A successful transport response is not approval for a future different effect.

| Caller condition | Existing behavior to preserve |
| --- | --- |
| Bad or absent bearer | HTTP 401 and no run access |
| Forbidden browser `Origin` | HTTP 403, no CORS bypass |
| Disabled/uninstalled or changed lifecycle | Refuse serving models/chat/runs/controls; `/health` reflects non-ready state |
| Unknown run, wrong principal or session binding | `RUN_NOT_FOUND`, `FORBIDDEN`, or `SESSION_BINDING_MISMATCH`; do not fall back to a different system |
| Reused idempotency key with changed input | Explicit conflict; no second canonical effect |
| Run interrupted by Gateway restart | Persisted `paused_recovery_required` and operator-controlled recovery, **not** transparent continuation of an unknown provider process |
| Missing, stale or incompatible owner/Goal adapter | Explicit unavailable/blocked/failed run diagnostic; no fake success and no local shadow Brain Goal |
| Windows `EPERM` atomic rename under composed concurrency | Known **open** [Gateway issue #60](https://github.com/aiverse-filmmakers/AI-Verse-Gateway/issues/60). Current retries exist; Windows multi-system durability is **not** cleared merely by native CI |

### Brain Goal continuation is optional, owner-backed and not currently product-proven

An ordinary non-Goal conversation can use the configured runtime and OS without `goal_owner_config`. A Goal-bound run requests `goal_id` and demands the owner protocol `ai-verse-goal-owner/1.0` over a configured JSON subprocess, with `goal.get` and `goal.evaluate` and exact `goal_id`, `version`, `activation_epoch` checks. The Gateway has a fixture-backed client test, **not** current-generation acceptance of a production Brain adapter. Brain's current separate Goal CLI/service owns canonical Goals; its normal `ai-verse-brain-bridge/1.0` reasoner/host transport is **not** automatically the Gateway Goal-owner transport.

No `goal_owner_config` must fail with `GOAL_OWNER_UNAVAILABLE`. Clients must not hide that as a completed task or offer unbounded auto-continue. A future Brain-approved transport should be a small adapter to the existing Brain Goal owner, never a new Goal store in Gateway.

### Verification boundary and Dashboard handoff

The current native fixtures already cover normal chat and retry (`test/clean-install.test.mjs`), approvals and a **fake** Goal adapter (`test/loop-contracts.test.mjs`), authorization/recovery (`test/security-and-recovery.test.mjs`) and state linearizability (`test/state-linearizability.test.mjs`). Additional public-client regressions should target genuinely uncovered **external** behavior, not duplicate those cases.

Dashboard's existing [Mission Control MC1 runbook](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/blob/main/docs/MC1-MISSION-CONTROL-AIVERSE-RUNTIME-PROOF.md) automates the local read-only disposable proof, but its [MC1.4](https://github.com/aiverse-filmmakers/AI-Verse-Dashboard/blob/main/docs/MISSION-CONTROL-EXECUTION-TRACKER-2026-09-15.md) is still explicitly **BLOCKED**. Do not run that live proof before the owner releases its audit gate or paste the token into chat/issues. MC2's first-class client implementation and UI are separate Dashboard-owned deliverables, not work to duplicate in this repository.
