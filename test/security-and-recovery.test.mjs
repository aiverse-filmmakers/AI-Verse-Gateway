import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayStore } from "../src/store.mjs";
import { hashToken, verifyToken } from "../src/auth.mjs";
import { GatewayError } from "../src/errors.mjs";

test("auth stores a one-way scrypt verifier", () => { const token="secret-fixture";const record=hashToken(token,"operator");assert.equal(record.hash.includes(token),false);assert.equal(verifyToken(token,record),true);assert.equal(verifyToken("wrong",record),false); });

test("idempotency rejects same operation id with changed payload", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-store-"));const store=new GatewayStore(home);await store.init();await store.claimIdempotency("run","same",{a:1});await assert.rejects(()=>store.claimIdempotency("run","same",{a:2}),e=>e instanceof GatewayError&&e.code==="IDEMPOTENCY_CONFLICT");});

test("restart recovery pauses in-flight run instead of claiming provider resume", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-recover-"));const store=new GatewayStore(home);await store.init();const run=await store.createRun({session_id:"sess_x",system_id:"local",workspace_id:"operator",principal:"operator",runtime:{kind:"deterministic"},messages:[{role:"user",content:"x"}],max_turns:1,budget:{max_actions:1},deadline_at:new Date(Date.now()+60000).toISOString()});run.status="running";await store.saveRun(run);const changed=await store.recoverInterrupted();assert.deepEqual(changed,[run.run_id]);assert.equal((await store.getRun(run.run_id)).status,"paused_recovery_required");});

test("storage rejects caller-controlled path-like session ids", async()=>{const home=await mkdtemp(path.join(os.tmpdir(),"avg-id-"));const store=new GatewayStore(home);await store.init();await assert.rejects(()=>store.createSession({system_id:"local",workspace_id:"operator",principal:"operator",session_id:"../../escape"}),e=>e instanceof GatewayError&&e.code==="INVALID_ID");});

test("serve-time host override cannot bypass loopback security policy", async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),"avg-bind-"));
  const config={enabled:true,server:{host:"127.0.0.1",port:8787,allow_remote:false,behind_tls_proxy:false,max_body_bytes:262144,requests_per_minute:10,allowed_origins:[]},auth:{required:true,keys:[hashToken("x","operator")]},system:{id:"local",root:home,default_workspace:"operator"},host_adapter_config:path.join(home,"host.json"),goal_owner_config:null,runtime:{kind:"deterministic"},limits:{max_goal_continuation_turns:20,no_progress_threshold:2,wall_clock_seconds:120,max_actions:16,max_tokens:null,max_cost:null}};
  const { startServer } = await import("../src/server.mjs");
  await assert.rejects(()=>startServer(config,home,{host:"0.0.0.0",port:0}),e=>e instanceof GatewayError&&e.code==="REMOTE_BIND_UNSAFE");
});
