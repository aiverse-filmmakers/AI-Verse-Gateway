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
