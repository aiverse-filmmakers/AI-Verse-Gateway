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
- After successful capture, continue normally. Do not announce internal Memory mechanics unless advanced inspection was requested.

Reusable Skill learning:
- Do not review every turn for learning. Only consider a reusable Skill after meaningful work where a procedure was actually useful, corrected, or repeated and is likely to help later.
- Do not turn facts, preferences, current state, strategy, recurring schedules, durable employee roles, credentials, Connections, or transient one-off details into Skills.
- Use action_class "write_local_reversible", operation "skills.learning-candidate".
- Runtime parameters may contain only:
  candidate: { suggested_owner:"skills", kind:"create|repair", summary, optional skill_id/target_skill_id, success_signal, failure_signal, risk, confidence, requested_capabilities, requested_dependencies, requires_connection, requires_credential, source_ownership:"agent_learned|workspace_local" }
  skill_md: a complete bounded SKILL.md package entrypoint containing only the reusable procedure.
- Do not provide candidate_id, scope, evidence_refs, created_at, task_evidence, approval, authorization, or trusted provenance. Gateway supplies trusted run identity/evidence and independently determines whether the task was substantial enough to route.
- A new capability, dependency, credential, Connection, permission expansion, risky/ambiguous package, protected/user/upstream overwrite, or uncertain scope must not be silently promoted. Owner gates remain stronger than model suggestions.
- Do not call this route merely because a procedure could hypothetically be reusable. There must be concrete evidence from the current completed work.
- After a successful internal learning route, continue the user's work naturally. Do not expose Skill/proposal/generation jargon unless advanced inspection was requested.

Structured current Data:
- Use Data for repeated/current operational truth that is naturally structured, not for historical narrative, preferences, procedures, credentials, or transient chat details.
- Do not ask the user whether information should go into Data or which schema to create when the structure is clear, internal, additive, reversible, workspace-bound, and does not expand authority.
- For safe automatic organization use action_class "write_local_reversible", operation "data.structured-truth".
- Runtime parameters must contain only:
  candidate: { suggested_owner:"data", summary, confidence, repeated_evidence, current_truth, structured_operational, contains_secret:false, privacy_ambiguous:false, permission_expansion:false, destructive:false, structure:{space,schema}, match:{field,value}, record:{data} }
- match must be a stable natural key already present in record.data and the proposed schema. Never invent credentials, permission grants, destructive migrations, or cross-workspace identifiers.
- Do not provide candidate_id, scope, evidence_refs, created_at, task_evidence, actor, authorization, approval, or idempotency fields. Gateway supplies trusted run identity/evidence; Brain and Data enforce owner rules.
- Do not use automatic Data organization on a trivial turn, ambiguous private material, secrets, uncertain current truth, destructive/narrowing schema changes, or one-off unstructured information.
- Canonical owner context may contain a compact structured_data orientation. When a later user task needs current structured truth, inspect the relevant schema with read_local data.schema.get when needed, then use bounded read_local data.query/data.record.get/data.record.list/data.aggregate rather than guessing from Memory.
- A Data owner refusal, ambiguity, migration requirement, or concurrency conflict is not permission to widen the mutation. Continue the foreground task without silently changing authority.
- Keep Data/schema/record jargon out of normal user-facing language unless advanced inspection was requested.

