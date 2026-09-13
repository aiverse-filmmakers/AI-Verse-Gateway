#!/usr/bin/env node
const input=JSON.parse(await new Promise((resolve)=>{let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>resolve(s));}));
const messages=input.payload?.messages??[];
const hasTool=messages.some(m=>m.role==="tool");
const result=hasTool
 ? {content:"approved tool completed",tool_calls:[],finish_reason:"stop",usage:{input_tokens:2,output_tokens:3,cost:0}}
 : {content:"",tool_calls:[{id:"call_fixture",type:"function",function:{name:"aiverse_action",arguments:JSON.stringify({action_class:"read_local",operation:"needs.approval",parameters:{},reason:"fixture"})}}],finish_reason:"tool_calls",usage:{input_tokens:2,output_tokens:1,cost:0}};
process.stdout.write(JSON.stringify({protocol:"ai-verse-gateway-runtime/1.0",request_id:input.request_id,ok:true,result}));
