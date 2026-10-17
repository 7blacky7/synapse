/**
 * RV19: eine additive Quellen-Registry für REST und stdio.
 * Quellen liefern strukturierte Befunde, keine Suche in serialisiertem Antworttext.
 * Leere Registry: keinerlei DB-Abfrage, kein zusätzliches Feld, gleiche Objektidentität.
 * Zustellung und Zähler werden gemeinsam transaktional gespeichert; Session ist sitzung_seit.
 */
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { aktuelleAgentIdentityId, loeseAgentZiel } from './agent-bezug.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export interface HinweisKontext {
  tool: string;
  aktion?: string;
  projekt: string;
  agent_id: string;
  sitzung: string;
  pfade: string[];
  ids: string[];
  felder: Readonly<Record<string, unknown>>;
  argumente: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}
export interface AusloeserHinweis {
  /** Stabiler Befundschlüssel innerhalb der Quelle, z.B. Asset-ID oder Ref-ID. */
  hinweis_id: string;
  modus: 'einmal_je_sitzung' | 'bis_erledigt';
  text: string;
  kurztext?: string;
  spezifitaet?: number;
  entprellung_ms?: number;
  erledigt?: boolean;
  folgeaktion?: { tool: string; aktion?: string; argumente?: Record<string, unknown> };
}
export interface HinweisQuelle {
  quelle_id: string;
  pruefe(kontext: HinweisKontext): AusloeserHinweis[] | Promise<AusloeserHinweis[]>;
}
export interface HinweisOptionen { pool?: Pool; zeitbudgetMs?: number }
export interface HinweisMetrik {
  quelle_id: string; ausgeliefert: number; gefolgt: number;
  unterdrueckt: number; fehler: number; zeitueberschreitung: number;
}
const quellen = new Map<string, HinweisQuelle>();
const lokaleFehler = new Map<string, { project: string; quelle_id: string; fehler: number; zeitueberschreitung: number }>();
const TIMEOUT = new Error('ausloeser_hinweis_zeitbudget');
const objekt = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const positiv = (value: unknown, fallback: number) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const kurz = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240);

/** Einmal beim Prozessstart registrieren; Rückgabe hebt nur diese Registrierung auf. */
export function registriereHinweisQuelle(quelle: HinweisQuelle): () => void {
  if (!quelle.quelle_id?.trim() || typeof quelle.pruefe !== 'function') throw new Error('Ungültige Hinweisquelle');
  if (quellen.has(quelle.quelle_id)) throw new Error('Hinweisquelle bereits registriert: ' + quelle.quelle_id);
  quellen.set(quelle.quelle_id, quelle);
  return () => { if (quellen.get(quelle.quelle_id) === quelle) quellen.delete(quelle.quelle_id); };
}

