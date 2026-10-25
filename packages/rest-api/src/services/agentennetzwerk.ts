/** P22-T93: serverseitige Projektion bestehender API-Daten; kein DB-Zugriff im Browser. */
import { getPool, hauptagentIdentitaetsId, HAUPTAGENT_AGENT_ID, leseNetzwerkKonfiguration, netzwerkEreignis, netzwerkErfolg, netzwerkText, type ToolCallRow } from '@synapse/core';

/**
 * P22-T156: SQL-Ausschnitte nur fuer die serverseitige Klassifikation (core netzwerkErgebnis). Sie werden NIE ausgeliefert:
 * netzwerkEreignis baut ein festes Objekt, das nur ergebnis_art und den normalisierten fehler_code traegt.
 */
export const ERGEBNIS_SPALTEN_SQL = `
  (c.result IS NOT NULL AND left(c.result,400) ~ '^\\s*\\{[^{}]{0,250}"success"\\s*:\\s*false') AS erfolg_false,
  (c.result IS NOT NULL AND left(c.result,600) ~ '"stufe"\\s*:\\s*"rueckfrage"' AND left(c.result,600) ~ '"ausgefuehrt"\\s*:\\s*false') AS rueckfrage,
  (c.result IS NOT NULL AND left(c.result,600) ~ '"stufe"\\s*:\\s*"anleitung"' AND left(c.result,600) ~ '"ausgefuehrt"\\s*:\\s*false') AS anleitung,
  substring(left(c.result,4000) from '"(?:error|fehler)"\\s*:\\s*"([^"]{1,120})"') AS ergebnis_code,
  substring(left(c.result,4000) from '"status"\\s*:\\s*"([a-z_]{2,40})"') AS ergebnis_status,
  substring(left(c.result,1500) from '"message"\\s*:\\s*"([^"]{1,160})') AS ergebnis_meldung`;
type ErgebnisSpalten = { erfolg_false: boolean; rueckfrage: boolean; anleitung: boolean; ergebnis_code: string | null; ergebnis_status: string | null; ergebnis_meldung: string | null };
import { ladeAgentenTeam, type TeamAgent } from './agenten-team.js';

