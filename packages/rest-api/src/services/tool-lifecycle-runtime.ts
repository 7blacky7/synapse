/** R5.1: opt-in API-Worker, Fachtool/Broker konfigurieren ausschließlich serverseitige Adapter. */
import {registriereWorker,workerPausiert} from '@synapse/core';
import {ToolLifecycle,type ToolResourceAdapter,type ToolContainerExecutor} from './tool-lifecycle.js';
import {DockerToolContainerExecutor} from './tool-container-docker.js';
let configured:{resources?:ToolResourceAdapter;executor?:ToolContainerExecutor}={};
let lifecycle:ToolLifecycle|null=null,timer:NodeJS.Timeout|null=null;
export function configureToolLifecycleAdapters(adapters:typeof configured):void {
 if(lifecycle)throw Error('tool_lifecycle_already_initialized');configured={...adapters};
}
export function getToolLifecycle():ToolLifecycle|null{return lifecycle;}
export function initToolLifecycle():void {
 if(process.env.SYNAPSE_TOOL_LIFECYCLE_ENABLED!=='1'||lifecycle)return;
 const integer=(name:string,fallback:number)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw Error('invalid_tool_lifecycle_config:'+name);return n;};
 lifecycle=new ToolLifecycle({executor:configured.executor??new DockerToolContainerExecutor({socketPath:process.env.SYNAPSE_TOOL_DOCKER_SOCKET}),
 resources:configured.resources,maxContainers:integer('SYNAPSE_TOOL_MAX_CONTAINERS',4)});
 let running:Promise<void>|null=null;
 const tick=async()=>{if(!running)running=lifecycle!.tick().finally(()=>{running=null;});await running;return {geprueft:true};};
 registriereWorker({name:'tool-lifecycle',beschreibung:'R5.1 Werkzeugcontainer nach Jobs/echter Aktivitaet',durchlauf:tick});
 const run=()=>{if(workerPausiert('tool-lifecycle'))return;void tick().catch(e=>console.error('[tool-lifecycle] Tick fehlgeschlagen:',e));};
 timer=setInterval(run,integer('SYNAPSE_TOOL_TICK_MS',10000));timer.unref();run();
}
export function closeToolLifecycle():void {
 if(timer)clearInterval(timer);timer=null;lifecycle?.close();lifecycle=null;
 // Prozessstop beendet keine fremden/langlaufenden Jobs. PG/Docker-Reconciliation nach Neustart.
}