/** Pfade und IDs nur aus expliziten Argument-/Metadatenfeldern, nie aus Code/Logtext. */
export function baueHinweisKontext(tool: string, args: Record<string, unknown>, result: Record<string, unknown>, agent: string, sitzung: string, signal: AbortSignal): HinweisKontext {
  const pfade = new Set<string>(), ids = new Set<string>();
  const sammle = (o: Record<string, unknown>) => {
    for (const k of ['file_path','path','new_path','file_paths','files','pfade']) {
      const v = o[k];
      for (const p of Array.isArray(v) ? v : [v]) if (typeof p === 'string') pfade.add(p);
    }
    for (const k of ['id','task_id','plan_id','asset_id','datei_id','ref_id','ids']) {
      const v = o[k];
      for (const id of Array.isArray(v) ? v : [v]) if (typeof id === 'string' || typeof id === 'number') ids.add(String(id));
    }
  };
  sammle(args); sammle(result);
  for (const k of ['ops','files','results']) {
    for (const o of Array.isArray(args[k]) ? args[k] as unknown[] : []) if (objekt(o)) sammle(o);
    for (const o of Array.isArray(result[k]) ? result[k] as unknown[] : []) if (objekt(o)) sammle(o);
  }
  return { tool, aktion: typeof args.action === 'string' ? args.action : undefined,
    projekt: typeof args.project === 'string' ? args.project : '', agent_id: agent, sitzung,
    pfade: [...pfade], ids: [...ids], felder: objekt(result.felder) ? result.felder : result,
    argumente: args, signal };
}
function fehlerMerken(project: string, quelle: string, timeout: boolean, pool: Pool) {
  const key = JSON.stringify([project,quelle]);
  const m = lokaleFehler.get(key) ?? {project,quelle_id:quelle,fehler:0,zeitueberschreitung:0};
  if (timeout) m.zeitueberschreitung++; else m.fehler++;
  lokaleFehler.set(key,m);
  // Best effort im Hintergrund, ohne das Antwortbudget zu verlängern; bei DB-Fehler bleibt der Puffer.
  void speichereFehlerMetriken(project,pool).catch(() => undefined);
}
function passt(ziel: string, agent: string): boolean {
  return new RegExp('^' + ziel.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$').test(agent);
}
type Profil = {exact_identity_id?:string|null; ziel:string; hinweise_aus:string[]; hinweise_nur:string[]|null};
function quelleErlaubt(id: string, profile: Profil[], agent: string, identity?: string|null): boolean {
  const profil = profile.filter(p=>p.exact_identity_id ? p.exact_identity_id===identity : passt(p.ziel,agent)).sort((a,b)=>
    Number(!!b.exact_identity_id)-Number(!!a.exact_identity_id) ||
    Number(b.ziel===agent)-Number(a.ziel===agent) || b.ziel.replace(/\*/g,'').length-a.ziel.replace(/\*/g,'').length || a.ziel.localeCompare(b.ziel))[0];
  return !profil || (!profil.hinweise_aus.includes(id) && (profil.hinweise_nur===null || profil.hinweise_nur.includes(id)));
}

/**
 * Der Gesamtaufruf ist zeitlich begrenzt (SYNAPSE_HINWEIS_BUDGET_MS, Standard 30 ms).
 * Bei Abbruch wird die dedizierte Verbindung zerstört: offene Transaktion rollt zurück.
 * Späte Quellen erhalten AbortSignal und können keine Zustellmarke mehr schreiben.
 */
export async function haengeAusloeserHinweiseAn(
  result: unknown, tool: string, args: Record<string, unknown>, agentId?: string | null,
  optionen: HinweisOptionen = {},
): Promise<unknown> {
  if (!quellen.size || !agentId || (objekt(result) && 'ausloeser_hinweise' in result)) return result;
  let project = typeof args.project === 'string' ? args.project : '';
  const daten = objekt(result) ? result : { result };
  const pool = optionen.pool ?? getPool();
  const identity = aktuelleAgentIdentityId(project,agentId);
  const zustandAgent = identity ?? agentId;
  const zustandTabelle = identity ? 'agent_identitaet_hinweis_zustellungen' : 'ausloeser_hinweis_zustellungen';
  const zustandSpalte = identity ? 'identity_id' : 'agent_id';
  const budget = positiv(optionen.zeitbudgetMs ?? process.env.SYNAPSE_HINWEIS_BUDGET_MS,30);
  const start = Date.now(), controller = new AbortController();
  const fehlerQuellen = new Set<string>();
  const merkeQuelle = (id: string, timeout: boolean) => {
    if (fehlerQuellen.has(id)) return;
    fehlerQuellen.add(id); fehlerMerken(project,id,timeout,pool);
  };
  let client: PoolClient | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const pruefeFrist = () => { if (controller.signal.aborted || Date.now()-start >= budget) throw TIMEOUT; };
  const run = async (): Promise<unknown> => {
    const connection = await pool.connect();
    if (controller.signal.aborted) { connection.release(); throw TIMEOUT; }
    client = connection;
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[Math.max(1,Math.floor(budget))+'ms']);
    pruefeFrist();
    const meta = (await client.query<{sitzung:string; projekt:string; profile:Profil[]; aktiv:boolean}>(
      identity
      ? `SELECT project AS projekt,COALESCE(sitzung_seit,registered_at)::text AS sitzung,
          COALESCE((SELECT json_agg(p) FROM ausloeser_hinweis_profile p WHERE p.project=s.project AND (p.exact_identity_id IS NULL OR p.exact_identity_id=$1)),'[]'::json) AS profile,
          COALESCE((SELECT aktiv FROM hinweis_optionen WHERE project=s.project),true) AS aktiv
         FROM agent_identitaet_sitzungen s WHERE s.identity_id=$1 AND s.project=$2`
      : `WITH kontext AS (SELECT COALESCE(NULLIF($2,''),(SELECT project FROM agent_sessions WHERE id=$1),'') AS projekt)
         SELECT projekt,COALESCE((SELECT COALESCE(sitzung_seit,registered_at)::text FROM agent_sessions WHERE id=$1),'unregistriert') AS sitzung,
          COALESCE((SELECT json_agg(p) FROM ausloeser_hinweis_profile p WHERE p.project=kontext.projekt AND p.exact_identity_id IS NULL),'[]'::json) AS profile,
          COALESCE((SELECT aktiv FROM hinweis_optionen WHERE project=kontext.projekt),true) AS aktiv FROM kontext`,
        [zustandAgent,project])).rows[0];
    if (!meta) throw new Error('hinweis_identitaet_sitzung_fehlt');
    project = meta.projekt;
    const ctx = baueHinweisKontext(tool,{...args,project},daten,agentId,meta.sitzung,controller.signal);
    const kandidaten: Array<AusloeserHinweis & {quelle_id:string}> = [];
    const aktiveQuellen = [...quellen.values()].filter(q=>!!project && meta.aktiv && quelleErlaubt(q.quelle_id,meta.profile,agentId,identity));
    await Promise.all(aktiveQuellen.map(async q=>{
      try {
        const hinweise = await q.pruefe(ctx);
        pruefeFrist();
        if (!Array.isArray(hinweise)) throw new Error('Hinweise müssen Array sein');
        const validiert = hinweise.slice(0,100).map(h => {
          if (!h || !h.hinweis_id || !['einmal_je_sitzung','bis_erledigt'].includes(h.modus) || typeof h.text!=='string' || (h.spezifitaet!==undefined && !Number.isFinite(h.spezifitaet)) || (h.entprellung_ms!==undefined && (!Number.isFinite(h.entprellung_ms) || h.entprellung_ms<0))) throw new Error('Ungültiger Hinweis');
          return {...h,quelle_id:q.quelle_id};
        });
        kandidaten.push(...validiert);
      } catch(e) {
        merkeQuelle(q.quelle_id,e===TIMEOUT || controller.signal.aborted);
      }
    }));
    pruefeFrist();
    const seq = String((await client.query<{sequenz:string}>(identity
      ? `INSERT INTO agent_identitaet_hinweis_aufrufe(identity_id,agent_id,sequenz) VALUES($1,$2,1)
         ON CONFLICT(identity_id) DO UPDATE SET sequenz=agent_identitaet_hinweis_aufrufe.sequenz+1 RETURNING sequenz`
      : `INSERT INTO ausloeser_hinweis_aufrufe(agent_id,sequenz) VALUES($1,1)
         ON CONFLICT(agent_id) DO UPDATE SET sequenz=ausloeser_hinweis_aufrufe.sequenz+1 RETURNING sequenz`,
      identity ? [identity,agentId] : [agentId])).rows[0].sequenz);
    // Ein Follow-up zählt nur für dieselbe Session und passende strukturierte Argumente.
    await client.query(`WITH gefolgt AS (
      UPDATE ${zustandTabelle} SET gefolgt=true
      WHERE project=$1 AND ${zustandSpalte}=$2 AND sitzung=$3 AND NOT gefolgt
        AND $4::bigint > aufruf AND $4::bigint-aufruf <= $5
        AND folgeaktion->>'tool'=$6
        AND (NOT folgeaktion ? 'aktion' OR folgeaktion->>'aktion'=$7)
        AND $8::jsonb @> COALESCE(folgeaktion->'argumente','{}'::jsonb)
      RETURNING quelle_id)
      INSERT INTO ausloeser_hinweis_metriken(project,quelle_id,gefolgt)
      SELECT $1,quelle_id,count(*) FROM gefolgt GROUP BY quelle_id
      ON CONFLICT(project,quelle_id) DO UPDATE SET gefolgt=ausloeser_hinweis_metriken.gefolgt+EXCLUDED.gefolgt`,
      [project,zustandAgent,meta.sitzung,seq,positiv(process.env.SYNAPSE_HINWEIS_FOLGE_AUFRUFE,10),tool,ctx.aktion??null,JSON.stringify(args)]);
    const zeilen: string[] = [], gesehen = new Set<string>();
    kandidaten.sort((a,b)=>(b.spezifitaet??0)-(a.spezifitaet??0) || a.quelle_id.localeCompare(b.quelle_id));
    for (const h of kandidaten) {
      pruefeFrist();
      const key = JSON.stringify([h.quelle_id,h.hinweis_id]);
      if (gesehen.has(key)) continue; gesehen.add(key);
      const values = [project,zustandAgent,meta.sitzung,h.quelle_id,h.hinweis_id];
      if (h.erledigt) {
        await client.query(`DELETE FROM ${zustandTabelle} WHERE project=$1 AND ${zustandSpalte}=$2 AND sitzung=$3 AND quelle_id=$4 AND hinweis_id=$5`,values);
        continue;
      }
      if (zeilen.length===2 || !kurz(h.text)) continue;
      const claim = await client.query<{voll:boolean}>(`INSERT INTO ${zustandTabelle}
        (project,${zustandSpalte},sitzung,quelle_id,hinweis_id,aufruf,folgeaktion${identity ? ',agent_id' : ''})
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb${identity ? ',$10' : ''})
        ON CONFLICT(project,${zustandSpalte},sitzung,quelle_id,hinweis_id) DO UPDATE SET gezeigt_am=NOW(),voll=false
        WHERE $8::boolean AND ${zustandTabelle}.gezeigt_am <= NOW()-($9::double precision*interval '1 millisecond')
        RETURNING voll`,[...values,seq,h.folgeaktion?JSON.stringify(h.folgeaktion):null,h.modus==='bis_erledigt',Math.max(0,h.entprellung_ms??positiv(process.env.SYNAPSE_HINWEIS_ENTPRELLUNG_MS,60000)),...(identity ? [agentId] : [])]);
      const delivered = claim.rowCount===1;
      await client.query(`INSERT INTO ausloeser_hinweis_metriken(project,quelle_id,ausgeliefert,unterdrueckt) VALUES($1,$2,$3,$4)
        ON CONFLICT(project,quelle_id) DO UPDATE SET ausgeliefert=ausloeser_hinweis_metriken.ausgeliefert+EXCLUDED.ausgeliefert,
          unterdrueckt=ausloeser_hinweis_metriken.unterdrueckt+EXCLUDED.unterdrueckt`,[project,h.quelle_id,delivered?1:0,delivered?0:1]);
      if (delivered) zeilen.push(kurz(claim.rows[0].voll ? h.text : h.kurztext??('Weiter offen: '+h.hinweis_id)));
    }
    pruefeFrist();
    await client.query('COMMIT');
    return zeilen.length ? {...daten,ausloeser_hinweise:zeilen} : result;
  };
  try {
    return await Promise.race([run(),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(TIMEOUT);},budget);
    })]);
  } catch(e) {
    controller.abort();
    for (const q of quellen.values()) merkeQuelle(q.quelle_id,e===TIMEOUT || (e as {code?:string})?.code==='57014');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    if (client) client.release(controller.signal.aborted);
  }
}

