import { createHash } from "node:crypto";
import { GatewayError, asGatewayError } from "./errors.mjs";
import { RuntimeRegistry } from "./runtime.mjs";
import { HostClient } from "./host-adapter.mjs";
import { GoalOwnerClient } from "./goal-owner.mjs";
import { nowIso, stableStringify } from "./util.mjs";

const USER_INTERACTION_POLICY = `User interaction law:
- Do the user's requested work before asking optional setup or architecture questions.
- Reuse known canonical context instead of asking for information that is already available.
- Do not ask the user to choose internal architecture such as Memory vs Data vs Skill vs Workspace, component ownership, canonical stores, or worker topology.
- When an internal choice is safe, reversible, inside current authorized scope, and creates no new commitment or authority, act instead of asking.
- Ask only when missing information materially blocks safety, privacy/scope, permission, external access, a consequential external effect, correct routing, or an owner-required approval.
- A new recurring responsibility, durable Bot, credential or Connection, broader permission/scope, strategic authority handover, or destructive/irreversible change requires the corresponding explicit authority or approval.
- If the user directly requested an action or recurring responsibility, that request is already intent/consent for that requested work; do not ask a redundant technical confirmation unless another owner/security boundary requires it.
- Use natural outcome language for normal users. Keep component jargon in technical receipts or advanced inspection only.
Deterministic host authorization and owner security rules remain stronger than these runtime instructions.

Workspace organization:
- If current work plus canonical context provides strong evidence of a substantial durable client, project, case, practice, team, or personal area that should stay isolated, you may organize it automatically through the existing aiverse_action tool.
- Do not create a workspace for a trivial one-off task. Reuse an existing matching scope when the evidence points to one.
- Only request automatic organization when the boundary is clear, privacy is not materially ambiguous, and no new permission, credential, Connection, external effect, recurring responsibility, or strategic authority transfer is needed.
- Use action_class "write_local_reversible", operation "workspace.ensure", with parameters containing:
  workspace: { id, name, type, purpose, domains, canonical_sources }
  evidence: { substantial_scope: true, boundary_clear: true, reason }
  authority: { permission_expansion: false, privacy_ambiguous: false, new_connection: false, new_credential: false }
- Do not invent source references. Omit unknown optional arrays or use empty arrays.
- If a real privacy or scope boundary is ambiguous, ask only the natural question needed to resolve that boundary instead of making the workspace mutation.
- After successful internal organization, continue the user's work and use natural outcome language if mentioning it. Do not expose OS schema or component jargon.

Historical Memory capture:
- Do not persist every turn. Only consider capture when the work produced or clearly revealed a high-confidence durable historical fact, preference, entity, event, experience, workflow, lesson, or correction that is likely to matter later.
- Never use automatic Memory capture for current state, current constraints, decisions, strategic direction, credentials/secrets, ambiguous private material, permission changes, or uncertain information.
- Prefer no capture for greetings, brainstorming fragments, transient task details, already-known context, or weak evidence.
- Use action_class "write_local_reversible", operation "memory.capture".
- The parameters must contain only the historical candidate fields Memory needs: text, type, optional importance/confidence/why/tags, and admission.
- Set admission.durable=true and admission.historical=true only when strongly supported by the completed work/evidence.
- Set admission.current_truth=false, contains_secret=false, strategic=false, permission_expansion=false, privacy_ambiguous=false, external_authority=false only when each statement is actually supported. If any boundary is uncertain, do not call memory.capture.
- Do not provide source, evidence_refs, effect_id, scope, or workspace. Gateway supplies trusted run provenance/retry identity and OS binds scope before Memory admission.
- After successful capture, continue normally. Do not announce internal Memory mechanics unless advanced inspection was requested.`;

const ACTION_TOOL = {
  type: "function",
  function: {
    name: "aiverse_action",
    description: "Request an AI-Verse host action through owner authorization and execution boundaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action_class", "operation", "parameters"],
      properties: {
        action_class: { type: "string" },
        operation: { type: "string" },
        parameters: { type: "object" },
        reason: { type: "string" }
      }
    }
  }
};

