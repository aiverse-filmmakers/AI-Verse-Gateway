import { createServer } from "node:http";
import { GatewayError, asGatewayError } from "./errors.mjs";
import { bearer } from "./auth.mjs";
import { GatewayStore } from "./store.mjs";
import { RunEngine } from "./run-engine.mjs";
import { id, nowIso, sleep, stableStringify } from "./util.mjs";
import { VERSION } from "./constants.mjs";

export async function startServer(config, home, options = {}) {
  if (config.enabled !== true) throw new GatewayError("GATEWAY_DISABLED", "Gateway is disabled", 503);
  const store = new GatewayStore(home); await store.init(); await store.recoverInterrupted();
  const engine = new RunEngine({ store, config });
  // Completed runs are already canonical before optional Memory digest handoff.
  // Retry any durable pending/retryable handoff without reopening the run.
  void engine.recoverPendingSessionDigests();
  // Invisible organization review is post-completion work. Resume durable pending
  // proposals without reopening the foreground run or conversation.
  void engine.recoverPendingOrganizationReviews();
  const limiter = new RateLimiter(config.server.requests_per_minute);
  const server = createServer((req, res) => void handle(req, res, { config, store, engine, limiter }));
  const host = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && (!config.server.allow_remote || !config.server.behind_tls_proxy)) throw new GatewayError("REMOTE_BIND_UNSAFE", "Non-loopback serving requires configured remote access behind a trusted TLS proxy", 403);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { server, store, engine, host, port: typeof address === "object" && address ? address.port : port, close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}

async function handle(req, res, ctx) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, component: "ai-verse-gateway", version: VERSION });
    const origin = checkOrigin(req, ctx.config);
    if (req.method === "OPTIONS") return preflight(res, origin);
    const identity = bearer(req, ctx.config.auth.keys);
    ctx.limiter.take(identity.principal);
    if (req.method === "GET" && url.pathname === "/status") return json(res, 200, publicStatus(ctx.config));
    if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "aiverse", object: "model", created: 0, owned_by: "ai-verse", gateway_runtime: ctx.config.runtime.kind }] });
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJsonBody(req, ctx.config.server.max_body_bytes);
      return await chatCompletions(req, res, body, identity, ctx, origin);
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJsonBody(req, ctx.config.server.max_body_bytes);
      const run = await createRun(req, body, identity, ctx);
      return json(res, 202, sanitizeRun(run));
    }
    if (req.method === "POST" && url.pathname === "/v1/automations/invoke") {
      const body = await readJsonBody(req, ctx.config.server.max_body_bytes);
      return await automationWake(res, body, identity, ctx);
    }
    const match = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|cancel|pause|resume|approval))?$/);
    if (match) {
      const runId = match[1], action = match[2];
      if (!action && req.method === "GET") return json(res, 200, sanitizeRun(await ownedRun(ctx.store, runId, identity.principal)));
      if (action === "events" && req.method === "GET") { await ownedRun(ctx.store, runId, identity.principal); return sseRun(res, runId, ctx.store, origin); }
      if (["cancel", "pause", "resume", "approval"].includes(action) && req.method === "POST") {
        const body = await readJsonBody(req, ctx.config.server.max_body_bytes);
        return await controlRun(res, runId, action, body, identity, ctx);
      }
    }
    throw new GatewayError("NOT_FOUND", "Route not found", 404);
  } catch (error) { const e = asGatewayError(error); return json(res, e.status, { error: { code: e.code, message: e.message } }); }
}

async function chatCompletions(req, res, body, identity, ctx, origin) {
  validateMessages(body.messages);
  const run = await createRun(req, body, identity, ctx);
  if (body.stream === true) {
    res.writeHead(200, corsHeaders(origin, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }));
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const events = await ctx.store.listEvents(run.run_id);
    for (const event of events) if (event.type === "assistant.delta") send(openAIChunk(run, event.data.text));
    const unsubscribe = ctx.store.subscribe(run.run_id, (msg) => {
      if (msg.kind === "event" && msg.event.type === "assistant.delta") send(openAIChunk(run, msg.event.data.text));
      if (msg.kind === "event" && ["run.completed", "run.failed", "run.canceled", "run.blocked", "run.budget_limited", "approval.required", "run.parked", "run.no_progress"].includes(msg.event.type)) { send(openAIChunk(run, "", "stop")); res.write("data: [DONE]\n\n"); unsubscribe(); res.end(); }
    });
    req.on("close", () => { unsubscribe(); });
    return;
  }
  const done = await waitRun(ctx.store, run.run_id, Number(body.timeout_ms ?? 120000));
  if (done.status !== "completed") throw new GatewayError("RUN_NOT_COMPLETED", `Run stopped with status ${done.status}`, 409, done.error);
  return json(res, 200, { id: `chatcmpl-${done.run_id}`, object: "chat.completion", created: Math.floor(Date.now()/1000), model: body.model || "aiverse", choices: [{ index: 0, message: { role: "assistant", content: done.output?.content ?? "" }, finish_reason: "stop" }], usage: { prompt_tokens: done.usage.input_tokens, completion_tokens: done.usage.output_tokens, total_tokens: done.usage.input_tokens + done.usage.output_tokens } });
}

