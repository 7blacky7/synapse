/** P20-T16: lokale Drain-/Unload-Zustandsmaschine; Prozessstopp erzeugt kein Ack. */
import type {ComputeControlCommand,ComputeControlObservation,ComputeControlResponse} from '@synapse/core';
type Fetch=typeof fetch;
export class ComputeNodeControl {
 private command:ComputeControlCommand|null=null;
 private allowed=true;
 private negotiated=false;
 private policyRevision=-1;
 private nodeUpdatedAt=-Infinity;
 private unloading:Promise<void>|null=null;
 private observation:ComputeControlObservation|undefined;
 private batches=0;
 constructor(private readonly bootId:string,private readonly deviceId:string,private readonly model:string,
  private readonly digest:string,private readonly backend:string,private readonly readDevice:()=>Promise<boolean>,private readonly parse:(raw:unknown)=>ComputeControlCommand,private readonly fetcher:Fetch=fetch){
  const u=new URL(backend);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw Error('control_backend_not_local');
 }
 receive(response:ComputeControlResponse|undefined):void{
  if(!response)return;this.negotiated=true;
  if(typeof response.allowed!=='boolean'){this.allowed=false;throw Error('control_policy_invalid');}
  const stamp=Date.parse(response.nodeUpdatedAt);
  if(!Number.isSafeInteger(response.policyRevision)||!Number.isFinite(stamp)){this.allowed=false;throw Error('control_policy_revision_invalid');}
  if(response.policyRevision>=this.policyRevision&&stamp>=this.nodeUpdatedAt){
   this.allowed=response.allowed;this.policyRevision=response.policyRevision;this.nodeUpdatedAt=stamp;
  }
  if(!response.desired)return;
  let c:ComputeControlCommand;
  try{c=this.parse(response.desired);}catch(error){this.allowed=false;throw error;}
  if(c.bootId!==this.bootId||c.deviceId!==this.deviceId){this.allowed=false;throw Error('control_target_mismatch');}
  if(this.command&&c.revision<this.command.revision)return;
  if(this.command&&c.revision===this.command.revision){
   if(JSON.stringify(c)!==JSON.stringify(this.command)){this.allowed=false;throw Error('control_revision_conflict');}
   return;
  }
  this.command=c;this.observation=undefined;
 }
 canClaim():boolean{return !this.unloading&&this.allowed&&(!this.command||this.command.action==='resume'&&Date.parse(this.command.deadline)>Date.now());}
 begin():boolean{if(!this.canClaim())return false;this.batches++;return true;}
 end():void{this.batches=Math.max(0,this.batches-1);}
 report():ComputeControlObservation|undefined{return this.observation?{...this.observation,activeBatches:this.batches}:undefined;}
 async settle(pendingClaims:number):Promise<void>{
  const c=this.command;if(!this.negotiated||!c)return;
  const observe=(state:ComputeControlObservation['state'],present:boolean|null,ack=false)=>{
   if(this.command?.revision!==c.revision)return;
   this.observation={revision:c.revision,bootId:this.bootId,state,activeBatches:this.batches,pendingClaims,modelPresent:present,measuredAt:new Date().toISOString(),
    ...(ack&&Date.parse(c.deadline)>Date.now()?{ackRevision:c.revision}:{})};
  };
  if(c.action==='resume'){observe(this.canClaim()?'running':'pending',null,this.canClaim());return;}
  if(this.batches||pendingClaims){observe('draining',null);return;}
  if(this.unloading){await this.unloading;return;}
  this.unloading=(async()=>{
   try{
    if(!await this.readDevice())throw Error('control_device_unverified');
    const ps=async()=>{const r=await this.fetcher(this.backend+'/api/ps',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)throw Error('control_ps_failed');
     const p=await r.json() as {models?:Array<{name?:string;model?:string;digest?:string}>};if(!Array.isArray(p.models))throw Error('control_ps_invalid');return p.models;};
    const name=(s:string)=>s.includes(':')?s:s+':latest',normal=(s:string)=>s.toLowerCase().replace(/^sha256:/,'');
    const own=(m:{name?:string;model?:string})=>name(m.model??m.name??'')===name(this.model);
    const loaded=(await ps()).filter(own);
    if(loaded.some(m=>typeof m.digest!=='string'||normal(m.digest)!==normal(this.digest)))throw Error('control_model_owner_unknown');
    // Nie ein anderes Modell entladen. Auch ein fehlender Digest bleibt unklar.
    if(loaded.length){
     const r=await this.fetcher(this.backend+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:this.model,keep_alive:0,stream:false}),signal:AbortSignal.timeout(10000),redirect:'error'});
     if(!r.ok)throw Error('control_unload_failed');await r.arrayBuffer();
    }
    const absent=!(await ps()).some(own),device=await this.readDevice();
    observe(absent&&device?'unloaded':'pending',absent?false:true,absent&&device&&!this.batches&&!pendingClaims);
   }catch{observe('pending',null);}
  })();
  try{await this.unloading;}finally{this.unloading=null;}
 }
}