/** stdio hält Nicht-JSON-Text und alle weiteren Inhaltsblöcke unverändert. */
export async function haengeAusloeserTextHinweiseAn<T extends {content?: Array<{type:string;text?:string}>;structuredContent?:Record<string,unknown>}>(
  response: T, tool: string, args: Record<string,unknown>, agentId?: string|null, optionen: HinweisOptionen = {},
): Promise<T> {
  if (!quellen.size) return response;
  const block=response.content?.[0];
  if (block?.type!=='text' || typeof block.text!=='string') return response;
  try {
    const raw: unknown=JSON.parse(block.text);
    const decorated=await haengeAusloeserHinweiseAn(raw,tool,args,agentId,optionen);
    if (decorated!==raw) {
      block.text=JSON.stringify(decorated);
      if (response.structuredContent && objekt(decorated)) response.structuredContent=decorated;
    }
  } catch { /* Eine Zugabe darf die fachliche Antwort nie brechen. */ }
  return response;
}

const metrikFlush = new Map<string, Promise<void>>();
async function speichereFehlerMetriken(project: string, pool: Pool): Promise<void> {
  const laufend = metrikFlush.get(project);
  if (laufend) return laufend;
  const lauf = (async () => {
    for (const [key,m] of lokaleFehler) if (m.project===project) {
      const fehler=m.fehler, zeitueberschreitung=m.zeitueberschreitung;
      await pool.query(`INSERT INTO ausloeser_hinweis_metriken(project,quelle_id,fehler,zeitueberschreitung) VALUES($1,$2,$3,$4)
        ON CONFLICT(project,quelle_id) DO UPDATE SET fehler=ausloeser_hinweis_metriken.fehler+EXCLUDED.fehler,
          zeitueberschreitung=ausloeser_hinweis_metriken.zeitueberschreitung+EXCLUDED.zeitueberschreitung`,[project,m.quelle_id,fehler,zeitueberschreitung]);
      // Neue Fehler während des awaits bleiben für die nächste Auslieferung erhalten.
      m.fehler-=fehler; m.zeitueberschreitung-=zeitueberschreitung;
      if (!m.fehler && !m.zeitueberschreitung) lokaleFehler.delete(key);
    }
  })();
  metrikFlush.set(project,lauf);
  try { await lauf; } finally { metrikFlush.delete(project); }
}