async function createRun(req, body, identity, ctx) {
  validateMessages(body.messages);
  const systemId = ctx.config.system.id;
  const requestedSessionId = body?.metadata?.session_id ?? req.headers["x-aiverse-session-id"] ?? null;
  const explicitWorkspace = body?.metadata?.workspace_id ?? req.headers["x-aiverse-workspace"] ?? null;
  let workspace;
  if (explicitWorkspace != null) {
    workspace = String(explicitWorkspace);
  } else if (requestedSessionId) {
    const existingSession = await ctx.store.getSession(String(requestedSessionId));
    if (existingSession) {
      if (existingSession.system_id !== systemId || existingSession.principal !== identity.principal) {
        throw new GatewayError("SESSION_BINDING_MISMATCH", "Existing session binding does not match the authenticated request", 409);
      }
      workspace = existingSession.workspace_id;
    } else {
      workspace = ctx.config.system.default_workspace;
    }
  } else {
    workspace = ctx.config.system.default_workspace;
  }
  workspace = String(workspace);
  if (!/^(operator|[a-z0-9][a-z0-9-]{0,127})$/.test(workspace)) throw new GatewayError("WORKSPACE_INVALID", "Invalid workspace binding");
  const payload = { system_id: systemId, workspace_id: workspace, requested_session_id: requestedSessionId, messages: body.messages, goal_id: body?.metadata?.goal_id ?? null, model: body.model ?? null };
  const idemKey = req.headers["idempotency-key"];
  const idem = await ctx.store.claimIdempotency("run", typeof idemKey === "string" ? idemKey : null, payload);
  if (idem.state === "replay" && idem.record.result?.run_id) {
    const replay = await ctx.store.getRun(idem.record.result.run_id);
    if (replay) return replay;
  }
  const session = await ctx.store.createSession({ system_id: systemId, workspace_id: workspace, principal: identity.principal, session_id: requestedSessionId });
  const limits = intersectBudget(ctx.config.limits, body?.metadata?.budget ?? {});
  const run = await ctx.store.createRun({ session_id: session.session_id, system_id: systemId, workspace_id: workspace, principal: identity.principal, runtime: { kind: ctx.config.runtime.kind, model: body.model ?? ctx.config.runtime.model ?? null }, messages: body.messages, goal_binding: payload.goal_id ? { goal_id: payload.goal_id } : null, max_turns: payload.goal_id ? limits.max_goal_continuation_turns : 1, budget: { max_tokens: limits.max_tokens, max_cost: limits.max_cost, max_actions: limits.max_actions }, deadline_at: new Date(Date.now() + limits.wall_clock_seconds * 1000).toISOString() });
  session.active_run_id = run.run_id; await ctx.store.saveSession(session);
  await ctx.store.commitIdempotency(idem.mapKey, { run_id: run.run_id });
  await ctx.engine.start(run.run_id);
  return run;
}

