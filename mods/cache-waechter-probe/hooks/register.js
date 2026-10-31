// P22-T194: nur explizit gestartete Wegwerfprobe. Keine API, keine Modellaufrufe aus dem Mod.
 let rows=[],chain=Promise.resolve();
 const record=async($,event,data={})=>{
  const path=await $.env.get('SYNAPSE_CACHE_PROBE_AUSGABE');
  if(!path)return;
  const row={event,session_id:await $.session.id(),at:await $.clock.now(),...data};
  rows.push(row);if(rows.length>200)rows.shift();
  chain=chain.then(()=>$.fs.write(path,JSON.stringify(rows,null,2))).catch(()=>{});
  await chain;
 };
 const fields=e=>Object.fromEntries(['source','model','context_tokens','prompt_cache_warm','cache_ttl','seconds_since_last_response','prompt_cache_likely_expired','estimated_cache_write_usd','pricing'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]));
 const transcript=async($,e)=>{
  if(!e.transcript_path)return [];
  try{const text=await $.fs.read(e.transcript_path);return text.split('\n').flatMap(line=>{try{const r=JSON.parse(line);if(r.type!=='assistant'||r.isSidechain||!r.message?.usage)return [];return [{id:r.message.id,at:r.timestamp,model:r.message.model,usage:r.message.usage}];}catch{return [];}}).slice(-10);}
  catch(err){return [{error:String(err).slice(0,150)}];}
 };
export const register = on => {
 on('session.start',async($,e,next)=>{await record($,'session.start',{interactive:e.isInteractive});return next(e);});
 on('classic.SessionStart',async($,e,next)=>{const r=await next(e);await record($,'classic.SessionStart',{...fields(e),transcript:await transcript($,e)});return r;});
 on('classic.Stop',async($,e,next)=>{const r=await next(e);await record($,'classic.Stop',{...fields(e),transcript:await transcript($,e)});return r;});
 on('classic.PreModelSwitch',async($,e,next)=>{const r=await next(e);await record($,'classic.PreModelSwitch',{...fields(e),transcript:await transcript($,e)});return r;});
 on('classic.PostModelSwitch',async($,e,next)=>{const r=await next(e);await record($,'classic.PostModelSwitch',{...fields(e),transcript:await transcript($,e)});return r;});
 on('session.measure',async($,e,next)=>{await record($,'session.measure',{context:e.context});return next(e);});
 on('turn.step',async function*($,e,next){
  const sent_at=await $.clock.now();
  await record($,'turn.step.begin',{turnId:e.turnId,index:e.index,model:e.model,agentId:e.agentId??null});
  const result=yield* next(e);
  await record($,'turn.step.end',{sent_at,turnId:e.turnId,index:e.index,usage:result.usage});
  return result;
 });
 on('turn.complete',async($,e,next)=>{const r=await next(e);await record($,'turn.complete',{turnId:e.turnId,usage:e.usage,durationMs:e.durationMs});return r;});
};
