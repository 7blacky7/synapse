/**
 * P22-T194: passive Metadaten, kein Modellaufruf/Keepalive/Neustart. Freigabe über Tray oder die eigene Runtime-Wrapper-Brücke.
 * Keine Ausweise/API-Geheimnisse im Mod. Das JSONL liefert TTL-Klassen, die eigene Uhr nur eine Schätzung.
 */
import type {EngineInterface} from 'claude-code';
type Klasse='5m'|'1h';
interface Messung {generation?:string|null;modell:string|null;request_id:string|null;messung_ms:number;request_beginn_ms:number|null;nutzungsmessung_ms:number|null;input:number|null;output:number|null;gelesen:number|null;geschrieben:number|null;kontext_tokens:number|null;ttl_klassen:Klasse[];ttl_quelle:'transcript'|'unbekannt';cli_version:string|null;mod_version:string}
let frei=false,transcript:string|null=null,messung:Messung|null=null,offen:Messung|null=null,sendend=false;
let runtimeModus=false,runtimeSocket:string|null=null,runtimeGeneration:string|null=null;
/** Container-Bruecke hat nur Cache-Metadaten; kein /mod-inbox/warte und keine Ausweise in der Mod. */
async function runtimeFreigabe($:EngineInterface):Promise<void>{
 if(!runtimeSocket){await aktualisiereCacheFreigabe($,{aktiv:false});return;}
 try{
  const sitzung=await $.session.id();
  const r=await $.http.fetch('http://localhost/cache-waechter?sitzung='+encodeURIComponent(sitzung),{socketPath:runtimeSocket});
  if(!r.ok)throw Error('Cache-Bruecke HTTP '+r.status);
  const j=JSON.parse(r.text),generation=typeof j.generation==='string'?j.generation:null;
  if(generation!==runtimeGeneration){frei=false;messung=null;offen=null;runtimeGeneration=generation;}
  await aktualisiereCacheFreigabe($,j);
 }catch{await aktualisiereCacheFreigabe($,{aktiv:false});}
}
export async function runtimeCacheStart($:EngineInterface):Promise<boolean>{
 runtimeModus=(await $.env.get('SYNAPSE_CLI_RECHTE'))==='container'||(await $.env.get('SYNAPSE_RUNTIME_MOD_POLICY'))==='1';
 if(!runtimeModus)return false;
 runtimeSocket=(await $.env.get('SYNAPSE_CACHE_MOD_SOCKET'))??null;
 await runtimeFreigabe($);
 return true;
}
export async function runtimeCacheRequest($:EngineInterface,e:{turnId:string;index:number;model:string},
 u:{input_tokens:number;output_tokens:number;cache_read_input_tokens:number;cache_creation_input_tokens:number;model:string}|null,at:number):Promise<void>{
 if(runtimeModus)await runtimeFreigabe($);
 if(!frei)return;
 await beobachteCacheRequest($,e,u,at);
 if(runtimeModus)await leseCacheTranscript($);
}
export const cacheWaechterAktiv=()=>frei;
export function merkeCacheTranscript(path:string){transcript=path;}
export function parseCacheTranscript(text:string,modell:string|null){
 let letzte:Record<string,unknown>|null=null,klassen:Klasse[]=[],userAt:number|null=null;
 for(const line of text.split('\n')){
  let r;try{r=JSON.parse(line);}catch{continue;}
  if(r.isSidechain)continue;
  if(r.type==='user'){const at=Date.parse(r.timestamp);if(Number.isFinite(at))userAt=at;continue;}
  if(r.type!=='assistant'||!r.message?.usage||(modell&&r.message.model!==modell))continue;
  const u=r.message.usage,c=u.cache_creation;
  const gefunden:Klasse[]=[];if(c?.ephemeral_5m_input_tokens>0)gefunden.push('5m');if(c?.ephemeral_1h_input_tokens>0)gefunden.push('1h');
  if(gefunden.length)klassen=gefunden;
  const at=userAt??Date.parse(r.timestamp);
  letzte={modell:r.message.model??null,request_id:r.message.id??null,request_beginn_ms:Number.isFinite(at)?at:null,nutzungsmessung_ms:Number.isFinite(Date.parse(r.timestamp))?Date.parse(r.timestamp):null,
   input:u.input_tokens??null,output:u.output_tokens??null,gelesen:u.cache_read_input_tokens??null,geschrieben:u.cache_creation_input_tokens??null,
   kontext_tokens:(u.input_tokens??0)+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0)};
 }
 return {letzte,klassen};
}
async function sendeCache($:EngineInterface):Promise<void>{
 if(!frei||sendend||!offen)return;
 const snapshot=offen;offen=null;sendend=true;
 try{
  let basis='http://localhost/cache-waechter';
  if(!runtimeModus){
   const home=(await $.env.get('HOME'))??(await $.env.get('USERPROFILE'))??'';
   const port=(await $.fs.read(home+'/.synapse/file-watcher/daemon.port')).trim();
   basis='http://127.0.0.1:'+port+'/mod-inbox/cache-waechter';
  }
  const r=await $.http.fetch(basis,{method:'POST',headers:{'content-type':'application/json'},
   ...(runtimeSocket?{socketPath:runtimeSocket}:{}),
   body:JSON.stringify({sitzung:await $.session.id(),generation:snapshot.generation,messung:snapshot})});
  if(!r.ok&&r.status!==409)offen=offen??snapshot;
 }catch{offen=offen??snapshot;}finally{sendend=false;}
 // Ein fehlgeschlagener Versand wartet auf den nächsten normalen Daemon-Abruf, keine eigene Retry-/Keepalive-Schleife.
}
async function meldeCache($:EngineInterface):Promise<void>{
 if(!frei||!messung)return;
 messung={...messung,generation:runtimeGeneration,messung_ms:await $.clock.now()};offen={...messung};void sendeCache($);
}
function leereMessung():Messung{return {modell:null,request_id:null,messung_ms:0,request_beginn_ms:null,nutzungsmessung_ms:null,input:null,output:null,gelesen:null,geschrieben:null,kontext_tokens:null,ttl_klassen:[],ttl_quelle:'unbekannt',cli_version:null,mod_version:'0.3.0'};}
export async function leseCacheTranscript($:EngineInterface):Promise<void>{
 if(runtimeModus)await runtimeFreigabe($);
 if(!frei||!transcript)return;
 try{
  // fs.read hat die native4MiB-Grenze. Bei größeren Transcripts begrenzt tail die reine Metadaten-Leseprobe.
  let text:string;
  try{text=await $.fs.read(transcript);}catch{
   const r=await $.process.run(['tail','-c','4000000',transcript]);if(r.exitCode!==0)return;text=r.stdout;
  }
  const p=parseCacheTranscript(text,messung?.modell??null);
  messung=messung??leereMessung();
  // P22-T194: kanonische Provider-Request-ID verbindet Mod und Wrapper ohne Doppelzaehlung.
  // Einen alten Transcript-Turn niemals auf die neue native Messung anwenden.
  if(p.letzte&&(!messung.request_beginn_ms||(
   typeof p.letzte.nutzungsmessung_ms==='number'&&p.letzte.nutzungsmessung_ms>=messung.request_beginn_ms
   &&p.letzte.gelesen===messung.gelesen&&p.letzte.geschrieben===messung.geschrieben))){
   messung={...messung,...p.letzte} as Messung;
  }
  if(p.klassen.length){messung.ttl_klassen=p.klassen;messung.ttl_quelle='transcript';}
  await meldeCache($);
 }catch{ /* TTL bleibt unbekannt. Der Daemon zeigt fehlende Messung/Laufbindung im Debug; der Arbeitslauf bleibt frei. */ }
}
export async function aktualisiereCacheFreigabe($:EngineInterface,wert:unknown):Promise<void>{
 const neu=!!wert&&typeof wert==='object'&&(wert as {aktiv?:unknown}).aktiv===true;
 const vorher=frei;frei=neu;
 if(!neu){messung=null;offen=null;return;}
 if(!vorher){messung=leereMessung();try{messung.cli_version=(await $.session.version()).version;}catch{/* optionales Versionsfeld */}if(!runtimeModus)await leseCacheTranscript($);}
 else if(offen)void sendeCache($);
}
export async function beobachteCacheRequest($:EngineInterface,e:{turnId:string;index:number;model:string},u:{input_tokens:number;output_tokens:number;cache_read_input_tokens:number;cache_creation_input_tokens:number;model:string}|null,sentAt:number):Promise<void>{
 if(!frei||!u)return;
 const alt=messung;
 messung={...(alt??leereMessung()),modell:u.model??e.model,request_id:e.turnId+':'+e.index,request_beginn_ms:sentAt,nutzungsmessung_ms:await $.clock.now(),
  input:u.input_tokens,output:u.output_tokens,gelesen:u.cache_read_input_tokens,geschrieben:u.cache_creation_input_tokens,
  kontext_tokens:u.input_tokens+u.cache_read_input_tokens+u.cache_creation_input_tokens};
 if(alt?.modell&&alt.modell!==messung.modell){messung.ttl_klassen=[];messung.ttl_quelle='unbekannt';}
 await meldeCache($);
}
export async function beobachteCacheKontext($:EngineInterface,tokens:number|undefined):Promise<void>{
 if(!frei||tokens===undefined)return;
 messung={...(messung??leereMessung()),kontext_tokens:tokens};await meldeCache($);
}
export async function cacheModellGewechselt($:EngineInterface,modell:string):Promise<void>{
 if(!frei)return;
 messung={...leereMessung(),modell};await meldeCache($);
}
