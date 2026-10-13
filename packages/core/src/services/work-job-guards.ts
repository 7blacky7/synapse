/** Additive serverseitige Claim-Gates; ohne registriertes Gate Altverhalten. */
import type {WorkJobClient,WorkJob} from './work-jobs.js';
export interface WorkJobClaimGuard {
 lock(client:WorkJobClient):Promise<void>;
 allow(job:WorkJob,client:WorkJobClient):Promise<boolean>;
}
const guards=new Map<string,WorkJobClaimGuard>();
export function registerWorkJobClaimGuard(name:string,guard:WorkJobClaimGuard):()=>void {
 guards.set(name,guard);return ()=>{if(guards.get(name)===guard)guards.delete(name);};
}
export async function lockWorkJobClaimGuards(client:WorkJobClient):Promise<void>{
 for(const [,guard] of [...guards].sort(([a],[b])=>a.localeCompare(b)))await guard.lock(client);
}
export async function allowWorkJobClaim(job:WorkJob,client:WorkJobClient):Promise<boolean>{
 for(const guard of guards.values())if(!await guard.allow(job,client))return false;
 return true;
}
