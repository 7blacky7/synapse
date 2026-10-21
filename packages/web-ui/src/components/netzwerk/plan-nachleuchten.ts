/** P22-T102: retain only API plan metadata; local deadlines never reset on polling. */
import type {NetzPlan,NetzSnapshot} from '../../api/agentennetzwerk';

type AnzeigePlan=NetzPlan & {nachleuchten_bis?:number;nachleuchten_dauer?:number};
export const PLAN_FARBEN={offen:'#fcd34d',committet:'#86efac',auto:'#38bdf8',verworfen:'#f87171'} as const;
export function planZustand(p:NetzPlan):'offen'|'committet'|'auto-committet'|'verworfen'{
 return p.status==='open'?'offen':p.status==='committed'?(p.auto_commit?'auto-committet':'committet'):'verworfen';
}
export function planFarbe(p:NetzPlan):string{
 const st=planZustand(p);return st==='offen'?PLAN_FARBEN.offen:st==='auto-committet'?PLAN_FARBEN.auto:st==='committet'?PLAN_FARBEN.committet:PLAN_FARBEN.verworfen;
}
/** Defaults only for older API snapshots without the new setting keys. */
function fristen(s:Pick<NetzSnapshot,'werte'>){
 return {fenster:(s.werte.plan_nachleuchten_sekunden??30)*1000,mindest:(s.werte.plan_mindestanzeige_sekunden??3)*1000};
}
export function planFade(plan:NetzPlan,jetzt:number,s:Pick<NetzSnapshot,'werte'>):number{
 if(plan.status==='open')return 1;
 if(plan.status!=='committed')return 0;
 const p=plan as AnzeigePlan,{fenster}=fristen(s);
 return Math.max(0,Math.min(1,((p.nachleuchten_bis??Date.parse(p.committed??'')+fenster)-jetzt)/(p.nachleuchten_dauer??fenster)))||0;
}
export class PlanNachleuchten{
 private plaene=new Map<string,AnzeigePlan>();
 aktualisiere(s:NetzSnapshot,jetzt:number):NetzSnapshot{
  if(!s.schalter.aktiv){this.plaene.clear();return {...s,plaene:[]};}
  const {fenster,mindest}=fristen(s),stand=Date.parse(s.stand)||jetzt,ende=new Map(s.plaene_ende?.map(p=>[p.id,p.status]));
  const aktuell=new Set(s.plaene?.map(p=>p.id));
  for(const [id,p]of this.plaene){
   const st=ende.get(id);
   if((st&&st!=='committed')||((p.nachleuchten_bis??0)<=jetzt&&!aktuell.has(id)))this.plaene.delete(id);
  }
  for(const p of s.plaene??[]){
   if(p.status==='open'){this.plaene.delete(p.id);continue;}
   if(p.status!=='committed'||!Number.isFinite(Date.parse(p.committed??'')))continue;
   const alt=this.plaene.get(p.id),dauer=Math.max(mindest,fenster-Math.max(0,stand-Date.parse(p.committed!)));
   this.plaene.set(p.id,{...p,nachleuchten_bis:alt?.nachleuchten_bis??jetzt+dauer,nachleuchten_dauer:alt?.nachleuchten_dauer??dauer});
  }
  return {...s,plaene:[...(s.plaene??[]).filter(p=>p.status==='open'),
   ...[...this.plaene.values()].filter(p=>planFade(p,jetzt,s)>0)]};
 }
}
