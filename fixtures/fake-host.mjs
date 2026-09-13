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
    result = req.operation === "needs.approval" && !req.approval ? {decision:"approval_required",approval_required:true} : {decision:"allow",allowed:true}; break;
  }
  case "request_action": result={status:"succeeded",effect_occurred:false,result:{fixture:true}}; break;
  default: process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:false,error:{message:"unsupported"}})); process.exit(0);
}
process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:true,result}));
