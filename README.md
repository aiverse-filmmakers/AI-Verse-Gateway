# AI-Verse Gateway

AI-Verse Gateway is the canonical client and runtime edge for AI-Verse. It accepts client sessions and runs, binds them to one AI-Verse system/workspace, selects an admitted runtime adapter, executes the bounded host loop, streams run events, and exposes safe control operations.

It does **not** own Brain Goals, Memory, Data, Skills, Multiple Bots coordination truth, Connections credentials, Token truth, or Dashboard presentation truth.

## Install

Requirements: Node.js 20 or newer and a compatible AI-Verse OS installation.

From an immutable Git tag or package artifact:

```bash
npm install -g <AI-Verse-Gateway-package-or-git-ref>
aiverse-gateway install --json
```

For source development:

```bash
npm install
aiverse-gateway install --json
```

`install` only makes Gateway's local lifecycle/state root available. It does not attach domain authority, initialize sibling stores, or authorize external accounts.

## Setup

The safest initial path is loopback-only:

```bash
aiverse-gateway setup \
  --system-root /absolute/path/to/AI-Verse-OS \
  --runtime openai-compatible \
  --base-url http://127.0.0.1:8000 \
  --model your-model \
  --api-key-env MODEL_API_KEY \
  --json
```

Setup prints one Gateway API token once. Only its scrypt verifier is stored. Keep the plaintext token in your client secret store.

Gateway stores the **name** of the upstream runtime credential environment variable, never its secret value.

For local testing, `--runtime deterministic` provides a zero-network test runtime. A portable agent runtime can instead use `--runtime json-subprocess --runtime-command '["agent-binary","gateway-adapter"]'`.

Remote binding is rejected unless both flags are explicit:

```bash
aiverse-gateway setup \
  --system-root /path/to/AI-Verse-OS \
  --listen-host 0.0.0.0 \
  --allow-remote \
  --behind-tls-proxy \
  --allow-origin https://trusted-ui.example \
  ...
```

Gateway intentionally does not terminate public TLS itself in the first public-beta implementation. Non-loopback exposure must sit behind a trusted TLS reverse proxy and still requires Gateway bearer authentication.

### Brain Goal continuation

The Gateway Goal interface is an owner adapter, not a Goal database. The current AI-Verse Brain `main` inspected during this build does not yet expose the benchmarked Goal-owner transport, so Goal-bound runs fail closed until a Brain Goal adapter is configured. Gateway will not invent a second Goal store as a compatibility shortcut.

When configured, every autonomous continuation turn re-reads the Brain-owned Goal and validates `goal_id`, `version`, and `activation_epoch` before continuing.

## Verify

```bash
aiverse-gateway status --json
aiverse-gateway doctor --json
```

`status` is fast and non-destructive. `doctor` checks structural, attachment/discovery, dependency, runtime, operational, and composed-system depth where available.

Start the service:

```bash
aiverse-gateway serve
```

The default bind is `127.0.0.1:8787`.

## Use

### Open WebUI

Configure Open WebUI with an OpenAI-compatible connection:

- Base URL: `http://127.0.0.1:8787/v1`
- API key: the one-time token printed by `setup`
- Model: `aiverse`

Gateway implements:

```text
GET  /health
GET  /status
GET  /v1/models
POST /v1/chat/completions
POST /v1/runs
GET  /v1/runs/:run_id
GET  /v1/runs/:run_id/events
POST /v1/runs/:run_id/cancel
POST /v1/runs/:run_id/pause
POST /v1/runs/:run_id/resume
POST /v1/runs/:run_id/approval
```

`/v1/chat/completions` supports normal JSON responses and OpenAI-style SSE chunks with `stream: true`. `/v1/runs/:id/events` exposes the richer Gateway run event stream.

An optional `Idempotency-Key` on run creation durably binds retries to the original payload. Reusing the same key with a different payload is rejected.

Client-supplied actor/user IDs are never authentication. The effective principal comes from the verified Gateway bearer credential.

### Execution loop

The first supported path is:

```text
Open WebUI
  -> AI-Verse Gateway
  -> AI-Verse OS host adapter
  -> Memory / Skills / Data owner reads and OS permission boundary
  -> selected runtime
  -> OS authorize_action
  -> approval interrupt when required
  -> OS request_action
  -> run checkpoint / result
  -> Brain Goal evaluation when a Goal is bound
```

Gateway can store the session transcript required to continue a client run. That transport/run state is not promoted into AI-Verse Memory automatically.

### Durability claim

Gateway durably checkpoints its own run/session/event state after important transitions. On restart, an in-flight run becomes `paused_recovery_required`. Gateway does not claim transparent provider-process resumption unless a future runtime adapter explicitly proves such a capability. The operator may inspect and resume from Gateway's persisted checkpoint.

## Update / disable / uninstall

Disable and re-enable without deleting Gateway-owned state:

```bash
aiverse-gateway disable --json
aiverse-gateway enable --json
```

Plan a software update:

```bash
aiverse-gateway update --source <immutable-package-or-git-ref> --json
```

Apply it explicitly:

```bash
aiverse-gateway update --source <immutable-package-or-git-ref> --apply --json
```

Normal uninstall removes integration/configuration but preserves Gateway-owned sessions, runs and audit receipts:

```bash
aiverse-gateway uninstall --json
```

Destructive removal is a separate explicit action:

```bash
aiverse-gateway uninstall --purge --json
```

## What setup does and does not grant

Setup does:

- bind Gateway to one declared AI-Verse system root and default workspace;
- configure a runtime adapter;
- verify the OS host boundary;
- create a hashed Gateway authentication identity;
- initialize Gateway-owned session/run/checkpoint storage.

Setup does not:

- transfer strategic direction or Goal ownership from Brain;
- grant Skills permissions;
- create or mutate Memory/Data canonical state;
- make Gateway the owner of Multiple Bots coordination;
- import or store raw Connections/runtime credentials;
- grant remote exposure implicitly;
- turn a successful OS capability discovery into action authorization.

See `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, and `SECURITY.md` for the boundary details.