/** Zähler sind intern; nur admin(detailed_stats) fragt sie ab. */
export async function holeAusloeserHinweisMetriken(project: string, pool: Pool = getPool()): Promise<HinweisMetrik[]> {
  try {
    // Fehler werden gepuffert, damit eine überlastete DB den Fehlerpfad nie verlängert.
    await speichereFehlerMetriken(project,pool);
    const {rows}=await pool.query('SELECT quelle_id,ausgeliefert,gefolgt,unterdrueckt,fehler,zeitueberschreitung FROM ausloeser_hinweis_metriken WHERE project=$1 ORDER BY quelle_id',[project]);
    return rows.map(r=>({quelle_id:r.quelle_id,...Object.fromEntries(['ausgeliefert','gefolgt','unterdrueckt','fehler','zeitueberschreitung'].map(k=>[k,Number(r[k])]))})) as HinweisMetrik[];
  } catch { return []; }
}

/**
 * Additiver Profilpfad: nur Hinweislisten werden aktiviert. Budget/Stufe bleiben beim
 * bisherigen P7-Platzhalter. Ohne Profil bleibt auch liste/entfernen beim Altvertrag.
 * Null = Bestandsdispatcher aufrufen (einschließlich seiner Berechtigungsantwort).
 */
export async function fuehreHinweisprofilAdminAus(action: string,args:Record<string,unknown>,agentId?:string|null,pool?:Pool):Promise<Record<string,unknown>|null> {
  if (!darfKoordinatorOderUser(agentId??args.agent_id) || typeof args.project!=='string' || !args.project || args.kontext_budget!==undefined || args.stufe!==undefined) return null;
  if (!['kontextprofil_setzen','kontextprofil_liste','kontextprofil_entfernen'].includes(action)) return null;
  if (action==='kontextprofil_setzen' && args.hinweise_aus===undefined && args.hinweise_nur===undefined) return null;
  const db=pool??getPool(), project=args.project;
  const ziel=typeof args.ziel==='string'?args.ziel.trim():'';
  if (action!=='kontextprofil_liste' && !ziel) return {success:false,error:'ziel_erforderlich'};
  const targetIdentity = ziel.startsWith('identity:') ? (await loeseAgentZiel(project,{identity_id:ziel.slice(9)})) : null;
  const setterIdentity = aktuelleAgentIdentityId(project,agentId);
  if (action==='kontextprofil_setzen') {
    for (const k of ['hinweise_aus','hinweise_nur']) if (args[k]!==undefined && (!Array.isArray(args[k]) || !(args[k] as unknown[]).every(x=>typeof x==='string'&&x.trim()))) return {success:false,error:'ungueltige_hinweisliste',parameter:k};
    await db.query(`INSERT INTO ausloeser_hinweis_profile(project,ziel,hinweise_aus,hinweise_nur,gesetzt_von,exact_identity_id,setter_identity_id)
      VALUES($1,$2,$3,$4,$5,$8,$9) ON CONFLICT(project,ziel) DO UPDATE SET
      hinweise_aus=CASE WHEN $6 THEN EXCLUDED.hinweise_aus ELSE ausloeser_hinweis_profile.hinweise_aus END,
      hinweise_nur=CASE WHEN $7 THEN EXCLUDED.hinweise_nur ELSE ausloeser_hinweis_profile.hinweise_nur END,
      gesetzt_von=EXCLUDED.gesetzt_von,exact_identity_id=EXCLUDED.exact_identity_id,setter_identity_id=EXCLUDED.setter_identity_id,gesetzt_am=NOW()`,
      [project,ziel,args.hinweise_aus??[],args.hinweise_nur??null,agentId??args.agent_id,args.hinweise_aus!==undefined,args.hinweise_nur!==undefined,targetIdentity?.art === 'identity' ? targetIdentity.identity_id : null,setterIdentity]);
    return {success:true,action,project,ziel};
  }
  if (action==='kontextprofil_entfernen') {
    const r=await db.query('DELETE FROM ausloeser_hinweis_profile WHERE project=$1 AND ziel=$2 RETURNING ziel',[project,ziel]);
    return r.rowCount ? {success:true,action,project,ziel} : null;
  }
  const {rows}=await db.query('SELECT ziel,hinweise_aus,hinweise_nur FROM ausloeser_hinweis_profile WHERE project=$1 ORDER BY ziel',[project]);
  return rows.length ? {success:true,action,project,profile:rows} : null;
}
