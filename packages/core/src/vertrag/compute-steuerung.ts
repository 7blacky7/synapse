/** P20-T16: Soll und Beobachtung laufen ausschließlich über Heartbeat/Claims. */
export type ComputeControlAction='pause'|'drain'|'unload'|'resume';
export interface ComputeControlCommand {
 revision:number;bootId:string;action:ComputeControlAction;capability:'embedding';
 deviceId:string;reason:string;deadline:string;
}
export interface ComputeControlObservation {
 revision:number;bootId:string;state:'running'|'draining'|'pending'|'unloaded';
 activeBatches:number;pendingClaims:number;modelPresent:boolean|null;measuredAt:string;
 ackRevision?:number;
}
export interface ComputeControlResponse {
 desired:ComputeControlCommand|null;allowed:boolean;policyRevision:number;nodeUpdatedAt:string;
}
export function parseComputeControlCommand(raw:unknown):ComputeControlCommand {
 const a=raw as ComputeControlCommand;
 if(!a||typeof a!=='object'||!Number.isSafeInteger(a.revision)||a.revision<1||
  typeof a.bootId!=='string'||!a.bootId||!['pause','drain','unload','resume'].includes(a.action)||
  a.capability!=='embedding'||typeof a.deviceId!=='string'||!a.deviceId||
  typeof a.reason!=='string'||a.reason.length>1000||!Number.isFinite(Date.parse(a.deadline)))
  throw Error('invalid_compute_control');
 return {revision:a.revision,bootId:a.bootId,action:a.action,capability:a.capability,deviceId:a.deviceId,reason:a.reason,deadline:a.deadline};
}
export function parseComputeControlObservation(raw:unknown):ComputeControlObservation {
 const a=raw as ComputeControlObservation;
 if(!a||typeof a!=='object'||!Number.isSafeInteger(a.revision)||a.revision<1||
  typeof a.bootId!=='string'||!a.bootId||!['running','draining','pending','unloaded'].includes(a.state)||
  !Number.isSafeInteger(a.activeBatches)||a.activeBatches<0||!Number.isSafeInteger(a.pendingClaims)||a.pendingClaims<0||
  ![true,false,null].includes(a.modelPresent)||!Number.isFinite(Date.parse(a.measuredAt))||
  a.ackRevision!==undefined&&a.ackRevision!==a.revision)throw Error('invalid_compute_control_observation');
 return {revision:a.revision,bootId:a.bootId,state:a.state,activeBatches:a.activeBatches,pendingClaims:a.pendingClaims,
  modelPresent:a.modelPresent,measuredAt:a.measuredAt,...(a.ackRevision!==undefined?{ackRevision:a.ackRevision}:{})};
}
