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
    if (["workspace.ensure","memory.capture"].includes(req.operation) && !/^[a-f0-9]{64}$/.test(String(req.request_fingerprint ?? ""))) {
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
    } else {
      result={status:"succeeded",effect_occurred:false,result:{fixture:true}};
    }
    break;
  }
  default: process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:false,error:{message:"unsupported"}})); process.exit(0);
}
process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:true,result}));