async function automationWake(res, body, identity, ctx) {
  const wake = validateAutomationWake(body);
  const idem = await ctx.store.claimIdempotency("automation_wake", wake.invocation_id, wake);
  if (idem.state === "replay" && idem.record.result?.run_id) {
    const replay = await ctx.store.getRun(idem.record.result.run_id);
    if (!replay) throw new GatewayError("AUTOMATION_WAKE_REPLAY_MISSING", "Automation wake replay points to a missing run", 409);
    return json(res, 200, {
      accepted: true,
      replayed: true,
      run_id: replay.run_id,
      status: replay.status,
      invocation_id: wake.invocation_id
    });
  }

  const workspace = wake.scope === "operator" ? "operator" : wake.scope.slice("workspace:".length);
  const systemId = ctx.config.system.id;
  const session = await ctx.store.createSession({
    system_id: systemId,
    workspace_id: workspace,
    principal: identity.principal,
    title: `Scheduled: ${String(wake.payload.objective).slice(0, 160)}`
  });
  const limits = intersectBudget(ctx.config.limits, {});
  const run = await ctx.store.createRun({
    session_id: session.session_id,
    system_id: systemId,
    workspace_id: workspace,
    principal: identity.principal,
    runtime: {
      kind: ctx.config.runtime.kind,
      model: ctx.config.runtime.model ?? null
    },
    messages: [{
      role: "user",
      content: wake.payload.objective,
      _gateway_automation_wake: true
    }],
    goal_binding: null,
    automation_binding: {
      automation_id: wake.automation_id,
      trigger_id: wake.trigger_id,
      invocation_id: wake.invocation_id,
      source_kind: wake.source_kind,
      fired_at: wake.fired_at,
      scheduled_for: wake.scheduled_for ?? null
    },
    max_turns: 1,
    budget: {
      max_tokens: limits.max_tokens,
      max_cost: limits.max_cost,
      max_actions: limits.max_actions
    },
    deadline_at: new Date(Date.now() + limits.wall_clock_seconds * 1000).toISOString()
  });
  session.active_run_id = run.run_id;
  await ctx.store.saveSession(session);
  await ctx.store.commitIdempotency(idem.mapKey, { run_id: run.run_id });
  await ctx.store.audit({
    principal: identity.principal,
    action: "automation.wake.accepted",
    run_id: run.run_id,
    request: {
      automation_id: wake.automation_id,
      trigger_id: wake.trigger_id,
      invocation_id: wake.invocation_id,
      scope: wake.scope,
      source_kind: wake.source_kind
    },
    outcome: { status: "accepted" }
  });
  await ctx.engine.start(run.run_id);
  return json(res, 202, {
    accepted: true,
    replayed: false,
    run_id: run.run_id,
    status: run.status,
    invocation_id: wake.invocation_id
  });
}

function validateAutomationWake(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake must be an object", 400);
  }
  const allowed = new Set([
    "schema_version", "automation_id", "trigger_id", "invocation_id", "scope",
    "fired_at", "source_kind", "target_kind", "target_ref", "payload",
    "scheduled_for", "event", "event_source", "event_type"
  ]);
  const extra = Object.keys(body).filter((key) => !allowed.has(key));
  if (extra.length) throw new GatewayError("AUTOMATION_WAKE_INVALID", `Automation wake has unsupported fields: ${extra.join(", ")}`, 400);
  if (body.schema_version !== "1.0") throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake schema_version must be 1.0", 400);
  for (const key of ["automation_id", "trigger_id", "invocation_id"]) {
    if (typeof body[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body[key])) {
      throw new GatewayError("AUTOMATION_WAKE_INVALID", `Automation wake ${key} is invalid`, 400);
    }
  }
  if (typeof body.scope !== "string" || !/^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$/.test(body.scope)) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake scope is invalid", 400);
  }
  if (body.target_kind !== "gateway" || body.target_ref != null) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake is not bound to this Gateway target", 400);
  }
  if (!["schedule", "manual", "event", "webhook"].includes(body.source_kind)) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake source_kind is invalid", 400);
  }
  for (const key of ["fired_at", ...(body.scheduled_for == null ? [] : ["scheduled_for"])]) {
    if (typeof body[key] !== "string" || !Number.isFinite(Date.parse(body[key]))) {
      throw new GatewayError("AUTOMATION_WAKE_INVALID", `Automation wake ${key} is invalid`, 400);
    }
  }
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake payload must be an object", 400);
  }
  const objective = body.payload.objective;
  if (typeof objective !== "string" || !objective.trim() || objective.trim().length > 4000 || secretLikeWake(objective)) {
    throw new GatewayError("AUTOMATION_WAKE_INVALID", "Automation wake objective is invalid", 400);
  }
  return {
    ...body,
    payload: {
      ...body.payload,
      objective: objective.trim()
    }
  };
}

function secretLikeWake(value) {
  const text = String(value ?? "");
  return [
    /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\s*[:=]\s*[^\s,;]{6,}/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ].some((pattern) => pattern.test(text));
}

