import { installComponent, setupComponent, statusComponent, doctorComponent, setEnabled, updateComponent, uninstallComponent } from "./lifecycle.mjs";
import { loadConfig } from "./config.mjs";
import { gatewayHome } from "./paths.mjs";
import { startServer } from "./server.mjs";
import { asGatewayError } from "./errors.mjs";

export async function main(argv) {
  const command = argv[0]; const opts = parseArgs(argv.slice(1));
  try {
    let result;
    if (command === "install") result = await installComponent(opts);
    else if (command === "setup") result = await setupComponent(opts);
    else if (command === "status") result = await statusComponent(opts);
    else if (command === "doctor") result = await doctorComponent(opts);
    else if (command === "enable") result = await setEnabled(opts, true);
    else if (command === "disable") result = await setEnabled(opts, false);
    else if (command === "update") result = await updateComponent(opts);
    else if (command === "uninstall") result = await uninstallComponent(opts);
    else if (command === "serve") return await serve(opts);
    else { print({ ok:false, error:{code:"USAGE",message:usage()} }); return 2; }
    print(result); return result.ok === false ? 2 : 0;
  } catch (error) { const e=asGatewayError(error); print({ok:false,command,error:{code:e.code,message:e.message}}); return e.status >= 500 ? 5 : 2; }
}
async function serve(opts){const home=gatewayHome(opts.home);const config=await loadConfig(home);const running=await startServer(config,home,{port:opts.port?Number(opts.port):undefined,host:opts.host});print({ok:true,command:"serve",host:running.host,port:running.port});const shutdown=async()=>{await running.close();process.exit(0);};process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);await new Promise(()=>{});return 0;}
function parseArgs(args){const out={allowed_origins:[],runtime_env_names:[]};for(let i=0;i<args.length;i++){const a=args[i];if(!a.startsWith("--"))continue;const key=a.slice(2).replaceAll("-","_");if(["apply","purge","allow_remote","behind_tls_proxy","json"].includes(key)){out[key]=true;continue;}const value=args[++i];if(value===undefined)throw new Error(`Missing value for ${a}`);if(key==="allow_origin")out.allowed_origins.push(value);else if(key==="runtime_env_name")out.runtime_env_names.push(value);else out[key]=value;}if(out.allowed_origins.length===0)delete out.allowed_origins;if(out.runtime_env_names.length===0)delete out.runtime_env_names;return out;}
function print(value){process.stdout.write(`${JSON.stringify(value,null,2)}\n`);}
function usage(){return "aiverse-gateway <install|setup|status|doctor|enable|disable|update|uninstall|serve> [--home PATH] [--json]";}
