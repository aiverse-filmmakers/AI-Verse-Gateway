#!/usr/bin/env node
const input = JSON.parse(await new Promise((resolve) => { let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>resolve(s)); }));
const p = input.payload ?? {};
let result;
switch (input.operation) {
  case "describe": result={adapter_id:"fixture:os-host",protocol_version:"1.0",operations:["read_context","retrieve_history","list_capabilities","list_connections","authorize_action","request_action"],metadata:{canonical_state_owned:false,optional_components_dynamic:true,memory:"available",skills:"available",data:"available"}}; break;
  case "read_context": result={scope:p.scope,current_context:"fixture current context",direction_owner:"os",read_only:true}; break;
  case "retrieve_history": result=[]; break;
  case "list_capabilities": result=[]; break;
  case "list_connections": result=[]; break;
  case "authorize_action": {
    const req=p.request??{};
    if (["workspace.ensure","memory.capture","skills.learning-candidate"].includes(req.operation) && !/^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))) {
      result={decision:"deny",allowed:false,reason:`${req.operation} requires a bound request fingerprint`};
    } else {
      result = req.operation === "needs.approval" && !req.approval ? {decision:"approval_required",approval_required:true} : {decision:"allow",allowed:true};
    }
    break;
  }
  case "request_action": {
    const req=p.request??{};
    if (req.operation === "workspace.ensure") {
      const workspace=req.parameters?.workspace??{};
      result={
        status:"succeeded",
        effect_occurred:true,
        result:{
          workspace_organization:{
            schema_version:1,
            state:"created",
            changed:true,
            user_confirmation_required:false,
            permission_expanded:false,
            connection_created:false,
            credential_created:false,
            automation_created:false,
            permanent_bot_created:false,
            workspace:{id:workspace.id,name:workspace.name,path:`workspaces/${workspace.id}`}
          }
        }
      };
    } else if (req.operation === "memory.capture") {
      const p=req.parameters??{};
      const trusted =
        typeof p.source === "string" && p.source.startsWith("gateway-run:") &&
        Array.isArray(p.evidence_refs) && p.evidence_refs.length === 2 &&
        typeof p.effect_id === "string" && p.effect_id.startsWith("gateway:");
      result=trusted ? {
        status:"succeeded",
        effect_occurred:true,
        result:{
          memory_capture:{
            state:"captured",
            changed:true,
            memory_id:"mem-fixture",
            type:p.type,
            scope:req.scope,
            source:p.source,
            evidence_refs:p.evidence_refs
          }
        }
      } : {
        status:"blocked",
        effect_occurred:false,
        result:{memory_capture:{state:"blocked",changed:false,reason:"trusted provenance missing"}}
      };
    } else if (req.operation === "skills.learning-candidate") {
      const params=req.parameters??{};
      const candidate=params.candidate??{};
      const trusted =
        Object.keys(params).sort().join(",") === "candidate,skill_md,task_evidence" &&
        typeof candidate.candidate_id === "string" && candidate.candidate_id.startsWith("learn-run_") &&
        candidate.scope === req.scope &&
        Array.isArray(candidate.evidence_refs) && candidate.evidence_refs.length === 2 &&
        candidate.evidence_refs.every((ref)=>typeof ref === "string") &&
        typeof candidate.created_at === "string" &&
        typeof params.skill_md === "string" && params.skill_md.includes("name: client-alpha-review") &&
        typeof params.task_evidence?.substantial_task === "boolean";
      if (!trusted) {
        result={
          status:"blocked",
          effect_occurred:false,
          result:{learning_candidate:{state:"blocked",reason:"trusted Gateway learning binding missing"}}
        };
      } else if (!params.task_evidence.substantial_task) {
        result={
          status:"succeeded",
          effect_occurred:false,
          result:{
            learning_candidate:{state:"ignored",reason:"task evidence is not substantial enough for a learning review",suggested_owner:"none"},
            idempotent_replay:false
          }
        };
      } else {
        result={
          status:"succeeded",
          effect_occurred:true,
          result:{
            learning_candidate:{state:"admitted",suggested_owner:"skills"},
            skills_submission:{proposal_id:candidate.candidate_id,state:"proposal"},
            skills_result:{proposal_id:candidate.candidate_id,state:"pending_approval"},
            idempotent_replay:false
          },
          execution_binding:{
            request_fingerprint:req.request_fingerprint,
            scope:req.scope,
            action_class:req.action_class,
            operation:req.operation,
            proposal_id:candidate.candidate_id,
            proposal_state:"pending_approval"
          }
        };
      }
    } else {
      result={status:"succeeded",effect_occurred:false,result:{fixture:true}};
    }
    break;
  }
  default: process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:false,error:{message:"unsupported"}})); process.exit(0);
}
process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:true,result}));