export class RunEngine {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.host = new HostClient(config.host_adapter_config);
    this.goalOwner = new GoalOwnerClient(config.goal_owner_config);
    this.runtime = new RuntimeRegistry(config.runtime);
    this.controllers = new Map();
    this.sessionActive = new Map();
  }
  async start(runId) {
    const run = await this.store.getRun(runId);
    if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404);
    const prior = this.sessionActive.get(run.session_id);
    if (prior && prior !== runId) await this.cancel(prior, "user_preempted", run.principal);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.sessionActive.set(run.session_id, runId);
    void this.execute(runId, controller.signal).finally(() => {
      this.controllers.delete(runId);
      if (this.sessionActive.get(run.session_id) === runId) this.sessionActive.delete(run.session_id);
    });
  }
  async execute(runId, signal) {
    let run = await this.store.getRun(runId);
    try {
      if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404);
      if (run.status === "canceled") return;
      run.status = run.status === "paused_recovery_required" ? "resuming" : "running";
      await this.store.saveRun(run);
      await this.store.event(runId, "run.started", { status: run.status });
      const scope = run.workspace_id === "operator" ? "operator" : `workspace:${run.workspace_id}`;
      if (run.goal_binding?.goal_id && !Number.isInteger(run.goal_binding.version)) run.goal_binding = await this.initialGoalBinding(run.goal_binding.goal_id, scope, signal);
      const context = await this.assembleContext(run, scope, signal);
      if (context.system_message && !run.messages.some((m) => m.role === "system" && m._gateway_context === true)) {
        run.messages.unshift({ role: "system", content: context.system_message, _gateway_context: true });
      }
      await this.store.saveRun(run);

      while (true) {
        run = await this.store.getRun(runId);
        if (!run || run.status === "canceled") return;
        if (signal.aborted) throw signal.reason ?? new GatewayError("RUN_CANCELED", "Run canceled", 409);
        this.assertDeadline(run);
        this.assertBudgetBeforeTurn(run);
        if (run.goal_binding) await this.revalidateGoal(run, scope, signal);
        run.continuation.turn += 1;
        run.checkpoint = { phase: "before_runtime", turn: run.continuation.turn, at: nowIso() };
        await this.store.saveRun(run);
        await this.store.event(runId, "run.turn.started", { turn: run.continuation.turn });

        const result = await this.runtime.invoke({ run_id: runId, model: run.runtime?.model, messages: stripInternal(run.messages), tools: [ACTION_TOOL] }, signal);
        addUsage(run.usage, result.usage);
        this.assertBudgetAfterUsage(run);
        const assistant = { role: "assistant", content: result.content ?? "" };
        if (Array.isArray(result.tool_calls) && result.tool_calls.length) assistant.tool_calls = result.tool_calls;
        run.messages.push(assistant);
        if (assistant.content) await this.emitText(runId, assistant.content);
        await this.store.saveRun(run);

        if (assistant.tool_calls?.length) {
          // Tool rounds are part of the current admitted turn. They do not consume
          // an autonomous Goal continuation turn by themselves.
          run.continuation.turn = Math.max(0, run.continuation.turn - 1);
          await this.store.saveRun(run);
          const toolOutcome = await this.handleToolCalls(run, assistant.tool_calls, scope, signal);
          if (toolOutcome === "approval") return;
          continue;
        }

        const fingerprint = progressFingerprint({ content: assistant.content, finish_reason: result.finish_reason });
        const fps = run.continuation.fingerprints;
        run.continuation.no_progress_count = fps.at(-1) === fingerprint ? run.continuation.no_progress_count + 1 : 0;
        fps.push(fingerprint);
        if (fps.length > 8) fps.shift();
        if (run.continuation.no_progress_count >= this.config.limits.no_progress_threshold) {
          run.status = "paused_no_progress";
          run.checkpoint = { phase: "no_progress", turn: run.continuation.turn, at: nowIso() };
          await this.store.saveRun(run);
          await this.store.event(runId, "run.no_progress", { threshold: this.config.limits.no_progress_threshold });
          return;
        }

        if (!run.goal_binding) {
          await this.complete(run, assistant.content);
          return;
        }

        const verdict = await this.goalOwner.evaluate(run.goal_binding.goal_id, scope, run.goal_binding.version, {
          run_id: runId,
          turn: run.continuation.turn,
          output: assistant.content,
          usage: run.usage,
          checkpoint: run.checkpoint
        }, signal);
        await this.store.event(runId, "goal.evaluated", { verdict: verdict?.verdict, goal_id: run.goal_binding.goal_id, goal_version: verdict?.goal_version ?? run.goal_binding.version });
        if (Number.isInteger(verdict?.goal_version)) run.goal_binding.version = verdict.goal_version;
        switch (verdict?.verdict) {
          case "continue":
            if (run.continuation.turn >= run.continuation.max_turns) { run.status = "budget_limited"; await this.store.saveRun(run); await this.store.event(runId, "run.budget_limited", { kind: "turns" }); return; }
            run.messages.push({ role: "user", content: continuationPrompt(verdict), _gateway_continuation: true });
            await this.store.saveRun(run);
            continue;
          case "complete": await this.complete(run, assistant.content); return;
          case "blocked": run.status = "blocked"; run.output = { content: assistant.content, goal_verdict: verdict }; await this.store.saveRun(run); await this.store.event(runId, "run.blocked", { reason: verdict?.reason ?? null }); return;
          case "wait": run.status = "parked"; run.output = { content: assistant.content, goal_verdict: verdict }; run.checkpoint = { phase: "parked", wait_hint: verdict?.wait_hint ?? null, at: nowIso() }; await this.store.saveRun(run); await this.store.event(runId, "run.parked", { wait_hint: verdict?.wait_hint ?? null }); return;
          default: throw new GatewayError("GOAL_VERDICT_INVALID", "Brain Goal owner returned an invalid verdict", 502);
        }
      }
    } catch (error) {
      const e = asGatewayError(error);
      run = await this.store.getRun(runId);
      if (!run || run.status === "canceled" || run.status === "paused") return;
      run.error = { code: e.code, message: e.message };
      if (["TURN_BUDGET_EXCEEDED", "TOKEN_BUDGET_EXCEEDED", "COST_BUDGET_EXCEEDED", "ACTION_BUDGET_EXCEEDED", "DEADLINE_EXCEEDED"].includes(e.code)) {
        run.status = "budget_limited";
        run.completed_at = nowIso();
        await this.store.saveRun(run);
        await this.store.event(runId, "run.budget_limited", { kind: e.code, message: e.message });
        return;
      }
      if (e.code === "GOAL_LEASE_REVOKED") {
        run.status = "paused";
        run.checkpoint = { phase: "goal_lease_revoked", at: nowIso() };
        await this.store.saveRun(run);
        await this.store.event(runId, "goal.lease_revoked", run.error);
        return;
      }
      run.status = e.code === "RUN_CANCELED" ? "canceled" : "failed";
      run.completed_at = nowIso();
      await this.store.saveRun(run);
      await this.store.event(runId, "run.failed", run.error);
    }
  }
  async assembleContext(run, scope, signal) {
    const [description, current, history, capabilities, connections] = await Promise.all([
      this.host.describe(signal),
      this.host.readContext(scope, signal),
      this.host.retrieveHistory(lastUserText(run.messages), scope, signal),
      this.host.listCapabilities(scope, signal),
      this.host.listConnections(scope, signal)
    ]);
    const safe = { host: { adapter_id: description?.adapter_id, metadata: description?.metadata }, current_context: current, recalled_history: history, capabilities, connections };
    return { system_message: `You are running through AI-Verse Gateway. Canonical owner context follows. Treat it as bounded context, not permission. Use aiverse_action for side effects.\n\n${USER_INTERACTION_POLICY}\n\nCanonical owner context:\n${JSON.stringify(safe)}` };
  }
  async handleToolCalls(run, toolCalls, scope, signal) {
    for (const call of toolCalls) {
      if (call?.function?.name !== "aiverse_action") throw new GatewayError("TOOL_NOT_ADMITTED", `Tool ${call?.function?.name ?? "unknown"} is not admitted`, 403);
      let args;
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { throw new GatewayError("TOOL_ARGS_INVALID", "Tool arguments are invalid JSON"); }
      let parameters = args.parameters ?? {};
      if (args.operation === "workspace.ensure") {
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new GatewayError("TOOL_ARGS_INVALID", "workspace.ensure parameters must be an object");
        parameters = {
          ...parameters,
          provenance: {
            trigger_ref: `run:${run.run_id}`,
            classifier: "gateway-runtime",
            source: "gateway"
          }
        };
      }
      if (args.operation === "memory.capture") {
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new GatewayError("TOOL_ARGS_INVALID", "memory.capture parameters must be an object");
        const forbidden = ["source", "evidence_refs", "effect_id", "scope", "workspace"];
        const suppliedForbidden = forbidden.filter((key) => Object.hasOwn(parameters, key));
        if (suppliedForbidden.length) throw new GatewayError("TOOL_ARGS_INVALID", `memory.capture runtime parameters may not supply trusted fields: ${suppliedForbidden.join(", ")}`);
        parameters = {
          ...parameters,
          source: `gateway-run:${run.run_id}`,
          evidence_refs: [`run:${run.run_id}`, `session:${run.session_id}`],
          effect_id: `gateway:${run.run_id}:${call.id}:memory.capture`
        };
      }
      const request = {
        action_class: args.action_class,
        scope,
        operation: args.operation,
        parameters,
        idempotency_key: `${run.run_id}:${call.id}`,
        in_scope: true,
        within_budget: true,
        reversible: args.action_class === "write_local_reversible",
        reason: args.reason ?? "Runtime requested action through Gateway"
      };
      request.request_fingerprint = actionFingerprint(request);
      const authorization = await this.host.authorizeAction(request, signal);
      await this.store.event(run.run_id, "tool.authorized", { tool_call_id: call.id, decision: summarizeDecision(authorization) });
      if (isDenied(authorization)) throw new GatewayError("ACTION_DENIED", "OS host denied the requested action", 403);
      if (needsApproval(authorization)) {
        run.status = "awaiting_approval";
        run.pending_approval = { tool_call_id: call.id, request, authorization, created_at: nowIso() };
        run.checkpoint = { phase: "awaiting_approval", tool_call_id: call.id, at: nowIso() };
        await this.store.saveRun(run);
        await this.store.event(run.run_id, "approval.required", { tool_call_id: call.id, operation: request.operation, action_class: request.action_class });
        return "approval";
      }
      const result = await this.host.requestAction(request, signal);
      run.usage.actions += 1;
      this.assertBudgetAfterUsage(run);
      if (request.operation === "workspace.ensure") await this.applyWorkspaceOrganization(run, scope, result);
      run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      await this.store.event(run.run_id, "tool.completed", { tool_call_id: call.id, operation: request.operation, status: result?.status ?? null });
      await this.store.saveRun(run);
    }
    return "done";
  }
  async applyWorkspaceOrganization(run, scope, result) {
    const organized = result?.result?.workspace_organization;
    if (!organized || !["created", "evolved", "existing"].includes(organized.state)) return;
    const workspaceId = organized?.workspace?.id;
    if (typeof workspaceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(workspaceId)) throw new GatewayError("WORKSPACE_OWNER_RESULT_INVALID", "OS workspace owner returned an invalid workspace binding", 502);
    const currentWorkspace = scope === "operator" ? "operator" : scope.slice("workspace:".length);
    if (currentWorkspace !== "operator" && currentWorkspace !== workspaceId) throw new GatewayError("WORKSPACE_SCOPE_CONFLICT", "OS workspace result conflicts with the run's bound workspace", 409);

    const session = await this.store.getSession(run.session_id);
    if (!session) throw new GatewayError("SESSION_NOT_FOUND", "Run session is missing", 409);
    if (session.system_id !== run.system_id || session.principal !== run.principal || session.workspace_id !== run.workspace_id) {
      throw new GatewayError("SESSION_BINDING_MISMATCH", "Session changed while workspace organization was being applied", 409);
    }
    if (session.workspace_id === workspaceId) return;

    session.workspace_id = workspaceId;
    await this.store.saveSession(session);
    await this.store.event(run.run_id, "workspace.bound", {
      workspace_id: workspaceId,
      owner_state: organized.state,
      applies_to: "subsequent_session_runs"
    });
  }
  async approve(runId, principal, decision, operationId) {
    const run = await this.store.getRun(runId);
    if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404);
    if (run.principal !== principal) throw new GatewayError("FORBIDDEN", "Principal does not own this run", 403);
    if (run.status !== "awaiting_approval" || !run.pending_approval) throw new GatewayError("APPROVAL_NOT_PENDING", "Run has no pending approval", 409);
    const idem = await this.store.claimIdempotency(`approval:${runId}`, operationId, { decision, tool_call_id: run.pending_approval.tool_call_id });
    if (idem.state === "replay") return await this.store.getRun(runId);
    if (decision !== "approve") {
      run.status = "canceled"; run.error = { code: "APPROVAL_DENIED", message: "Operator denied the pending action" }; run.pending_approval = null; run.completed_at = nowIso();
      await this.store.saveRun(run); await this.store.event(runId, "approval.denied", {}); await this.store.commitIdempotency(idem.mapKey, { status: run.status }); return run;
    }
    const pending = run.pending_approval;
    if (run.goal_binding) {
      const scope = run.workspace_id === "operator" ? "operator" : `workspace:${run.workspace_id}`;
      await this.revalidateGoal(run, scope);
    }
    const authorization = await this.host.authorizeAction({ ...pending.request, approval: { principal, operation_id: operationId } });
    if (isDenied(authorization)) throw new GatewayError("ACTION_DENIED", "OS host denied action during approval recheck", 403);
    if (needsApproval(authorization)) throw new GatewayError("APPROVAL_NOT_ACCEPTED", "OS host still requires approval after the explicit grant; action was not executed", 409);
    const result = await this.host.requestAction({ ...pending.request, approval: { principal, operation_id: operationId } });
    run.usage.actions += 1;
    run.messages.push({ role: "tool", tool_call_id: pending.tool_call_id, content: JSON.stringify(result) });
    run.pending_approval = null; run.status = "resuming"; run.checkpoint = { phase: "after_approval", at: nowIso() };
    await this.store.saveRun(run); await this.store.event(runId, "approval.applied", { tool_call_id: pending.tool_call_id }); await this.store.commitIdempotency(idem.mapKey, { status: run.status });
    await this.start(runId); return run;
  }
  async pause(runId, principal, reason = "operator_pause") { const run = await this.ownedRun(runId, principal); run.status = "paused"; run.checkpoint = { phase: "paused", reason, at: nowIso() }; await this.store.saveRun(run); await this.store.event(runId, "run.paused", { reason }); this.controllers.get(runId)?.abort(new GatewayError("RUN_CANCELED", reason, 409)); return run; }
  async resume(runId, principal) { const run = await this.ownedRun(runId, principal); if (!["paused", "paused_recovery_required", "paused_no_progress", "parked"].includes(run.status)) throw new GatewayError("RUN_NOT_RESUMABLE", `Run status ${run.status} is not resumable`, 409); run.status = "resuming"; await this.store.saveRun(run); await this.store.event(runId, "run.resumed", {}); await this.start(runId); return run; }
  async cancel(runId, reason = "operator_cancel", principal = null) { const run = await this.store.getRun(runId); if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404); if (principal && run.principal !== principal) throw new GatewayError("FORBIDDEN", "Principal does not own this run", 403); if (run.status === "canceled" || run.status === "completed") return run; run.status = "canceled"; run.error = { code: "RUN_CANCELED", message: reason }; run.completed_at = nowIso(); await this.store.saveRun(run); await this.store.event(runId, "run.canceled", { reason }); this.controllers.get(runId)?.abort(new GatewayError("RUN_CANCELED", reason, 409)); return run; }
  async ownedRun(runId, principal) { const run = await this.store.getRun(runId); if (!run) throw new GatewayError("RUN_NOT_FOUND", "Run not found", 404); if (run.principal !== principal) throw new GatewayError("FORBIDDEN", "Principal does not own this run", 403); return run; }
  async initialGoalBinding(goalId, scope, signal) { const owner = await this.goalOwner.get(goalId, scope, signal); const goal = owner?.goal ?? owner; if (!goal || goal.goal_id !== goalId || goal.status !== "active") throw new GatewayError("GOAL_NOT_ACTIVE", "Brain Goal is missing or not active", 409); return { goal_id: goalId, version: goal.version, activation_epoch: goal.activation_epoch ?? 1 }; }
  async revalidateGoal(run, scope, signal) { const prior = run.goal_binding; const current = await this.initialGoalBinding(prior.goal_id, scope, signal); if (current.goal_id !== prior.goal_id || current.version !== prior.version || current.activation_epoch !== prior.activation_epoch) throw new GatewayError("GOAL_LEASE_REVOKED", "Brain Goal binding changed; autonomous continuation lease is revoked", 409); }
  assertDeadline(run) { if (run.deadline_at && Date.now() >= Date.parse(run.deadline_at)) throw new GatewayError("DEADLINE_EXCEEDED", "Run deadline exceeded", 409); }
  assertBudgetBeforeTurn(run) { if (run.continuation.turn >= run.continuation.max_turns) throw new GatewayError("TURN_BUDGET_EXCEEDED", "Run turn budget exhausted", 409); }
  assertBudgetAfterUsage(run) { const b = run.budget ?? {}; const tokens = Number(run.usage.input_tokens ?? 0) + Number(run.usage.output_tokens ?? 0); if (Number.isFinite(b.max_tokens) && b.max_tokens !== null && tokens > b.max_tokens) throw new GatewayError("TOKEN_BUDGET_EXCEEDED", "Token budget exceeded", 409); if (Number.isFinite(b.max_cost) && b.max_cost !== null && run.usage.cost > b.max_cost) throw new GatewayError("COST_BUDGET_EXCEEDED", "Cost budget exceeded", 409); if (Number.isFinite(b.max_actions) && run.usage.actions > b.max_actions) throw new GatewayError("ACTION_BUDGET_EXCEEDED", "Action budget exceeded", 409); }
  async emitText(runId, text) { for (let i = 0; i < text.length; i += 256) await this.store.event(runId, "assistant.delta", { text: text.slice(i, i + 256) }); }
  async complete(run, content) {
    run.status = "completed";
    run.output = { content };
    run.completed_at = nowIso();
    run.checkpoint = { phase: "completed", at: run.completed_at };
    const digest = completedSessionDigest(run, content);
    if (digest) {
      const priorAttempts = Number(run.memory_digest?.attempts ?? 0);
      run.memory_digest = {
        status: "pending",
        attempts: priorAttempts,
        updated_at: run.completed_at,
        last_error: null
      };
    } else {
      run.memory_digest = {
        status: "skipped",
        reason: "completed run did not meet the conservative meaningful-session threshold",
        attempts: Number(run.memory_digest?.attempts ?? 0),
        updated_at: run.completed_at
      };
    }
    await this.store.saveRun(run);
    await this.store.event(run.run_id, "run.completed", { usage: run.usage });
    if (digest) await this.handoffCompletedSessionDigest(run, digest);
  }
  async handoffCompletedSessionDigest(run, prepared = null) {
    const digest = prepared ?? completedSessionDigest(run, run.output?.content ?? "");
    if (!digest) return null;
    const scope = run.workspace_id === "operator" ? "operator" : `workspace:${run.workspace_id}`;
    const request = {
      action_class: "write_local_reversible",
      scope,
      operation: "memory.session_digest",
      parameters: digest,
      idempotency_key: `gateway:${run.run_id}:session-digest`,
      in_scope: true,
      within_budget: true,
      reversible: true,
      reason: "Persist a compact completed-session digest through the Memory owner."
    };
    request.request_fingerprint = actionFingerprint(request);
    const attempts = Number(run.memory_digest?.attempts ?? 0) + 1;
    try {
      const authorization = await this.host.authorizeAction(request);
      if (isDenied(authorization)) throw new GatewayError("SESSION_DIGEST_DENIED", "OS host denied the completed-session Memory digest", 403);
      if (needsApproval(authorization)) throw new GatewayError("SESSION_DIGEST_APPROVAL_REQUIRED", "OS host requires approval for the completed-session Memory digest", 409);
      const result = await this.host.requestAction(request);
      const owner = result?.result?.memory_session_digest;
      if (result?.status !== "succeeded" || !owner || !["captured", "existing"].includes(owner.state)) {
        throw new GatewayError("SESSION_DIGEST_OWNER_REJECTED", "Memory owner did not accept the completed-session digest", 502);
      }
      const fresh = await this.store.getRun(run.run_id);
      if (!fresh) return owner;
      fresh.memory_digest = {
        status: owner.state,
        digest_id: owner.digest_id ?? null,
        attempts,
        updated_at: nowIso(),
        last_error: null
      };
      await this.store.saveRun(fresh);
      await this.store.event(run.run_id, "memory.session_digest.completed", {
        state: owner.state,
        digest_id: owner.digest_id ?? null,
        attempt: attempts
      });
      return owner;
    } catch (error) {
      const e = asGatewayError(error);
      const fresh = await this.store.getRun(run.run_id);
      if (fresh) {
        fresh.memory_digest = {
          status: "retryable",
          attempts,
          updated_at: nowIso(),
          last_error: { code: e.code, message: e.message }
        };
        await this.store.saveRun(fresh);
      }
      await this.store.event(run.run_id, "memory.session_digest.failed", {
        code: e.code,
        message: e.message,
        attempt: attempts
      });
      return null;
    }
  }
  async recoverPendingSessionDigests() {
    const runs = await this.store.pendingSessionDigestRuns();
    for (const run of runs) await this.handoffCompletedSessionDigest(run);
    return runs.map((run) => run.run_id);
  }
}