Temporary specialist help:
- For substantial workspace-bound work, you may use one temporary internal specialist when an independent review, focused analysis, or bounded parallel reasoning step is genuinely useful to the user's current request.
- Do not ask the user whether to create temporary help. This is an internal reversible execution choice inside current authority.
- Temporary help is not a durable employee. Never use this route to create, imply, or promise a permanent Bot, recurring responsibility, new credential, Connection, broader permission, or external effect.
- Use action_class "write_local_reversible", operation "workers.temporary".
- Runtime parameters may contain only: objective, role_title, reason, optional skill_refs, optional required_constraints.
- Do not provide runtime configuration, tools, Connections, budget, trusted provenance, task evidence, scope, approval, authorization, Worker IDs, Team Run IDs, or Bot IDs. Gateway supplies the trusted execution/runtime binding and owners enforce the final boundary.
- Use this only when the specialist can work with no new tools or Connections. Existing already-authorized Skills may be referenced when useful.
- At most one automatic temporary specialist is admitted per foreground run. If the route is unavailable or declined, continue the user's task normally instead of exposing backend limitations.
- After the temporary result returns, use it as bounded supporting evidence and deliver the user-facing outcome naturally. Do not mention Worker, Team Run, lease, Multiple Bots, or subsystem mechanics unless advanced inspection was requested.