// P22-T149: Index-Groesse (indexierte Dateien, Chunks) fuer Projektstern, Trabanten und Nebel. Je Projekt kurz gecacht, damit
// SSE-Buendel und Wiederabgleich keinen Abfragesturm ausloesen; ein Fehler liefert null (Web-UI faellt auf die feste Darstellung zurueck).
// P22-T152: Cache-Dauer je Projekt aus der eigenen Zaehldauer: unter 100 ms 10 s (Aenderungen erreichen Nebel/Trabanten schneller), sonst
// 30 s. Messung 25.10.2026 (Live, EXPLAIN ANALYZE): synapse 41 ms; parser-testkorpus (75k Dateien, 451k Chunks) warm 200 ms, kalt 3,9 s.
// Laufende Zaehlungen werden geteilt: gleichzeitige Betrachter loesen hoechstens eine Abfrage je Projekt aus.
// P22-T153: die drei Zahlen sind Netzwerk-Einstellungen (index_cache_ms, index_cache_schnell_ms, index_billig_ms); die Konstanten bleiben
// Rueckfall. Der Cache merkt sich die gemessene Zaehldauer, die Dauer wird beim Lesen aus den aktuellen Werten berechnet (wirkt sofort).
const INDEX_CACHE_MS = 30_000, INDEX_CACHE_SCHNELL_MS = 10_000, INDEX_BILLIG_MS = 100;
type IndexGroesse = { dateien: number; chunks: number; stand: string } | null;
export type IndexCacheWerte = { index_cache_ms?: number; index_cache_schnell_ms?: number; index_billig_ms?: number };
const indexCache = new Map<string, { zeit: number; dauer: number; wert: IndexGroesse }>();
const indexLaufend = new Map<string, Promise<IndexGroesse>>();
const cacheZahl = (v: number | undefined, std: number) => typeof v === 'number' && Number.isFinite(v) ? v : std;
/** P22-T153: wirksame Cache-Dauer eines Eintrags aus der gemessenen Zaehldauer und den aktuellen Einstellungen. */
export function indexCacheTtl(e: { dauer: number; wert: IndexGroesse }, w: IndexCacheWerte = {}): number {
 return e.wert && e.dauer < cacheZahl(w.index_billig_ms, INDEX_BILLIG_MS) ? cacheZahl(w.index_cache_schnell_ms, INDEX_CACHE_SCHNELL_MS) : cacheZahl(w.index_cache_ms, INDEX_CACHE_MS);
}
export async function ladeIndexGroesse(project: string, w: IndexCacheWerte = {}): Promise<IndexGroesse> {
 const alt = indexCache.get(project);
 if (alt && Date.now() - alt.zeit < indexCacheTtl(alt, w)) return alt.wert;
 const laufend = indexLaufend.get(project);
 if (laufend) return laufend;
 const zaehlung = zaehleIndex(project);
 indexLaufend.set(project, zaehlung);
 try { return await zaehlung; } finally { indexLaufend.delete(project); }
}
/** P22-T152: Cache vergessen (Tests, z. B. nach einer Index-Aenderung im privaten Schema); ohne Projekt alle. */
export function vergissIndexGroesse(project?: string) { if (project) indexCache.delete(project); else indexCache.clear(); }
/** P22-T152: wirksame Cache-Dauer eines Projekts in ms (null = noch nicht gezaehlt); P22-T153: mit den aktuellen Einstellungen. */
export function indexCacheDauer(project: string, w: IndexCacheWerte = {}): number | null { const e = indexCache.get(project); return e ? indexCacheTtl(e, w) : null; }
async function zaehleIndex(project: string): Promise<IndexGroesse> {
 const t0 = Date.now();
 let wert: IndexGroesse = null;
 try {
  const r = await getPool().query<{ dateien: number; chunks: number }>(`SELECT
   (SELECT COUNT(*) FROM code_files WHERE project=$1 AND deleted_at IS NULL AND NOT ignored)::int AS dateien,
   (SELECT COUNT(*) FROM code_chunks WHERE project=$1)::int AS chunks`, [project]);
  wert = { dateien: Number(r.rows[0]?.dateien ?? 0), chunks: Number(r.rows[0]?.chunks ?? 0), stand: new Date().toISOString() };
 } catch { wert = null; }
 indexCache.set(project, { zeit: Date.now(), dauer: Date.now() - t0, wert });
 return wert;
}

