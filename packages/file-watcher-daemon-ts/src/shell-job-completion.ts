/** P9-T26: beendete Prozesse werden nie wegen eines verlorenen PG-Abschlusses neu ausgeführt. */
import type {ShellJobCompletion} from '@synapse/core';
interface Dependencies {
 complete:(id:string,result:ShellJobCompletion)=>Promise<void>;
 report:(id:string,error:unknown,versuch:number)=>void;
 wait?:(ms:number)=>Promise<void>;
}
export class ShellAbschlussWiederholung {
 private readonly pending=new Map<string,{result:ShellJobCompletion;versuche:number}>();
 private readonly sending=new Map<string,Promise<boolean>>();
 constructor(private readonly deps:Dependencies){}
 has(id:string):boolean{return this.pending.has(id);}
 get size():number{return this.pending.size;}
 async complete(id:string,result:ShellJobCompletion):Promise<boolean>{
  if(!this.pending.has(id))this.pending.set(id,{result,versuche:0});
  return this.retry(id);
 }
 private retry(id:string):Promise<boolean>{
  const existing=this.sending.get(id);if(existing)return existing;
  const send=async()=>{
   const entry=this.pending.get(id);if(!entry)return true;
   for(let round=0;round<3;round++){
    try{
     await this.deps.complete(id,entry.result);this.pending.delete(id);return true;
    }catch(error){
     entry.versuche++;this.deps.report(id,error,entry.versuche);
     // Nach wiederholtem Ergebnisfehler bleibt eine minimale ehrliche Fehlermeldung
     // retrybar. Kein erneutes Ausführen des Kommandos, auch bei dauerhafter DB-Störung.
     if(entry.versuche>=6)entry.result={status:'failed',error:'completion_persistence_failed',output_truncated:true,
      message:'Shellprozess beendet; Ergebnis konnte nicht gespeichert werden. Abschluss wird erneut versucht.'};
     if(round<2)await (this.deps.wait??(ms=>new Promise(r=>setTimeout(r,ms))))(100*(round+1));
    }
   }
   return false;
  };
  const running=send().finally(()=>{this.sending.delete(id);});
  this.sending.set(id,running);return running;
 }
 async flush():Promise<void>{for(const id of [...this.pending.keys()])await this.retry(id);}
}
/** Nur tatsächliches Ende oder ESRCH gilt als Nachweis. EPERM/unbekannt bleibt laufend. */
export function shellProzessEnde(
 meta:{status?:unknown;pid?:unknown}|null,
 probe:(pid:number)=>void=(pid)=>process.kill(pid,0),
):boolean{
 if(!meta)return false;
 if(meta.status==='done'||meta.status==='failed')return true;
 if(meta.status!=='running'||typeof meta.pid!=='number'||!Number.isSafeInteger(meta.pid)||meta.pid<=0)return false;
 try{probe(meta.pid);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
}