async function controlRun(res, runId, action, body, identity, ctx) {
  const operationId = String(body.operation_id ?? id("op"));
  const payload = { run_id: runId, action, operation_id: operationId, decision: body.decision ?? null, reason: body.reason ?? null };
  const idem = await ctx.store.claimIdempotency(`control:${runId}`, operationId, payload);
  if (idem.state === "replay") return json(res, 200, sanitizeRun(await ownedRun(ctx.store, runId, identity.principal)));
  let run;
  if (action === "cancel") run = await ctx.engine.cancel(runId, body.reason ?? "operator_cancel", identity.principal);
  if (action === "pause") run = await ctx.engine.pause(runId, identity.principal, body.reason ?? "operator_pause");
  if (action === "resume") run = await ctx.engine.resume(runId, identity.principal);
  if (action === "approval") run = await ctx.engine.approve(runId, identity.principal, body.decision === "approve" ? "approve" : "deny", operationId);
  await ctx.store.audit({ principal: identity.principal, action: `run.${action}`, run_id: runId, request: payload, outcome: { status: run.status } });
  await ctx.store.commitIdempotency(idem.mapKey, { status: run.status });
  return json(res, 200, sanitizeRun(run));
}

async function sseRun(res, runId, store, origin) {
  res.writeHead(200, corsHeaders(origin, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }));
  for (const event of await store.listEvents(runId)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = store.subscribe(runId, (msg) => { if (msg.kind === "event") res.write(`event: ${msg.event.type}\ndata: ${JSON.stringify(msg.event)}\n\n`); });
  res.on("close", unsubscribe);
}
function openAIChunk(run, content, finishReason = null) { return { id: `chatcmpl-${run.run_id}`, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: run.runtime?.model ?? "aiverse", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }] }; }
async function ownedRun(store, runId, principal) { const run = await store.getRun(runId); if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404); if (run.principal !== principal) throw new GatewayError("FORBIDDEN", "Principal does not own this run", 403); return run; }
async function waitRun(store, runId, timeoutMs) { const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 10 * 60 * 1000); while (Date.now() < deadline) { const run = await store.getRun(runId); if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404); if (!["queued", "running", "resuming", "waiting_tool"].includes(run.status)) return run; await sleep(20); } throw new GatewayError("CLIENT_WAIT_TIMEOUT", "Timed out waiting for run", 504); }
function validateMessages(messages) { if (!Array.isArray(messages) || messages.length < 1 || messages.length > 200) throw new GatewayError("MESSAGES_INVALID", "messages must contain 1 to 200 items"); for (const m of messages) if (!m || !["system","user","assistant","tool"].includes(m.role) || !(typeof m.content === "string" || m.content === null)) throw new GatewayError("MESSAGES_INVALID", "Each message needs a supported role and string/null content"); }
async function readJsonBody(req, limit) { const chunks=[]; let size=0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new GatewayError("BODY_TOO_LARGE", `Request body exceeds ${limit} bytes`, 413); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new GatewayError("INVALID_JSON", "Request body is not valid JSON"); } }
function checkOrigin(req, config) { const origin=req.headers.origin; if (!origin) return null; if (!config.server.allowed_origins.includes(origin)) throw new GatewayError("ORIGIN_FORBIDDEN", "Browser origin is not allowed", 403); return origin; }
function corsHeaders(origin, extra={}) { return { ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}), ...extra }; }
function preflight(res, origin) { res.writeHead(204, corsHeaders(origin, { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,idempotency-key,x-aiverse-session-id,x-aiverse-workspace", "access-control-max-age": "600" })); res.end(); }
function json(res, status, body) { if (res.writableEnded) return; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function publicStatus(config) { return { component: "ai-verse-gateway", version: VERSION, state: config.enabled ? "ready" : "disabled", system_id: config.system.id, runtime: config.runtime.kind, binding: config.server.host, remote: config.server.allow_remote === true, goal_owner_configured: Boolean(config.goal_owner_config), at: nowIso() }; }
function sanitizeRun(run) { if (!run) return run; const { messages, ...publicRun } = run; return publicRun; }
function intersectBudget(base, requested) { const min = (key, fallback) => { const a=base[key], b=requested[key]; if (typeof a === "number" && typeof b === "number") return Math.min(a,b); if (typeof a === "number") return a; if (typeof b === "number") return b; return fallback; }; return { max_goal_continuation_turns: min("max_goal_continuation_turns",20), no_progress_threshold: min("no_progress_threshold",2), wall_clock_seconds: min("wall_clock_seconds",120), max_actions: min("max_actions",16), max_tokens: min("max_tokens",null), max_cost: min("max_cost",null) }; }
class RateLimiter { constructor(limit){this.limit=limit;this.map=new Map();} take(principal){const minute=Math.floor(Date.now()/60000);const key=`${principal}:${minute}`;const count=(this.map.get(key)??0)+1;this.map.set(key,count);if(count>this.limit)throw new GatewayError("RATE_LIMITED","Request rate limit exceeded",429);if(this.map.size>1000)for(const k of this.map.keys())if(!k.endsWith(`:${minute}`))this.map.delete(k);} }
