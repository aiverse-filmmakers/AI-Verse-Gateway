import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {installComponent,setupComponent} from "../src/lifecycle.mjs";
import {loadConfig} from "../src/config.mjs";
import {startServer} from "../src/server.mjs";
import {listOwnedSessions} from "../src/history.mjs";

const fixtureHost=path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "..","fixtures","fake-host.mjs");
const MAX=40;
test("canonical history lists owned sessions and redacted run turns, never a Dashboard index",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"avg-history-system-"));
  const home=await mkdtemp(path.join(tmpdir(),"avg-history-home-"));
  let live;
  try{
    await writeFile(path.join(root,"AI-VERSE.yaml"),"schema_version: 2.0\n");
    const hostFile=path.join(root,"host.json");
    await writeFile(hostFile,JSON.stringify({transport:"json-subprocess",
      command:[process.execPath,fixtureHost],timeout_seconds:10,
      max_output_bytes:1048576,max_stderr_bytes:65536,env_names:[],cwd:root}));
    await installComponent({home});
    const setup=await setupComponent({home,system_root:root,
      host_config:hostFile,runtime:"deterministic",system_id:"ci-history"});
    live=await startServer(await loadConfig(home),home,{port:0});
    const url="http://127.0.0.1:"+live.port;
    const headers={authorization:"Bearer "+setup.api_token};
    const get=async path=>{
      const response=await fetch(url+path,{headers});
      return {status:response.status,body:await response.json()};
    };
    const empty=await get("/v1/sessions?workspace_id=operator");
    assert.equal(empty.status,200);
    assert.deepEqual(empty.body.data,[]);

    const s1=await live.store.createSession({system_id:"ci-history",
      workspace_id:"operator",principal:"operator",title:"Camera planning"});
    const s2=await live.store.createSession({system_id:"ci-history",
      workspace_id:"operator",principal:"operator",title:"Editing"});
    const forbidden=await live.store.createSession({system_id:"ci-history",
      workspace_id:"operator",principal:"other",title:"PRIVATE_OTHER_PRINCIPAL"});
    const foreignWorkspace=await live.store.createSession({system_id:"ci-history",
      workspace_id:"alpha",principal:"operator",title:"PRIVATE_OTHER_WORKSPACE"});

    async function run(session,principal,workspace,userText){
      const item=await live.store.createRun({
        session_id:session.session_id,system_id:"ci-history",workspace_id:workspace,
        principal,runtime:{kind:"deterministic"},
        messages:[
          {role:"system",content:"SECRET_SYSTEM_PROMPT"},
          {role:"user",content:userText},
          {role:"tool",content:"SECRET_PROVIDER_TOKEN"},
        ],
        budget:{max_actions:0},deadline_at:new Date(Date.now()+120000).toISOString(),
      });
      item.status="completed";
      item.output={content:"Canonical verified reply to "+userText};
      item.completed_at=new Date().toISOString();
      await live.store.saveRun(item);
      return item;
    }
    const first=await run(s1,"operator","operator","Filming the library scene");
    const second=await run(s1,"operator","operator","Adjust the lighting");
    await run(forbidden,"other","operator","PRIVATE_OTHER_PRINCIPAL");
    await run(foreignWorkspace,"operator","alpha","PRIVATE_OTHER_WORKSPACE");

    const listed=await get("/v1/sessions?workspace_id=operator&limit=1&offset=0");
    assert.equal(listed.status,200);
    assert.equal(listed.body.data.length,1);
    assert.equal(listed.body.has_more,true);
    assert.equal(listed.body.next_offset,1);
    const otherPage=await get("/v1/sessions?workspace_id=operator&limit=1&offset=1");
    assert.equal(otherPage.status,200);
    assert.equal(otherPage.body.data.length,1);
    assert.equal(otherPage.body.has_more,false);
    assert.deepEqual(new Set([...listed.body.data,...otherPage.body.data]
      .map(s=>s.session_id)),new Set([s1.session_id,s2.session_id]));
    assert.doesNotMatch(JSON.stringify([listed.body,otherPage.body]),
      /PRIVATE_OTHER|SECRET_SYSTEM|SECRET_PROVIDER/);
    const own=await get("/v1/sessions/"+s1.session_id+"/runs?workspace_id=operator&limit=25");
    assert.equal(own.status,200);
    assert.equal(own.body.data.length,2);
    assert.deepEqual(new Set(own.body.data.map(x=>x.run_id)),
      new Set([first.run_id,second.run_id]));
    assert.deepEqual(new Set(own.body.data.map(x=>x.user_text)),
      new Set(["Filming the library scene","Adjust the lighting"]));
    assert.equal(own.body.data.every(x=>x.status==="completed"&&x.output?.startsWith("Canonical verified")),true);
    assert.doesNotMatch(JSON.stringify(own.body),/SECRET_SYSTEM|SECRET_PROVIDER/);
    for(const [route,status] of [
      ["/v1/sessions/"+forbidden.session_id+"/runs?workspace_id=operator",404],
      ["/v1/sessions/"+foreignWorkspace.session_id+"/runs?workspace_id=operator",404],
      ["/v1/sessions/"+s1.session_id+"/runs?workspace_id=alpha",404],
      ["/v1/sessions?workspace_id=alpha",200],
      ["/v1/sessions?workspace_id=operator&limit=1000",400],
      ["/v1/sessions?workspace_id=operator&offset=-1",400],
      ["/v1/sessions?workspace_id=operator&offset=200000",400],
      ["/v1/sessions?workspace_id=operator&junk=1",400],
      ["/v1/sessions?workspace_id=operator&workspace_id=alpha",400],
      ["/v1/sessions",400],
      ["/v1/sessions/../../etc/runs?workspace_id=operator",404],
    ]){
      const found=await get(route);
      assert.equal(found.status,status,route+" "+JSON.stringify(found.body));
    }
    const noBearer=await fetch(url+"/v1/sessions?workspace_id=operator");
    assert.equal(noBearer.status,401);
    const badBearer=await fetch(url+"/v1/sessions?workspace_id=operator",{
      headers:{authorization:"Bearer incorrect"},
    });
    assert.equal(badBearer.status,401);
    const scoped=await listOwnedSessions(live.store,{
      principal:"other",systemId:"ci-history",workspaceId:"operator",
      url:new URL(url+"/v1/sessions?workspace_id=operator"),
    });
    assert.deepEqual(scoped.data.map(x=>x.session_id),[forbidden.session_id]);
  }finally{
    if(live)await live.close();
    await Promise.all([rm(root,{recursive:true,force:true}),
      rm(home,{recursive:true,force:true})]);
  }
});
