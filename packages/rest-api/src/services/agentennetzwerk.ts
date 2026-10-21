/** P22-T93: serverseitige Projektion bestehender API-Daten; kein DB-Zugriff im Browser. */
import { getPool, hauptagentIdentitaetsId, HAUPTAGENT_AGENT_ID, leseNetzwerkKonfiguration, netzwerkEreignis, netzwerkText, type ToolCallRow } from '@synapse/core';
import { ladeAgentenTeam, type TeamAgent } from './agenten-team.js';

export async function ladeAgentennetzwerk(project: string) {
 const konfiguration = await leseNetzwerkKonfiguration(project);
 const basis = { success: true, version: 1, project, stand: new Date().toISOString(), ...konfiguration };
 if (!konfiguration.schalter.aktiv) return { ...basis, agenten: [], ereignisse: [], begrenzt: 0 };
 const mainId = await hauptagentIdentitaetsId();
 const [team, r, starts, mainTeam, frequenz, channelCalls] = await Promise.all([
  ladeAgentenTeam(project),
  getPool().query<ToolCallRow & { gesamt: string; ist_main: boolean }>(`
   SELECT c.id::text,c.ts,c.project,c.agent_id,c.identity_id,c.lauf_id,c.context_epoch,c.source,
          c.tool_name,c.action,c.args_preview,c.ok,c.error,c.duration_ms,c.is_mutation,COUNT(*) OVER()::text AS gesamt,
          (c.identity_id=$2 OR (c.identity_id IS NULL AND (c.agent_id=$3 OR c.agent_id IN (SELECT 'main-'||id::text FROM agent_runtime_sessions)))) AS ist_main
   FROM tool_calls c LEFT JOIN agent_identitaeten i ON i.id=c.identity_id
   WHERE (c.project=$1 OR c.identity_id=$2 OR (c.identity_id IS NULL AND
     (c.agent_id=$3 OR c.agent_id IN (SELECT 'main-'||id::text FROM agent_runtime_sessions))))
    AND c.ts >= NOW()-($4::int * INTERVAL '1 second')
    AND (c.identity_id IS NULL OR i.status='aktiv')
    AND COALESCE(c.agent_id,'') NOT LIKE 'archiv-%'
   ORDER BY c.id DESC LIMIT $5`, [project, mainId, HAUPTAGENT_AGENT_ID, Math.max(konfiguration.werte.inaktiv_sekunden,konfiguration.werte.aktivitaet_sekunden), konfiguration.werte.ereignis_limit]),
  getPool().query<{ziel:string;actor_identity_id:string;id:string}>(`
   SELECT DISTINCT ON (COALESCE(j.target_identity_id,ziel->>'identity_id',ziel->>'name'))
    COALESCE(j.target_identity_id,ziel->>'identity_id',ziel->>'name') AS ziel,j.actor_identity_id,j.id
   FROM specialist_jobs j CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN j.action='spawn_batch' AND jsonb_typeof(j.args->'agents')='array' THEN j.args->'agents'
     ELSE jsonb_build_array(j.args) END) ziel
   WHERE j.project=$1 AND j.action IN ('spawn','spawn_batch') AND j.status='done' AND j.actor_identity_id IS NOT NULL
   ORDER BY COALESCE(j.target_identity_id,ziel->>'identity_id',ziel->>'name'),j.completed_at DESC NULLS LAST,j.created_at DESC
   LIMIT $2`,[project,konfiguration.werte.ereignis_limit]),
  ladeAgentenTeam('synapse-hauptagent', { hauptagent: true }),
  getPool().query<{identity_id:string|null;agent_id:string;anzahl:string;letzte:Date;tool:string;action:string}>(`
   SELECT c.identity_id,c.agent_id,COUNT(*)::text AS anzahl,MAX(c.ts) AS letzte,
    (array_agg(c.tool_name ORDER BY c.ts DESC,c.id DESC))[1] AS tool,
    (array_agg(c.action ORDER BY c.ts DESC,c.id DESC))[1] AS action
   FROM tool_calls c LEFT JOIN agent_identitaeten i ON i.id=c.identity_id
   WHERE (c.project=$1 OR c.identity_id=$2 OR (c.identity_id IS NULL AND (c.agent_id=$3 OR c.agent_id IN (SELECT 'main-'||id::text FROM agent_runtime_sessions))))
    AND c.ts>=NOW()-($4::int * INTERVAL '1 second') AND (c.identity_id IS NULL OR i.status='aktiv')
    AND COALESCE(c.agent_id,'') NOT LIKE 'archiv-%'
   GROUP BY c.identity_id,c.agent_id`,[project,mainId,HAUPTAGENT_AGENT_ID,konfiguration.werte.aktivitaet_sekunden]),
  // Eigener begrenzter Ausschnitt: aktive Channels duerfen bei Shell-/Code-Spitzen nicht verschwinden.
  getPool().query<ToolCallRow>(`
   SELECT c.id::text,c.ts,c.project,c.agent_id,c.identity_id,c.lauf_id,c.tool_name,c.action,c.args_preview,c.ok
   FROM tool_calls c LEFT JOIN agent_identitaeten i ON i.id=c.identity_id
   WHERE c.project=$1 AND (c.tool_name='channel' OR c.tool_name LIKE '%__channel')
    AND (c.args_preview LIKE '%"channel_name"%' OR c.args_preview LIKE '%"name"%')
    AND c.ts>=NOW()-($2::int*INTERVAL '1 second') AND (c.identity_id IS NULL OR i.status='aktiv')
    AND COALESCE(c.agent_id,'') NOT LIKE 'archiv-%'
   ORDER BY c.id DESC LIMIT $3`,[project,konfiguration.werte.inaktiv_sekunden,konfiguration.werte.ereignis_limit]),
 ]);
 const meta=(a:TeamAgent|undefined)=>({
  typ:a?.typ?netzwerkText(a.typ):null,modell:a?.modell?netzwerkText(a.modell):null,
  ort:a?.herkunft.ort?netzwerkText(a.herkunft.ort):null,ort_quelle:a?.herkunft.quelle?netzwerkText(a.herkunft.quelle):null,
  letzte_anmeldung:a?.letzte_anmeldung?.zeit?.iso??null,metadaten_quelle:'agenten-team',
 });
 const agenten = (team.agenten as TeamAgent[]).map(a => ({
  ...meta(a), id: a.identity_id || a.agent_id, agent: netzwerkText(a.agent_id), name: netzwerkText(a.name),
  rolle: a.rolle === 'koordinator' ? 'koordinator' : 'arbeitsagent', project, identity_id: a.identity_id,
  zuletzt_aktiv: a.zuletzt_aktiv, kanaele: a.wrapper?.channels.map(netzwerkText) ?? [],
 }));
 const main = { ...meta((mainTeam.agenten as TeamAgent[]).find(a=>a.identity_id===mainId||a.agent_id===HAUPTAGENT_AGENT_ID)), id: mainId || HAUPTAGENT_AGENT_ID, agent: HAUPTAGENT_AGENT_ID, name: 'Hauptagent', rolle: 'main',
  project: 'synapse-hauptagent', identity_id: mainId, zuletzt_aktiv: null, kanaele: [] };
 const ereignisse = r.rows.reverse().map(netzwerkEreignis);
 const channel_ereignisse=channelCalls.rows.reverse().map(netzwerkEreignis);
 // Legacy main-session-Namen sind Anzeige-Aliase derselben Hauptidentitaet.
 for (const [index, e] of ereignisse.entries()) if (r.rows[index].ist_main) e.agent = main.agent;
 // Zuordnung ist eine belegte Beziehung, kein aus Namen geratenes Team.
 const alle = [main, ...agenten];
 const alias = new Map(alle.flatMap(a=>[[a.id,a],[a.agent,a],[a.name,a]] as const));
 const koordinierung = new Map<string,{koordinator_id:string;quelle:string;beleg_id:string}>();
 for(const j of starts.rows){
  const ziel=alias.get(j.ziel),koordinator=alias.get(j.actor_identity_id);
  if(ziel?.rolle==='arbeitsagent'&&koordinator?.rolle==='koordinator')
   koordinierung.set(ziel.id,{koordinator_id:koordinator.id,quelle:'specialist_jobs.spawn',beleg_id:j.id});
 }
 // Ohne Startbeleg gilt die juengste direkte Kommunikation innerhalb des Aktivitaetsfensters.
 const kommunikation = new Map<string,{koordinator_id:string;quelle:string;beleg_id:string}>();
 for(const e of ereignisse) if(e.ok&&e.tool==='chat'&&e.interaktion==='senden'){
  const sender=alias.get(e.identity_id??e.agent)??alias.get(e.agent);
  for(const empfaenger of e.empfaenger){
   const ziel=alias.get(empfaenger);
   if(sender?.rolle==='koordinator'&&ziel?.rolle==='arbeitsagent')
    kommunikation.set(ziel.id,{koordinator_id:sender.id,quelle:'tool_calls.chat',beleg_id:e.id});
   if(sender?.rolle==='arbeitsagent'&&ziel?.rolle==='koordinator')
    kommunikation.set(sender.id,{koordinator_id:ziel.id,quelle:'tool_calls.chat',beleg_id:e.id});
  }
 }
 const frequenzen=new Map<string,{anzahl:number;zeit:string;tool:string;action:string}>();
 for(const f of frequenz.rows){
  const id=alias.get(f.identity_id??f.agent_id)?.id??alias.get(f.agent_id)?.id??f.agent_id;
  const alt=frequenzen.get(id),neu={anzahl:Number(f.anzahl)+(alt?.anzahl??0),zeit:f.letzte.toISOString(),tool:netzwerkText(f.tool.split('__').pop()),action:netzwerkText(f.action)};
  frequenzen.set(id,alt&&alt.zeit>neu.zeit?{...alt,anzahl:neu.anzahl}:neu);
 }
 return { ...basis, agenten: alle.map(a=>({...a,
  aufrufe_im_fenster:frequenzen.get(a.id)?.anzahl??0,
  letzter_aufruf:frequenzen.get(a.id)??null,
  zuletzt_aktiv:frequenzen.get(a.id)?.zeit??a.zuletzt_aktiv,
  koordination:koordinierung.get(a.id)??kommunikation.get(a.id)??null})), ereignisse, channel_ereignisse,
  begrenzt: Math.max(0, Number(r.rows[0]?.gesamt ?? 0) - r.rows.length),
  quellen: ['tool_calls','agenten-team','hauptagentIdentitaetsId','specialist_jobs.spawn','tool_calls.chat'], cursor: ereignisse.at(-1)?.id ?? null };
}
