/**
 * Owner-backed, read-only conversation discovery.
 * The canonical session/run files remain the sole authority. No Dashboard
 * index, transcript copy, provider secret, system/tool prompt or raw trace
 * is projected. The store is read only after authenticated Gateway admission.
 */
import {readdir} from "node:fs/promises";
import {GatewayError} from "./errors.mjs";

const MAX_INDEX_FILES=10_000;
const MAX_PAGE_SIZE=25;
const MAX_OFFSET=10_000;
const SCOPE=/^(operator|[a-z0-9][a-z0-9-]{0,127})$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function reject(code,detail,status=400){
  throw new GatewayError(code,detail,status);
}
function validScope(value){
  if(typeof value!=="string"||!SCOPE.test(value))
    reject("INVALID_HISTORY_SCOPE","Select a valid workspace");
  return value;
}
function query(url,expected){
  for(const field of url.searchParams.keys()){
    if(!expected.includes(field) || url.searchParams.getAll(field).length!==1)
      reject("INVALID_HISTORY_QUERY","Unsupported history query");
  }
  const limit=Number(url.searchParams.get("limit")??"20");
  const offset=Number(url.searchParams.get("offset")??"0");
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE_SIZE
    ||!Number.isSafeInteger(offset)||offset<0||offset>MAX_OFFSET)
    reject("INVALID_HISTORY_QUERY","History page exceeds bounds");
  return {limit,offset};
}
async function records(dir,reader){
  let names=await readdir(dir);
  names=names.filter(x=>x.endsWith(".json"));
  if(names.length>MAX_INDEX_FILES)
    reject("HISTORY_INDEX_TOO_LARGE","Canonical index exceeds read bound",503);
  const out=[];
  for(let start=0;start<names.length;start+=32){
    const slice=names.slice(start,start+32);
    const loaded=await Promise.all(slice.map(async(name)=>{
      const id=name.slice(0,-5);
      if(!ID.test(id))return null;
      return reader(id);
    }));
    for(const record of loaded)if(record)out.push(record);
  }
  return out;
}
const date=v=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT/.test(v)?v:"";
function newest(a,b){
  const dateCmp=date(b.updated_at??b.created_at).localeCompare(date(a.updated_at??a.created_at));
  return dateCmp || String(a.session_id??a.run_id).localeCompare(String(b.session_id??b.run_id));
}
function paginate(data,limit,offset){
  const page=data.slice(offset,offset+limit);
  return {object:"list",data:page,
    next_offset:offset+limit<data.length?offset+limit:null,
    has_more:offset+limit<data.length};
}
function ownedSession(session,principal,systemId,workspace){
  return session&&session.principal===principal&&session.system_id===systemId
    &&session.workspace_id===workspace;
}
/** Caller has already authenticated principal and service lifecycle. */
export async function listOwnedSessions(store,{principal,systemId,workspaceId,url}){
  const workspace=validScope(workspaceId);
  const {limit,offset}=query(url,["workspace_id","limit","offset"]);
  const sessions=await records(store.p.sessions,id=>store.getSession(id));
  const visible=sessions.filter(s=>ownedSession(s,principal,systemId,workspace))
    .sort(newest).map(session=>({
      session_id:session.session_id,system_id:session.system_id,
      workspace_id:session.workspace_id,title:String(session.title??session.session_id).slice(0,120),
      status:session.status,created_at:session.created_at,
      updated_at:session.updated_at,active_run_id:session.active_run_id??null,
    }));
  return paginate(visible,limit,offset);
}
/** Validate the parent FIRST; never enumerate a foreign session's run files. */
export async function listOwnedSessionRuns(store,{principal,systemId,workspaceId,sessionId,url}){
  const workspace=validScope(workspaceId);
  if(!ID.test(sessionId))reject("INVALID_HISTORY_ID","Invalid session identifier");
  const {limit,offset}=query(url,["workspace_id","limit","offset"]);
  const session=await store.getSession(sessionId);
  if(!ownedSession(session,principal,systemId,workspace))
    reject("SESSION_NOT_FOUND","Session unavailable",404);
  const runs=await records(store.p.runs,id=>store.getRun(id));
  const visible=runs.filter(run=>run.session_id===sessionId
    &&run.principal===principal&&run.system_id===systemId
    &&run.workspace_id===workspace).sort(newest).map(run=>{
      // Include only the latest actual user turn from the canonical run;
      // the full run.messages may contain private owner/system/tool context.
      const user=[...(Array.isArray(run.messages)?run.messages:[])]
        .reverse().find(message=>message?.role==="user"&&typeof message.content==="string");
      const output=run.status==="completed"&&typeof run.output?.content==="string"
        ?run.output.content:null;
      return {run_id:run.run_id,session_id:run.session_id,
        status:run.status,created_at:run.created_at,
        completed_at:run.completed_at??null,
        user_text:user?user.content.slice(0,4096):null,
        output:output?.slice(0,12_000)??null,
        output_truncated:output!==null&&output.length>12_000,
        user_text_truncated:Boolean(user&&user.content.length>4096)};
    });
  return paginate(visible,limit,offset);
}