Permanent specialist boundary:
- You may naturally recommend a dedicated ongoing specialist when repeated work strongly suggests it would help, but recommendation alone must not create anything durable.
- Do not call bots.permanent merely because a permanent specialist seems useful. A durable specialist requires explicit user consent.
- A direct user request such as "create me a bot", "set up a dedicated agent", or equivalent already counts as consent for that requested durable specialist. Do not ask a redundant confirmation.
- A short affirmative such as "yes, set it up" counts only when it directly follows your own clear recommendation to create a dedicated/permanent ongoing specialist.
- When explicit consent exists, use action_class "modify_canonical_state", operation "bots.permanent".
- Runtime parameters may contain only: name, role_title, mission, optional skill_refs.
- Do not provide consent evidence, runtime configuration, scope, Bot ID, permissions, tools, Connections, credentials, provenance, approval, or idempotency fields. Gateway supplies trusted consent/runtime/provenance and OS creates a conservative canonical manifest.
- The initial durable specialist must not silently gain tools, Connections, credentials, Worker-creation rights, handoff rights, or broader scope. Those are separate authority changes.
- If explicit consent is absent, continue the current work and, when genuinely useful, make the recommendation in ordinary language. Do not expose registry or subsystem mechanics.`;

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
      if (args.operation === "skills.learning-candidate") {
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new GatewayError("TOOL_ARGS_INVALID", "skills.learning-candidate parameters must be an object");
        const allowed = ["candidate", "skill_md"];
        const extras = Object.keys(parameters).filter((key) => !allowed.includes(key));
        if (extras.length) throw new GatewayError("TOOL_ARGS_INVALID", `skills.learning-candidate runtime parameters contain unsupported fields: ${extras.join(", ")}`);
        if (!parameters.candidate || typeof parameters.candidate !== "object" || Array.isArray(parameters.candidate)) throw new GatewayError("TOOL_ARGS_INVALID", "skills.learning-candidate candidate must be an object");
        if (typeof parameters.skill_md !== "string" || !parameters.skill_md.trim()) throw new GatewayError("TOOL_ARGS_INVALID", "skills.learning-candidate skill_md must be non-empty");
        const forbiddenCandidate = ["candidate_id", "scope", "evidence_refs", "created_at", "task_evidence", "approval", "authorization"];
        const suppliedTrusted = forbiddenCandidate.filter((key) => Object.hasOwn(parameters.candidate, key));
        if (suppliedTrusted.length) throw new GatewayError("TOOL_ARGS_INVALID", `skills.learning-candidate runtime candidate may not supply trusted fields: ${suppliedTrusted.join(", ")}`);
        parameters = {
          candidate: {
            ...parameters.candidate,
            candidate_id: `learn-${run.run_id}-${call.id}`,
            scope,
            evidence_refs: [`run:${run.run_id}`, `session:${run.session_id}`],
            created_at: run.created_at
          },
          skill_md: parameters.skill_md,
          task_evidence: {
            substantial_task: isSubstantialLearningTask(run)
          }
        };
      }
      if (args.operation === "data.structured-truth") {
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new GatewayError("TOOL_ARGS_INVALID", "data.structured-truth parameters must be an object");
        if (Object.keys(parameters).length !== 1 || !Object.hasOwn(parameters, "candidate")) throw new GatewayError("TOOL_ARGS_INVALID", "data.structured-truth runtime parameters must contain only candidate");
        if (!parameters.candidate || typeof parameters.candidate !== "object" || Array.isArray(parameters.candidate)) throw new GatewayError("TOOL_ARGS_INVALID", "data.structured-truth candidate must be an object");
        const forbiddenCandidate = ["candidate_id", "scope", "evidence_refs", "created_at", "task_evidence", "actor", "authorization", "approval", "idempotency_key", "idempotencyKey"];
        const suppliedTrusted = forbiddenCandidate.filter((key) => Object.hasOwn(parameters.candidate, key));
        if (suppliedTrusted.length) throw new GatewayError("TOOL_ARGS_INVALID", `data.structured-truth runtime candidate may not supply trusted fields: ${suppliedTrusted.join(", ")}`);
        const substantial = scope.startsWith("workspace:") && isSubstantialLearningTask(run);
        const secret = secretLike(stableStringify(parameters.candidate));
        parameters = {
          candidate: {
            ...parameters.candidate,
            candidate_id: `data-${run.run_id}-${call.id}`,
            scope,
            evidence_refs: [`run:${run.run_id}`, `session:${run.session_id}`],
            created_at: run.created_at
          },
          task_evidence: {
            substantial_task: substantial && !secret
          }
        };
      }
      if (args.operation === "workers.temporary") {
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new GatewayError("TOOL_ARGS_INVALID", "workers.temporary parameters must be an object");
        const allowed = ["objective", "role_title", "reason", "skill_refs", "required_constraints"];
        const extras = Object.keys(parameters).filter((key) => !allowed.includes(key));
        if (extras.length) throw new GatewayError("TOOL_ARGS_INVALID", `workers.temporary runtime parameters may not supply trusted fields: ${extras.join(", ")}`);
        for (const [key, limit] of [["objective", 4000], ["role_title", 160], ["reason", 1000]]) {
          if (typeof parameters[key] !== "string" || !parameters[key].trim() || parameters[key].trim().length > limit) {
            throw new GatewayError("TOOL_ARGS_INVALID", `workers.temporary ${key} is invalid`);
          }
        }
        const skillRefs = parameters.skill_refs ?? [];
        const constraints = parameters.required_constraints ?? [];
        if (!Array.isArray(skillRefs) || skillRefs.length > 12 || skillRefs.some((item) => typeof item !== "string" || !item.startsWith("aiverse-skills:"))) {
          throw new GatewayError("TOOL_ARGS_INVALID", "workers.temporary skill_refs are invalid");
        }
        if (!Array.isArray(constraints) || constraints.length > 32 || constraints.some((item) => typeof item !== "string" || !item.trim() || item.length > 1000)) {
          throw new GatewayError("TOOL_ARGS_INVALID", "workers.temporary required_constraints are invalid");
        }
        const workerRuntime = temporaryWorkerRuntime(this.config, run);
        const workerBudget = temporaryWorkerBudget(run);
        const firstWorkerRequest = countOperationRequests(run, "workers.temporary") <= 1;
        const substantial = scope.startsWith("workspace:") && isSubstantialLearningTask(run);
        const secret = secretLike(stableStringify({
          objective: parameters.objective,
          role_title: parameters.role_title,
          reason: parameters.reason,
          required_constraints: constraints
        }));
        const admitted = Boolean(workerRuntime && workerBudget && firstWorkerRequest && substantial && !secret);
        parameters = {
          objective: parameters.objective.trim(),
          role_title: parameters.role_title.trim(),
          reason: parameters.reason.trim(),
          runtime: workerRuntime,
          skill_refs: [...new Set(skillRefs)],
          required_constraints: [...new Set(constraints.map((item) => item.trim()))],
          budget: workerBudget,
          task_evidence: {
            substantial_task: substantial,
            temporary_help_useful: admitted,
            permission_expansion: false,
            durable_commitment: false,
            external_effect: false
          },
          provenance: {
            run_id: run.run_id,
            session_id: run.session_id
          }
        };
      }
      if (args.operation === "bots.permanent") {
        if (args.action_class !== "modify_canonical_state") {
          throw new GatewayError("TOOL_ARGS_INVALID", "bots.permanent requires modify_canonical_state");
        }
        if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
          throw new GatewayError("TOOL_ARGS_INVALID", "bots.permanent parameters must be an object");
        }
        const allowed = ["name", "role_title", "mission", "skill_refs"];
        const extras = Object.keys(parameters).filter((key) => !allowed.includes(key));
        if (extras.length) {
          throw new GatewayError("TOOL_ARGS_INVALID", `bots.permanent runtime parameters may not supply trusted fields: ${extras.join(", ")}`);
        }
        for (const [key, limit] of [["name", 160], ["role_title", 160], ["mission", 2000]]) {
          if (typeof parameters[key] !== "string" || !parameters[key].trim() || parameters[key].trim().length > limit) {
            throw new GatewayError("TOOL_ARGS_INVALID", `bots.permanent ${key} is invalid`);
          }
        }
        const skillRefs = parameters.skill_refs ?? [];
        if (!Array.isArray(skillRefs) || skillRefs.length > 12 || skillRefs.some((item) => typeof item !== "string" || !item.startsWith("aiverse-skills:"))) {
          throw new GatewayError("TOOL_ARGS_INVALID", "bots.permanent skill_refs are invalid");
        }
        const runtime = temporaryWorkerRuntime(this.config, run);
        const consent = permanentBotConsentEvidence(run);
        const secret = secretLike(stableStringify({
          name: parameters.name,
          role_title: parameters.role_title,
          mission: parameters.mission
        }));
        parameters = {
          name: parameters.name.trim(),
          role_title: parameters.role_title.trim(),
          mission: parameters.mission.trim(),
          skill_refs: [...new Set(skillRefs)],
          runtime,
          consent,
          provenance: {
            run_id: run.run_id,
            session_id: run.session_id
          }
        };
        if (!runtime || !consent || secret) parameters._gateway_permanent_bot_admitted = false;
      }
      if (args.operation === "skills.learning-candidate" && parameters?.task_evidence?.substantial_task !== true) {
        const result = {
          status: "succeeded",
          effect_occurred: false,
          result: {
            learning_candidate: {
              state: "ignored",
              reason: "Gateway substantial-task gate suppressed learning review for this turn",
              suggested_owner: "none"
            }
          }
        };
        run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        await this.store.event(run.run_id, "learning.review.skipped", {
          tool_call_id: call.id,
          reason: "not_substantial"
        });
        await this.store.saveRun(run);
        continue;
      }
      if (args.operation === "data.structured-truth" && parameters?.task_evidence?.substantial_task !== true) {
        const result = {
          status: "succeeded",
          effect_occurred: false,
          result: {
            data_candidate: {
              state: "ignored",
              reason: "Gateway suppressed automatic Data organization for a trivial, non-workspace, or secret-bearing turn",
              suggested_owner: "none"
            }
          }
        };
        run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        await this.store.event(run.run_id, "data.organization.skipped", {
          tool_call_id: call.id,
          reason: "not_safe_or_substantial"
        });
        await this.store.saveRun(run);
        continue;
      }
      if (args.operation === "workers.temporary" && parameters?.task_evidence?.temporary_help_useful !== true) {
        const result = {
          status: "succeeded",
          effect_occurred: false,
          result: {
            temporary_worker: {
              state: "ignored",
              reason: "Gateway suppressed temporary specialist help because the task, runtime, scope, budget, secret boundary, or one-per-run gate was not eligible"
            }
          }
        };
        run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        await this.store.event(run.run_id, "temporary_worker.skipped", {
          tool_call_id: call.id,
          reason: "not_safe_supported_or_substantial"
        });
        await this.store.saveRun(run);
        continue;
      }
      if (args.operation === "bots.permanent" && parameters?._gateway_permanent_bot_admitted === false) {
        const result = {
          status: "succeeded",
          effect_occurred: false,
          result: {
            permanent_bot: {
              state: "not_created",
              reason: "explicit_user_consent_or_supported_safe_runtime_missing"
            }
          }
        };
        run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        await this.store.event(run.run_id, "permanent_bot.skipped", {
          tool_call_id: call.id,
          reason: "consent_or_safe_runtime_missing"
        });
        await this.store.saveRun(run);
        continue;
      }
      if (args.operation === "bots.permanent") delete parameters._gateway_permanent_bot_admitted;

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
      if (request.operation === "workers.temporary") {
        const workerUsage = result?.result?.temporary_worker?.usage;
        if (workerUsage && typeof workerUsage === "object" && !Array.isArray(workerUsage)) addUsage(run.usage, workerUsage);
        await this.store.event(run.run_id, "temporary_worker.completed", {
          tool_call_id: call.id,
          state: result?.result?.temporary_worker?.state ?? null,
          effect_occurred: result?.effect_occurred === true
        });
      }
      if (request.operation === "bots.permanent") {
        await this.store.event(run.run_id, "permanent_bot.created", {
          tool_call_id: call.id,
          state: result?.result?.permanent_bot?.state ?? null,
          consent_mode: parameters?.consent?.mode ?? null,
          effect_occurred: result?.effect_occurred === true
        });
      }
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
        reason: "completed run did not qualify for a safe compact session digest",
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

function permanentBotConsentEvidence(run) {
  const messages = (run?.messages ?? []).filter((message) =>
    ["user", "assistant"].includes(message?.role) &&
    message?._gateway_context !== true &&
    message?._gateway_continuation !== true
  );
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  const userText = typeof messages[userIndex]?.content === "string"
    ? messages[userIndex].content.trim()
    : JSON.stringify(messages[userIndex]?.content ?? "").trim();
  if (!userText || userText.length > 4000) return null;
  const lower = userText.toLowerCase();

  const negated = /\b(?:do not|don't|dont|never|no)\s+(?:create|make|add|build|set\s*up)\b/i.test(userText);
  const temporaryOnly = /\b(?:temporary|one[- ]off|for this task only|just for this task)\b/i.test(userText);
  const adviceQuestion = /\b(?:should i|should we|do you think|would it make sense)\b/i.test(userText);
  const directCreate = /\b(?:create|make|add|build|set\s*up|setup|give me)\b[\s\S]{0,120}\b(?:bot|agent|assistant|employee|specialist)\b/i.test(userText)
    || /\b(?:i want|i need)\b[\s\S]{0,80}\b(?:a|an|my)?\s*(?:dedicated|permanent|ongoing|durable)?\s*(?:bot|agent|assistant|employee|specialist)\b/i.test(userText);
  if (directCreate && !negated && !temporaryOnly && !adviceQuestion) {
    return {
      explicit: true,
      mode: "direct_request",
      user_message_digest: "sha256:" + createHash("sha256").update(userText).digest("hex")
    };
  }

  const affirmative = userText.length <= 160 && /^(?:yes|yes please|yep|yeah|do it|go ahead|set it up|create it|make it|make it permanent|sounds good[,. ]*do it|please do)[.! ]*$/i.test(userText);
  if (!affirmative) return null;

  let priorAssistant = null;
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      priorAssistant = messages[index];
      break;
    }
    if (messages[index]?.role === "user") break;
  }
  const recommendation = typeof priorAssistant?.content === "string"
    ? priorAssistant.content.trim()
    : JSON.stringify(priorAssistant?.content ?? "").trim();
  if (!recommendation || recommendation.length > 6000) return null;
  const recommendsDurable = /\b(?:bot|agent|assistant|employee|specialist)\b/i.test(recommendation)
    && /\b(?:dedicated|permanent|ongoing|durable)\b/i.test(recommendation)
    && /\b(?:would you like|want me to|shall i|should i|i can)\b[\s\S]{0,120}\b(?:create|make|set\s*up|setup)\b/i.test(recommendation);
  if (!recommendsDurable) return null;

  return {
    explicit: true,
    mode: "affirmative_to_recommendation",
    user_message_digest: "sha256:" + createHash("sha256").update(userText).digest("hex"),
    recommendation_message_digest: "sha256:" + createHash("sha256").update(recommendation).digest("hex")
  };
}

function temporaryWorkerRuntime(config, run) {
  const runtime = config?.runtime ?? {};
  if (runtime.kind === "deterministic") return { adapter: "deterministic" };
  if (runtime.kind !== "openai-compatible") return null;
  const base = String(runtime.base_url ?? "").replace(/\/$/, "");
  const model = run?.runtime?.model ?? runtime.model ?? null;
  if (!/^https?:\/\/[^\s]+$/.test(base) || typeof model !== "string" || !model.trim()) return null;
  const mapped = {
    adapter: "openai-compatible",
    endpoint: `${base}/v1/chat/completions`,
    model: model.trim()
  };
  if (typeof runtime.api_key_env === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(runtime.api_key_env)) {
    mapped.api_key_env = runtime.api_key_env;
  }
  return mapped;
}

function temporaryWorkerBudget(run) {
  const deadlineMs = Date.parse(String(run?.deadline_at ?? ""));
  const remainingSeconds = Number.isFinite(deadlineMs) ? Math.floor((deadlineMs - Date.now()) / 1000) : 120;
  if (remainingSeconds < 2) return null;

  const budget = run?.budget ?? {};
  const usedTokens = Number(run?.usage?.input_tokens ?? 0) + Number(run?.usage?.output_tokens ?? 0);
  const maxTokens = Number.isFinite(budget.max_tokens) && budget.max_tokens !== null ? Number(budget.max_tokens) : null;
  const remainingTokens = maxTokens === null ? 4096 : Math.floor(maxTokens - usedTokens);
  if (remainingTokens < 1) return null;

  const result = {
    token_limit: Math.min(4096, remainingTokens),
    wall_clock_seconds: Math.min(120, remainingSeconds)
  };
  if (Number.isFinite(budget.max_cost) && budget.max_cost !== null) {
    const remainingCost = Number(budget.max_cost) - Number(run?.usage?.cost ?? 0);
    if (!(remainingCost > 0)) return null;
    result.cost_limit = remainingCost;
  }
  return result;
}

function countOperationRequests(run, operation) {
  let count = 0;
  for (const message of run?.messages ?? []) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call?.function?.name !== "aiverse_action") continue;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (args?.operation === operation) count += 1;
      } catch {
        // Invalid JSON is rejected by the normal tool-call path.
      }
    }
  }
  return count;
}

function isSubstantialLearningTask(run) {
  const userText = run.messages
    .filter((message) => message.role === "user" && message._gateway_continuation !== true)
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
    .join("\n")
    .trim();
  const meaningfulTokens = userText.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)?.length ?? 0;
  return Boolean(
    run.goal_binding
    || Number(run.usage?.actions ?? 0) > 0
    || Number(run.continuation?.turn ?? 0) > 1
    || userText.length >= 120
    || meaningfulTokens >= 18
  );
}

function secretLike(value) {
  const text = String(value ?? "");
  return [
    /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key)\s*[:=]\s*[^\s,;]{6,}/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/
  ].some((pattern) => pattern.test(text));
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
  if (!meaningful || secretLike(lastUser) || secretLike(outcome)) return null;

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
