// P22-T194 Schritt1: reiner Beobachter, keine classic-Hooks, API oder Prompt-Zustellung.
let rows=[],chain=Promise.resolve();
const record=async($,event,data={})=>{
 const path=await $.env.get('SYNAPSE_CACHE_KOMPAT_AUSGABE');if(!path)return;
 rows.push({event,session_id:await $.session.id(),at:await $.clock.now(),...data});
 chain=chain.then(()=>$.fs.write(path,JSON.stringify(rows))).catch(()=>{});await chain;
};
const usage=u=>u?{model:u.model??null,counts:[u.input_tokens??null,u.output_tokens??null,u.cache_read_input_tokens??null,u.cache_creation_input_tokens??null]}:null;
export const register=on=>{
 on('session.start',async($,e,next)=>{await record($,'session.start',{interactive:e.isInteractive});return next(e);});
 on('session.measure',async($,e,next)=>{await record($,'session.measure',{context:[e.context.tokens,e.context.window,e.context.percent]});return next(e);});
 on('turn.step',async function*($,e,next){
  await record($,'turn.step.begin',{model:e.model,agent_id:e.agentId??null,turn_id:e.turnId,index:e.index});
  const r=yield* next(e);await record($,'turn.step.end',{turn_id:e.turnId,index:e.index,usage:usage(r.usage)});return r;
 });
 on('turn.complete',async($,e,next)=>{const r=await next(e);await record($,'turn.complete',{turn_id:e.turnId,usage:usage(e.usage)});return r;});
};