export async function ladeAgentennetzwerk(project: string) {
 const konfiguration = await leseNetzwerkKonfiguration(project);
 const basis = { success: true, version: 1, project, stand: new Date().toISOString(), ...konfiguration };
 if (!konfiguration.schalter.aktiv) return { ...basis, agenten: [], ereignisse: [], begrenzt: 0 };
 const mainId = await hauptagentIdentitaetsId();
 const [team, r, starts, mainTeam, frequenz, channelCalls, ohneAbsender] = await Promise.all([
  ladeAgentenTeam(project),
  getPool().query<ToolCallRow & ErgebnisSpalten & { gesamt: string; ist_main: boolean; ergebnis_bytes: number; ergebnis_leer: boolean }>(`
   SELECT c.id::text,c.ts,c.project,c.agent_id,c.identity_id,c.lauf_id,c.context_epoch,c.source,
          c.tool_name,c.action,c.args_preview,c.ok,c.error,c.duration_ms,c.is_mutation,COALESCE(c.result_bytes,octet_length(c.result),0)::int AS ergebnis_bytes,
          (c.ok AND c.result IS NOT NULL AND (c.result ~ '"(count|total|total_matches|anzahl)"\\s*:\\s*0\\s*[,}]' OR c.result ~ '"(results|matches|symbols|functions|treffer|items)"\\s*:\\s*\\[\\s*\\]')) AS ergebnis_leer,COUNT(*) OVER()::text AS gesamt,
          (c.identity_id=$2 OR (c.identity_id IS NULL AND (c.agent_id=$3 OR c.agent_id IN (SELECT 'main-'||id::text FROM agent_runtime_sessions)))) AS ist_main,${ERGEBNIS_SPALTEN_SQL}
   FROM tool_calls c LEFT JOIN agent_identitaeten i ON i.id=c.identity_id
   WHERE (c.project=$1 OR c.identity_id=$2 OR (c.identity_id IS NULL AND
     (c.agent_id=$3 OR c.agent_id IN (SELECT 'main-'||id::text FROM agent_runtime_sessions))))
    AND c.ts >= NOW()-($4::int * INTERVAL '1 second')
    AND (c.identity_id IS NULL OR i.status='aktiv')
    AND COALESCE(c.agent_id,'') NOT LIKE 'archiv-%'
    AND (c.agent_id IS NOT NULL OR c.identity_id IS NOT NULL)
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
    AND (c.agent_id IS NOT NULL OR c.identity_id IS NOT NULL)
   GROUP BY c.identity_id,c.agent_id`,[project,mainId,HAUPTAGENT_AGENT_ID,konfiguration.werte.aktivitaet_sekunden]),
  // Eigener begrenzter Ausschnitt: aktive Channels duerfen bei Shell-/Code-Spitzen nicht verschwinden.
  getPool().query<ToolCallRow & ErgebnisSpalten>(`
   SELECT c.id::text,c.ts,c.project,c.agent_id,c.identity_id,c.lauf_id,c.tool_name,c.action,c.args_preview,c.ok,c.error,${ERGEBNIS_SPALTEN_SQL}
   FROM tool_calls c LEFT JOIN agent_identitaeten i ON i.id=c.identity_id
   WHERE c.project=$1 AND (c.tool_name='channel' OR c.tool_name LIKE '%__channel')
    AND (c.args_preview LIKE '%"channel_name"%' OR c.args_preview LIKE '%"name"%')
    AND c.ts>=NOW()-($2::int*INTERVAL '1 second') AND (c.identity_id IS NULL OR i.status='aktiv')
    AND COALESCE(c.agent_id,'') NOT LIKE 'archiv-%'
    AND (c.agent_id IS NOT NULL OR c.identity_id IS NOT NULL)
   ORDER BY c.id DESC LIMIT $3`,[project,konfiguration.werte.inaktiv_sekunden,konfiguration.werte.ereignis_limit]),
  // P22-T155: Aufrufe ohne agent_id und identity_id (kein Ausweis, kein Name) werden kein Knoten, nur ein Zaehler (Debug/Legende).
  getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tool_calls c
   WHERE c.project=$1 AND c.agent_id IS NULL AND c.identity_id IS NULL AND c.ts >= NOW()-($2::int * INTERVAL '1 second')`,
   [project, Math.max(konfiguration.werte.inaktiv_sekunden, konfiguration.werte.aktivitaet_sekunden)]),
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
 // P22-T95: Planbezug nur aus vollstaendig lesbaren Top-Level-Argumenten (plan_id/schatten), nie aus Inhalten geraten.
 const planBezug = (row: ToolCallRow): string | null => {
  if (!/files|code_intel/.test(row.tool_name ?? '')) return null;
  try { const a = JSON.parse(String(row.args_preview ?? '')), v = a?.plan_id ?? a?.schatten; return /^\d+$/.test(String(v ?? '')) ? String(v) : null; } catch { return null; }
 };
 // P22-T97: nur die Groesse des Ergebnisses (Bytes), nie der Inhalt.
 const ereignisse = r.rows.reverse().map(row => ({ ...netzwerkEreignis(row), plan_id: planBezug(row), ergebnis_bytes: Number(row.ergebnis_bytes ?? 0), ergebnis_leer: row.ergebnis_leer === true }));
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
 for(const e of ereignisse) if(netzwerkErfolg(e)&&e.tool==='chat'&&e.interaktion==='senden'){
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
 // P22-T95: offene files-Plaene (Schattenplaene) nur lesend; frisch committete leuchten konfiguriert nach (mindestens ein Snapshot-Abstand). Keine Op-Inhalte.
 const plaeneRows = (await getPool().query<{ id: string; owner_agent_id: string | null; owner_identity_id: string | null; status: string; auto_commit: boolean; open_for_coedit: boolean; created_at: Date; committed_at: Date | null; ops: number; dateien: string[] | null; beitraege: string[] | null }>(`
  SELECT p.id::text,p.owner_agent_id,p.owner_identity_id,p.status::text AS status,p.auto_commit,p.open_for_coedit,p.created_at,p.committed_at,
   (SELECT COUNT(*)::int FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.ops)='array' THEN p.ops ELSE '[]'::jsonb END)) AS ops,
   (SELECT array_agg(DISTINCT o->>'file_path') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.ops)='array' THEN p.ops ELSE '[]'::jsonb END) o WHERE o->>'file_path' IS NOT NULL) AS dateien,
   (SELECT array_agg(DISTINCT COALESCE(o->>'author_identity_id',o->>'agent_id')) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.ops)='array' THEN p.ops ELSE '[]'::jsonb END) o WHERE COALESCE(o->>'author_identity_id',o->>'agent_id') IS NOT NULL) AS beitraege
  FROM file_batch_plans p
  WHERE p.project=$1 AND (p.status='open' OR (p.status='committed' AND p.committed_at>=NOW()-($2::int * INTERVAL '1 second')))
  ORDER BY p.created_at DESC LIMIT 40`, [project,Math.max(konfiguration.werte.plan_nachleuchten_sekunden,konfiguration.werte.plan_nachleuchten_auto_sekunden,konfiguration.werte.abgleich_sekunden)])).rows;
 // P22-T95: Endstatus der zuletzt beendeten Plaene (nur id/status), damit die Grafik Commit und Verwerfen unterscheiden kann.
 const plaene_ende = (await getPool().query<{ id: string; status: string }>(
  // Sortierung ueber die bigint-Spalte p.id (der Alias id::text wuerde als Text sortieren: '9' vor '28051').
  `SELECT p.id::text AS id, p.status::text AS status FROM file_batch_plans p WHERE p.project=$1 AND p.status<>'open' ORDER BY p.id DESC LIMIT 60`, [project])).rows;
 const agentVon = (x: string | null) => x ? (alias.get(x)?.id ?? netzwerkText(x)) : null;
 const plaene = plaeneRows.map(p => {
  const besitzer = agentVon(p.owner_identity_id) ?? agentVon(p.owner_agent_id);
  return { id: p.id, besitzer, besitzer_name: p.owner_agent_id ? netzwerkText(p.owner_agent_id) : null, status: p.status, auto_commit: p.auto_commit === true, coedit: p.open_for_coedit,
   erstellt: p.created_at.toISOString(), committed: p.committed_at?.toISOString() ?? null, ops: p.ops, dateien: (p.dateien ?? []).length,
   dateien_beispiele: (p.dateien ?? []).slice(0, 3).map(d => netzwerkText(d.split('/').pop() ?? d)),
   beitraege: [...new Set([besitzer, ...(p.beitraege ?? []).map(agentVon)].filter((x): x is string => !!x))] };
 });
 const index = await ladeIndexGroesse(project, konfiguration.werte);
 return { ...basis, plaene, plaene_ende, index, agenten: alle.map(a=>({...a,
  aufrufe_im_fenster:frequenzen.get(a.id)?.anzahl??0,
  letzter_aufruf:frequenzen.get(a.id)??null,
  zuletzt_aktiv:frequenzen.get(a.id)?.zeit??a.zuletzt_aktiv,
  koordination:koordinierung.get(a.id)??kommunikation.get(a.id)??null})), ereignisse, channel_ereignisse,
  begrenzt: Math.max(0, Number(r.rows[0]?.gesamt ?? 0) - r.rows.length),
  ohne_absender: Number(ohneAbsender.rows[0]?.n ?? 0),
  quellen: ['tool_calls','agenten-team','hauptagentIdentitaetsId','specialist_jobs.spawn','tool_calls.chat','file_batch_plans','code_files/code_chunks'], cursor: ereignisse.at(-1)?.id ?? null };
}