function compactText(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}
function completedSessionDigest(run, content) {
  const userMessages = (run.messages ?? []).filter((m) =>
    m?.role === "user" &&
    m?._gateway_continuation !== true &&
    typeof m?.content === "string" &&
    m.content.trim()
  );
  const lastUser = compactText(userMessages.at(-1)?.content ?? "", 900);
  const outcome = compactText(content, 3200);
  const meaningful =
    lastUser.length >= 12 &&
    outcome.length >= 24 &&
    (
      lastUser.length + outcome.length >= 80 ||
      Number(run.usage?.actions ?? 0) > 0 ||
      Boolean(run.goal_binding) ||
      userMessages.length > 1
    );
  if (!meaningful) return null;

  const publicMessages = stripInternal(run.messages ?? []);
  const lastIndex = Math.max(0, publicMessages.length - 1);
  return {
    session_id: run.session_id,
    run_id: run.run_id,
    topic: compactText(lastUser, 240),
    summary: `Request: ${compactText(lastUser, 800)}\nOutcome: ${outcome}`,
    significant_outcomes: [],
    unresolved_items: [],
    source_coverage: [`gateway:run:${run.run_id}:messages:0-${lastIndex}`],
    source_fingerprint: "sha256:" + createHash("sha256").update(stableStringify(publicMessages)).digest("hex"),
    completed_at: run.completed_at ?? nowIso()
  };
}
function stripInternal(messages) { return messages.map(({ _gateway_context, _gateway_continuation, ...m }) => m); }
function lastUserText(messages) { const m = [...messages].reverse().find((x) => x.role === "user"); return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""); }
function addUsage(target, usage = {}) { target.input_tokens += Number(usage.input_tokens ?? 0); target.output_tokens += Number(usage.output_tokens ?? 0); target.cost += Number(usage.cost ?? 0); }
function progressFingerprint(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function actionFingerprint(request) {
  const { request_fingerprint, ...material } = request;
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}
function summarizeDecision(x) { return x?.decision ?? x?.status ?? (x?.allowed === true ? "allow" : x?.allowed === false ? "deny" : "unknown"); }
function isDenied(x) { return x?.allowed === false || ["deny", "denied", "forbidden"].includes(String(x?.decision ?? x?.status ?? "").toLowerCase()); }
function needsApproval(x) { return x?.approval_required === true || ["approval", "approval_required", "require_approval"].includes(String(x?.decision ?? x?.status ?? "").toLowerCase()); }
function continuationPrompt(verdict) { return `Continue the active Brain-owned Goal. Do not change the objective. Brain verdict: ${JSON.stringify({ reason: verdict?.reason ?? null, unmet_criteria: verdict?.unmet_criteria ?? [] })}`; }
