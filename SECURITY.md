# Security

## Public-beta threat model

Gateway is loopback-only by default. Non-loopback binding is rejected unless the configuration explicitly opts into remote access and declares that traffic is behind a trusted TLS proxy.

Every route except the minimal `/health` probe requires bearer authentication. Identity is derived from the verified credential. Request fields and headers such as `actor_id`, `user`, or `x-actor-id` are not authentication.

Gateway API tokens are stored as salted scrypt verifiers. Runtime/API provider secrets are referenced by environment-variable name and are not written into Gateway config, run records, events, audit receipts, prompts, or logs by Gateway.

Browser requests with an `Origin` header must match the explicit origin allowlist. Authentication is header-based, not cookie-based, which removes ambient-cookie CSRF authority. CORS preflight permits only the declared API headers and methods.

Request bodies are bounded. Per-principal request rates are bounded. Run turns, actions, tokens, cost, and wall-clock time can be bounded independently. Child/requested budgets can only narrow configured outer limits.

## Privileged controls

Pause, resume, cancel, and approval operations are bound to the authenticated run owner and emit audit receipts. Control idempotency prevents an operation ID from being replayed with a changed payload.

Approval never bypasses the owner permission edge. Gateway re-runs OS authorization immediately before an approved action executes.

## Tool execution

Model output can request only the admitted `aiverse_action` tool. Gateway converts that request into the OS host contract. OS authorization happens before `request_action`. An OS denial blocks execution. Capability discovery is context, never permission.

## Goals

Brain remains the Goal source of truth. Gateway stores only a run binding to Goal identity/version/activation epoch. Before every autonomous continuation turn, Gateway re-reads Brain and revokes continuation if that binding changed.

## Recovery

Gateway durably persists its own run checkpoint. After process restart, previously running work is marked `paused_recovery_required`. This intentionally avoids claiming that an arbitrary model/provider subprocess resumed safely when no such proof exists.

## Reporting

Do not include live API keys, credential files, personal prompts, or canonical user data in public security reports.
