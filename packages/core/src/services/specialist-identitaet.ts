/** P22-T15: Explizites Ziel name="identity:<UUID>" (kein Namensfallback). */
import { getPool } from '../db/client.js';
import { mitAgentAufrufKontext, aktuellerAgentAufruf, leseAgentBezugModus, loeseAgentZiel } from './agent-bezug.js';
import { enqueueSpecialistJob, waitForSpecialistJob, type SpecialistAction } from './specialist-queue.js';
import { getWrapperStatus, steuereHeartbeat } from './wrapper-status.js';
import { postToInbox } from './inbox.js';

/** null = unveränderter Legacy-Handler. Gleiches Routing für REST und stdio. */
export async function fuehreSpecialistIdentitaetsAktion(
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const specs = args.action === 'spawn_batch' && Array.isArray(args.specialists) ? args.specialists : null;
  const namen = Array.isArray(args.name) ? args.name : null;
  const hatId = typeof args.name === 'string' && args.name.startsWith('identity:')
    || namen?.some(n => typeof n === 'string' && n.startsWith('identity:'))
    || specs?.some(s => s && typeof s === 'object' && typeof s.name === 'string' && s.name.startsWith('identity:'));
  if (!hatId) return null;
  if (!aktuellerAgentAufruf()) return mitAgentAufrufKontext(
    {principal:null,bezug:await leseAgentBezugModus()},()=>fuehreSpecialistIdentitaetsAktion(args));
  if (aktuellerAgentAufruf()?.bezug.modus === 'alt') return {success:false,error:'specialist_identity_im_altmodus'};
  if (namen || specs) {
    const items = specs ?? namen!.map(name => ({name}));
    const results: Record<string,unknown>[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') throw new Error('specialist_batch_ziel_ungueltig');
      const teil = { ...args,...item,action:specs ? 'spawn' : args.action };
      const identityResult = await fuehreSpecialistIdentitaetsAktion(teil);
      if (identityResult) results.push(identityResult);
      else {
        const action = String(teil.action ?? '');
        if (action === 'heartbeat') results.push({success:true,...await steuereHeartbeat(String(teil.project),[String(teil.name)],
          { ...(typeof teil.heartbeat_enabled === 'boolean' ? {enabled:teil.heartbeat_enabled} : {}),
            ...('heartbeat_interval_ms' in teil ? {intervalMs:teil.heartbeat_interval_ms === null ? null : Number(teil.heartbeat_interval_ms)} : {}) })});
        else if (['spawn','stop','purge','update_skill'].includes(action)) {
          const j=await enqueueSpecialistJob({project:String(teil.project),action:action as SpecialistAction,args:teil});
          const r=await waitForSpecialistJob(j.id,60_000);
          results.push(r.status==='done' ? r.result ?? {success:true} : {success:false,status:r.status,error:r.error});
        } else results.push({success:false,error:'specialist_batch_aktion_unbekannt'});
      }
    }
    return {success:results.every(r=>r.success!==false),count:results.length,results};
  }
  if (typeof args.name !== 'string' || !args.name.startsWith('identity:')) return null;
  const project = typeof args.project === 'string' ? args.project : '';
  const bezug = aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  if (bezug.modus === 'alt') return { success: false, error: 'specialist_identity_im_altmodus' };
  const ziel = await loeseAgentZiel(project, { identity_id: args.name.slice(9) });
  if (ziel.art !== 'identity') throw new Error('specialist_ziel_ungueltig');
  const action = String(args.action ?? '');
  if (action === 'status') {
    const status = await getWrapperStatus(ziel, project);
    return { success: !!status, specialist: status, identity_id: ziel.identity_id };
  }
  if (action === 'heartbeat') {
    const konfiguration = args.heartbeat_enabled !== undefined || args.heartbeat_interval_ms !== undefined
      ? { ...(typeof args.heartbeat_enabled === 'boolean' ? { enabled: args.heartbeat_enabled } : {}),
          ...(args.heartbeat_interval_ms === null || typeof args.heartbeat_interval_ms === 'number' ? { intervalMs: args.heartbeat_interval_ms } : {}) } : undefined;
    return { success: true, ...await steuereHeartbeat(project,[ziel],konfiguration) };
  }
  if (action === 'wake') {
    if (typeof args.message !== 'string' || !args.message) throw new Error('specialist_wake_nachricht_fehlt');
    // Durable Inbox ist Grundlage, NOTIFY nur Beschleuniger. Keine Namenszustellung.
    const inbox = await postToInbox(aktuellerAgentAufruf()?.principal?.agent_id ?? 'specialist-wake',ziel,args.message,project);
    let notified = false;
    try {
      await getPool().query('SELECT pg_notify($1,$2)',[
        'synapse_identity_wake_' + ziel.identity_id.replace(/-/g,'_'),
        JSON.stringify({ project,identity_id:ziel.identity_id,message:args.message })]);
      notified = true;
    } catch { /* Inbox bleibt erhalten. */ }
    return { success: true, name: ziel.agent_id, identity_id: ziel.identity_id, inboxId:inbox.id,notified };
  }
  const queue: SpecialistAction[] = ['spawn','stop','purge','update_skill','rotate'];
  if (!queue.includes(action as SpecialistAction)) return { success:false,error:'specialist_identity_aktion_unbekannt' };
  const job = await enqueueSpecialistJob({ project,action:action as SpecialistAction,
    args:{ ...args,name:ziel.agent_id,identity_id:ziel.identity_id } });
  const result = await waitForSpecialistJob(job.id,60_000);
  return result.status === 'done' ? result.result ?? { success:true } :
    { success:false,status:result.status,error:result.error,message:result.message };
}
