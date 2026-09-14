#!/usr/bin/env node
const input=JSON.parse(await new Promise((resolve)=>{let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>resolve(s));}));
if(input.payload?.scope!=="workspace:alpha"){
  process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:false,error:{message:`wrong Goal scope: ${input.payload?.scope ?? "missing"}`}}));
  process.exit(0);
}
let result;
if(input.operation==="goal.get") result={goal:{goal_id:input.payload.goal_id,status:"active",version:1,activation_epoch:1}};
else if(input.operation==="goal.evaluate") result={goal_id:input.payload.goal_id,goal_version:1,verdict:"complete",reason:"fixture evidence accepted",evidence_refs:[input.payload.evidence.run_id]};
else {process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:false,error:{message:"unsupported"}}));process.exit(0);}
process.stdout.write(JSON.stringify({protocol:input.protocol,request_id:input.request_id,ok:true,result}));
