/**
 * P18-T64: Reverse-Debugging und Entstörer.
 * diagnoseReverse()  – lesend: offene/hängende Reverse-Aufträge mit Ursache in Klartext und empfohlenem Schritt.
 * entstoereReverse() – räumt nach festen Regeln auf (Vorschau Standard): ausführerlose Aufträge stornieren,
 *                      abgelaufene Leases freigeben, festsitzenden Reverse-Container über den Lebenszyklus neu starten.
 *                      Löscht nie Originale, Ergebnisse oder Schichten.
 * starteReverseEntstoerer() – derselbe Entstörer automatisch als Worker im API-Prozess (Intervall/Grenzen per Env).
 * Container-Zugriff nur über die vom Executor angemeldeten Hooks (reverse-ausfuehrer.ts), nie Docker direkt.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { reverseAusfuehrer, zerlegeReverseFehlercode, leseReverseAufsicht } from './reverse-ausfuehrer.js';
import { registriereWorker, workerPausiert } from './worker-steuerung.js';
import { REVERSE_EINSTELLKATALOG } from './reverse-einstellkatalog.js';

type Row = Record<string, unknown>;
type Db = Pick<Pool, 'query' | 'connect'>;

export const REVERSE_URSACHEN = ['kein_ausfuehrer', 'wartet_auf_platz', 'wartet_auf_start', 'in_warteschlange', 'laeuft',
  'lease_abgelaufen', 'container_haengt', 'container_gesperrt', 'container_verwaist', 'auftrag_verwaist', 'werkzeug_fehler',
  'fachlicher_fehler', 'ueber_zeitlimit', 'storno_angefordert'] as const;
export type ReverseUrsache = typeof REVERSE_URSACHEN[number];
/** Ursachen, die entstoeren behandelt (Rest ist Normalbetrieb oder nur sichtbar). */
export const REVERSE_ENTSTOERBAR: readonly ReverseUrsache[] = ['kein_ausfuehrer', 'lease_abgelaufen', 'container_haengt', 'container_verwaist'];

const TEXT: Record<ReverseUrsache, { text: string; schritt: string }> = {
  kein_ausfuehrer: { text: 'Für diesen Auftragstyp ist kein Ausführer angemeldet; er würde nie abgearbeitet.', schritt: 'entstoeren storniert ihn (automatisch); Ergebnis bleibt als fehler/kein_ausfuehrer sichtbar.' },
  wartet_auf_platz: { text: 'Alle Container-Plätze des Tool-Lebenszyklus sind belegt.', schritt: 'Warten; belegende Container siehe container[]. Hängt einer davon: entstoeren.' },
  wartet_auf_start: { text: 'Der Reverse-Container wird gerade gestartet oder beim nächsten Durchlauf geweckt.', schritt: 'Kurz warten (reverse status mit warten_sekunden).' },
  in_warteschlange: { text: 'Der Reverse-Container läuft; der Auftrag wartet in der Warteschlange.', schritt: 'Nichts zu tun.' },
  laeuft: { text: 'Der Auftrag wird gerade ausgeführt.', schritt: 'Nichts zu tun.' },
  lease_abgelaufen: { text: 'Die Lease ist abgelaufen, ohne dass der Auftrag abgeschlossen wurde.', schritt: 'entstoeren gibt ihn wieder frei (automatisch nach Gnadenfrist).' },
  container_haengt: { text: 'Der Reverse-Container hat einen Lauf mit unbekanntem Ende oder startet nicht zu Ende.', schritt: 'entstoeren startet ihn über den Lebenszyklus neu (automatisch nach Gnadenfrist).' },
  container_gesperrt: { text: 'Container gesperrt (zu viele Starts) oder Reverse-Containerprofil nicht konfiguriert.', schritt: 'Sperre läuft von selbst ab; sonst Konfiguration prüfen (Koordinator).' },
  container_verwaist: { text: 'Reverse-Container hält einen Platz, gehört aber zu keinem offenen Auftrag (altes Ein-Container-je-Auftrag-Modell).', schritt: 'Lebenszyklus stoppt ihn nach Leerlauf; sonst entstoeren.' },
  auftrag_verwaist: { text: 'Reverse-Auftrag offen, der zugehörige Container-Auftrag ist aber schon beendet.', schritt: 'Pipeline legt beim nächsten Scan einen neuen Versuch an; sonst reverse analysieren.' },
  werkzeug_fehler: { text: 'Das Werkzeug ist gescheitert (wiederholbarer Fehler, Versuche erschöpft).', schritt: 'reverse analysieren für einen neuen Versuch.' },
  fachlicher_fehler: { text: 'Fachlicher Fehler: bei gleicher Eingabe scheitert der Auftrag identisch (siehe fehlercode/fehler_detail).', schritt: 'Kein automatischer Neuversuch; Formatunterstützung bzw. Eingabe klären.' },
  // P18-T87: Debug-Sichtbarkeit der harten Frist und des Stornos laufender Containerarbeit.
  ueber_zeitlimit: { text: 'Der Containerlauf läuft länger als seine harte Frist (zeitlimit + Puffer, frist_s), obwohl die Lease erneuert wird.', schritt: 'Der Executor beendet ihn selbst; bleibt er stehen: reverse abbrechen (Koordinator/User).' },
  storno_angefordert: { text: 'Abbruch angefordert; der Executor beendet den laufenden Containerlauf im nächsten Takt.', schritt: 'Kurz warten; danach ist der Work-Job cancelled und der Auftrag abgebrochen.' },
};

function envZahl(name: string, fallback: number, min = 0): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
const zahl = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

export interface ReverseDiagnoseOptionen { reverseId?: string | null; limit?: number; pool?: Db }
export interface ReverseDiagnoseEintrag extends Row {
  auftrag_id: string | null; p20_auftrag_id: string | null; reverse_id: string | null; schicht: string | null; kind: string | null;
  zustand: string; work_zustand: string | null; alter_s: number | null; lease_bis: string | null; owner: string | null;
  container_zustand: string | null; container_instanz?: string | null; container_job?: string | null; ursache: ReverseUrsache; ursache_text: string; fehlercode: string | null; fehler_detail: string | null;
  empfohlen: string; automatisch: boolean;
}
export interface ReverseMassnahme extends Row { zeit: string; quelle: string; ursache: string; massnahme: string; ziel: string | null; ergebnis: string }

/** Letzte automatische und manuelle Maßnahmen dieses Prozesses (zusätzlich dauerhaft in work_job_audit). */
const verlauf: ReverseMassnahme[] = [];
let letzterAutoLauf: { am: string; massnahmen: number; fehler?: string; uebersprungen?: string } | null = null;
/** P18-T86: diagnose_verlauf_speicher; jede Diagnose aktualisiert den wirksamen Wert. */
let verlaufMax = Number(REVERSE_EINSTELLKATALOG.diagnose_verlauf_speicher.standard);
function merke(m: ReverseMassnahme): void { verlauf.unshift(m); if (verlauf.length > verlaufMax) verlauf.length = verlaufMax; }

async function tabelleDa(db: Pick<Pool, 'query'>, name: string): Promise<boolean> {
  return !!(await db.query('SELECT to_regclass($1) AS t', [name])).rows[0]?.t;
}

export async function diagnoseReverse(o: ReverseDiagnoseOptionen = {}): Promise<Row> {
  const db = o.pool ?? getPool();
  // P18-T86: Fristen und Grenzen aus reverse_einstellungen (dynamisch importiert wie reverse-fortschritt, kein Importzyklus).
  const { leseReverseEinstellwerte, reverseZahl, leseReverseProduktSchalter } = await import('./reverse-einstellwerte.js');
  const s = await leseReverseEinstellwerte({});
  verlaufMax = reverseZahl(s, 'diagnose_verlauf_speicher');
  const rid = o.reverseId ?? null, limit = Math.min(Math.max(o.limit ?? reverseZahl(s, 'diagnose_seiten_limit'), 1), reverseZahl(s, 'diagnose_max_limit'));
  const aus = reverseAusfuehrer(), kinds = aus?.kinds ?? [];
  const gnade = reverseZahl(s, 'entstoerer_gnade_s');
  const fehlerStunden = reverseZahl(s, 'diagnose_fehler_stunden');
  const auto = await leseReverseProduktSchalter('reverse_entstoerer_auto').catch(() => null);
  // P18-T85: Live-Fortschritt je laufendem Work-Job (nur mit Schalter reverse_fortschritt_live; nur Hinweis, nie Abbruch).
  // Dynamisch: reverse-fortschritt zieht intern-tool nach; statisch entstuende ein Importzyklus ueber intern-schalter.
  const { leseReverseFortschrittSchalter, reverseFortschrittAnzeige, REVERSE_FORTSCHRITT_SQL } = await import('./reverse-fortschritt.js');
  const live = await leseReverseFortschrittSchalter().catch(() => null);
  // P18-T87: harte Frist = Zeitlimit des Ausfuehrers + Einstellwert hart_puffer_s (gleiche Lesestelle wie der Executor).
  const einst = await leseReverseAufsicht().catch(() => null);
  const einstellung = (n: 'hart_puffer_s' | 'nachlauf_s') => einst ? einst[n] : null;
  const puffer = einstellung('hart_puffer_s');
  const fristVon = (kind: string) => { const z = aus?.zeitlimits?.[kind]; return z !== undefined && puffer ? z + puffer.wert : undefined; };
  const liveVon = (w: Row | undefined) => {
    const l = live?.aktiv && w ? reverseFortschrittAnzeige(w, live.haenger_s) : null;
    // P18-T87: Frist und Storno-Wunsch je laufendem Work-Job sichtbar.
    const frist = w ? fristVon(String(w.kind)) : undefined;
    return { ...(l ? { live: l } : {}), ...(w?.storno_at ? { storno_angefordert_at: iso(w.storno_at) } : {}),
      ...(w && w.state === 'leased' && frist ? { frist_s: frist, lauf_s: zahl(w.lauf_s) } : {}) };
  };
  const jobs = (await db.query(`SELECT w.id::text AS id,w.kind,w.state,w.attempt,w.error_code,w.owner_node,w.lease_until,w.input_ref->>'id' AS reverse_id,
     (w.lease_until IS NOT NULL AND w.lease_until<=clock_timestamp()-($3*interval '1 second')) AS lease_abgelaufen,
     (w.lease_until IS NOT NULL AND w.lease_until<=clock_timestamp()) AS lease_ueberfaellig,
     EXTRACT(EPOCH FROM clock_timestamp()-w.created_at)::int AS alter_s,${REVERSE_FORTSCHRITT_SQL},
     EXTRACT(EPOCH FROM clock_timestamp()-w.claimed_at)::int AS lauf_s,
     (SELECT max(a.created_at) FROM work_job_audit a WHERE a.job_id=w.id AND a.event='storno_angefordert') AS storno_at
    FROM work_jobs w WHERE w.capability='reverse_bibliothek' AND w.kind<>'tool-warmup' AND w.state IN ('pending','leased','staged')
     AND ($1::text IS NULL OR w.input_ref->>'id'=$1) ORDER BY w.created_at,w.id LIMIT $2`, [rid, limit, gnade])).rows;
  // N5: ausfuehrung/lease_bis/werkzeug kommen erst mit dem Pipeline-Schema -> tolerant über to_jsonb lesen.
  const auftraege = (await db.query(`SELECT a.id::text AS id,a.eintrag_id,a.schicht,a.status,a.fehlercode,to_jsonb(a)->>'ausfuehrung' AS ausfuehrung,a.p20_auftrag_id::text AS p20,
     to_jsonb(a)->>'lease_bis' AS lease_bis,a.versuch,to_jsonb(a)->>'werkzeug' AS werkzeug,EXTRACT(EPOCH FROM clock_timestamp()-a.created_at)::int AS alter_s,w.state AS work_state,w.error_code AS work_fehler,w.kind AS work_kind
    FROM reverse_auftraege a LEFT JOIN work_jobs w ON w.id=a.p20_auftrag_id
    WHERE (a.status IN ('offen','wartet','laeuft') OR (a.status='fehler' AND a.updated_at>clock_timestamp()-($3*interval '1 hour')))
     AND ($1::text IS NULL OR a.eintrag_id=$1) ORDER BY a.created_at,a.id LIMIT $2`, [rid, limit, fehlerStunden])).rows;
  let container: Row[] = [], runs: Row[] = [], belegt = 0;
  if (await tabelleDa(db, 'tool_containers')) {
    container = (await db.query(`SELECT t.instance_id,t.generation,t.container_id,t.tool_id,d.descriptor_hash,t.state,t.work_job_id::text AS work_job_id,t.last_error,t.blocked_until,
       EXTRACT(EPOCH FROM clock_timestamp()-COALESCE(t.operation_at,t.ready_at,t.updated_at))::int AS alter_s,
       (SELECT count(*) FROM tool_container_runs r WHERE r.instance_id=t.instance_id AND r.generation=t.generation AND r.state='unknown')::int AS runs_unbekannt,
       (SELECT count(*) FROM tool_container_runs r WHERE r.instance_id=t.instance_id AND r.generation=t.generation AND r.state='running')::int AS runs_laufend,
       (t.work_job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM work_jobs w WHERE w.id=t.work_job_id AND w.state IN ('pending','leased','staged'))) AS job_beendet
      FROM tool_containers t JOIN tool_descriptors d USING(tool_id) WHERE t.project='reverse-bibliothek' AND t.tool_id IN('reverse-e','reverse-leser') AND t.state<>'cold' ORDER BY t.instance_id`)).rows;
    runs=(await db.query(`SELECT r.job_id::text,r.attempt,r.instance_id,r.generation,r.state FROM tool_container_runs r
      JOIN work_jobs w ON w.id=r.job_id AND w.attempt=r.attempt
      WHERE w.project='reverse-bibliothek' AND w.id=ANY($1::uuid[])`,[jobs.map(w=>w.id)])).rows;
    belegt = Number((await db.query("SELECT count(*)::int AS n FROM tool_containers WHERE state IN('warm','stopping') OR (state='waiting' AND operation_token IS NOT NULL)")).rows[0].n);
  }
  let max = envZahl('SYNAPSE_TOOL_MAX_CONTAINERS', 4, 1);
  if (aus?.kapazitaet) { try { const k = await aus.kapazitaet(); belegt = k.belegt; max = k.max; } catch { /* Schätzung aus PG bleibt */ } }
  // Ein belegter alter Versuch erhält nie die neue globale Instanz als Ersatzzuordnung.
  const containerInfo = container.map(c => {
    const haengt = Number(c.runs_unbekannt) > 0 && Number(c.runs_laufend) === 0 && Number(c.alter_s) >= gnade
      || (c.state === 'waiting' && Number(c.alter_s) >= gnade);
    const ursache: ReverseUrsache | null = c.state === 'blocked' ? 'container_gesperrt' : haengt ? 'container_haengt'
      : c.state === 'warm' && c.job_beendet ? 'container_verwaist' : null;
    return { instance: String(c.instance_id).slice(0, 12), instance_id: String(c.instance_id), generation: String(c.generation), container_id: c.container_id as string | null, tool_id: String(c.tool_id), descriptor_hash: String(c.descriptor_hash), zustand: c.state, scope: c.work_job_id ? 'auftrag' : 'global', work_job_id: c.work_job_id,
      alter_s: zahl(c.alter_s), runs_unbekannt: Number(c.runs_unbekannt), letzter_fehler: c.last_error ?? null, gesperrt_bis: iso(c.blocked_until),
      ...(ursache ? { ursache, ursache_text: TEXT[ursache].text, empfohlen: TEXT[ursache].schritt } : {}), _instance_id: c.instance_id };
  });
  const eintraege: ReverseDiagnoseEintrag[] = [];
  const eintrag = (x: Partial<ReverseDiagnoseEintrag> & { ursache: ReverseUrsache }): void => {
    eintraege.push({ auftrag_id: null, p20_auftrag_id: null, reverse_id: null, schicht: null, kind: null, zustand: 'offen', work_zustand: null,
      alter_s: null, lease_bis: null, owner: null, container_zustand: null, fehlercode: null, fehler_detail: null, ...x,
      ursache_text: TEXT[x.ursache].text, empfohlen: TEXT[x.ursache].schritt, automatisch: x.automatisch ?? REVERSE_ENTSTOERBAR.includes(x.ursache) } as ReverseDiagnoseEintrag);
  };
  const jobUrsache = (w: Row) => {
    const run=runs.find(r=>r.job_id===w.id&&Number(r.attempt)===Number(w.attempt));
    const eigen=run?containerInfo.find(c=>c._instance_id===run.instance_id&&c.generation===run.generation):
      w.state==='pending'?containerInfo.find(c=>c.tool_id==='reverse-e'&&(c.work_job_id===w.id||!c.work_job_id)):undefined;
    const cz = eigen ? String(eigen.zustand) : run ? 'alte_generation' : 'cold';
    const mit = (ursache: ReverseUrsache) => ({ ursache, container_zustand: cz,
      container_instanz: eigen?.instance_id??null, container_job: (eigen?.work_job_id??null) as string|null,
      container_generation: eigen?.generation??run?.generation??null, container_id:eigen?.container_id??null,
      container_tool:eigen?.tool_id??null, container_descriptor_hash:eigen?.descriptor_hash??null,
      container_versuch:Number(w.attempt), run_instanz:run?.instance_id??null });
    // N2: erst der Job-Zustand. Nur ein pending Job ohne Ausführer ist 'kein_ausfuehrer'; geleaste laufen aus bzw. werden über die Lease behandelt.
    if (w.lease_abgelaufen) return mit('lease_abgelaufen');
    // P18-T87: Storno-Wunsch bzw. Lauf ueber der harten Frist (die Lease wird dabei weiter erneuert).
    if (w.state === 'leased' && w.storno_at) return mit('storno_angefordert');
    const frist = fristVon(String(w.kind));
    if (w.state === 'leased' && frist && Number(w.lauf_s) > frist) return mit('ueber_zeitlimit');
    if (w.state !== 'pending') return mit(eigen?.ursache === 'container_haengt' ? 'container_haengt' : 'laeuft');
    if (!kinds.includes(String(w.kind))) return mit('kein_ausfuehrer');
    if (eigen?.ursache === 'container_haengt' || eigen?.ursache === 'container_gesperrt') return mit(eigen.ursache as ReverseUrsache);
    if (cz === 'warm') return mit('in_warteschlange');
    if (cz === 'cold' && belegt >= max) return mit('wartet_auf_platz');
    return mit('wartet_auf_start');
  };
  const gesehen = new Set<string>();
  for (const a of auftraege) {
    const w = a.p20 ? jobs.find(j => j.id === a.p20) : undefined;
    if (w) gesehen.add(String(w.id));
    const f = zerlegeReverseFehlercode(a.fehlercode);
    const basis = { auftrag_id: String(a.id), p20_auftrag_id: a.p20 ? String(a.p20) : null, reverse_id: String(a.eintrag_id), schicht: String(a.schicht),
      kind: a.ausfuehrung === 'api' ? 'api:' + String(a.werkzeug ?? 'asset-inspektoren') : String(a.work_kind ?? 'reverse-' + String(a.schicht)),
      zustand: String(a.status), work_zustand: (w?.state ?? a.work_state ?? null) as string | null, alter_s: zahl(a.alter_s),
      lease_bis: iso(w?.lease_until ?? a.lease_bis), owner: (w?.owner_node ?? null) as string | null, fehlercode: f.code, fehler_detail: f.detail };
    if (a.status === 'fehler') {
      eintrag({ ...basis, ursache: f.code === 'kein_ausfuehrer' ? 'kein_ausfuehrer' : f.code && f.code !== 'werkzeug_fehler' && f.code !== 'zeitlimit' ? 'fachlicher_fehler' : 'werkzeug_fehler', automatisch: false });
      continue;
    }
    if (w) { eintrag({ ...basis, ...jobUrsache(w), ...liveVon(w) }); continue; }
    if (a.ausfuehrung === 'api') { eintrag({ ...basis, ursache: a.status === 'laeuft' ? 'laeuft' : 'in_warteschlange' }); continue; }
    if (a.p20 && a.work_state && !['pending', 'leased', 'staged'].includes(String(a.work_state))) { eintrag({ ...basis, ursache: 'auftrag_verwaist' }); continue; }
    if (!kinds.includes(String(basis.kind))) { eintrag({ ...basis, ursache: 'kein_ausfuehrer' }); continue; }
    eintrag({ ...basis, ursache: f.code === 'container_gesperrt' ? 'container_gesperrt' : 'wartet_auf_start' });
  }
  for (const w of jobs) {
    if (gesehen.has(String(w.id))) continue;
    eintrag({ p20_auftrag_id: String(w.id), reverse_id: (w.reverse_id ?? null) as string | null, kind: String(w.kind), zustand: String(w.state),
      work_zustand: String(w.state), alter_s: zahl(w.alter_s), lease_bis: iso(w.lease_until), owner: (w.owner_node ?? null) as string | null,
      ...jobUrsache(w), ...liveVon(w) });
  }
  const ursachen: Record<string, number> = {};
  for (const e of eintraege) ursachen[e.ursache] = (ursachen[e.ursache] ?? 0) + 1;
  for (const c of containerInfo) if (c.ursache) ursachen[c.ursache] = (ursachen[c.ursache] ?? 0) + 1;
  return {
    ausfuehrer: aus ? { aktiv: true, kinds, parallel: aus.parallel } : { aktiv: false, kinds: [], hinweis: 'Kein Reverse-Executor angemeldet (SYNAPSE_REVERSE_ENABLED/Konfiguration prüfen).' },
    container: { belegt, max, reverse_container: containerInfo.filter(c => c.zustand !== 'blocked').length, instanzen: containerInfo.map(({ _instance_id, ...c }) => c) },
    auftraege: eintraege, ursachen, anzahl: eintraege.length,
    fortschritt_live: live ?? { aktiv: false, letzter_fehler: 'reverse_fortschritt_schalter_nicht_lesbar' },
    aufsicht: { zeitlimits_s: aus?.zeitlimits ?? null, hart_puffer_s: puffer, nachlauf_s: einstellung('nachlauf_s'), einstellungen_fehler: einst?.letzter_fehler ?? (einst ? null : 'reverse_einstellungen_nicht_lesbar'), hinweis: 'P18-T87: harte Frist und Storno setzt der Executor durch; diagnose zeigt ueber_zeitlimit/storno_angefordert.' },
    haenger_verdacht: eintraege.filter(e => (e.live as Row | undefined)?.haenger_verdacht === true).length,
    automatik: { aktiv: entstoererAktiv() && !!auto?.aktiv, worker_gestartet: entstoererAktiv(), schalter: auto, letzter_lauf: letzterAutoLauf,
      massnahmen: verlauf.slice(0, reverseZahl(s, 'diagnose_verlauf_anzeige')) },
  };
}

export interface ReverseEntstoerOptionen {
  reverseId?: string | null; ursachen?: readonly string[] | null; auftragId?: string | null;
  ausfuehren?: boolean; quelle?: string; pool?: Db;
  /** Automatik: nur Fälle, die mindestens so alt sind (Sekunden). Manuell 0. */
  mindestAlterS?: number;
}

async function tx<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect() as PoolClient;
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
async function audit(c: Pick<PoolClient, 'query'>, jobId: string | null, detail: Row): Promise<void> {
  await c.query("INSERT INTO work_job_audit(id,job_id,event,detail) VALUES($1,$2,'reverse_entstoert',$3::jsonb)", [randomUUID(), jobId, JSON.stringify(detail)]);
}

/** Wendet die Entstör-Regeln an. Idempotent: ein zweiter Lauf findet nichts mehr zu tun. */
export async function entstoereReverse(o: ReverseEntstoerOptionen = {}): Promise<Row> {
  const db = o.pool ?? getPool(), quelle = o.quelle ?? 'automatik', ausfuehren = o.ausfuehren === true, mindest = o.mindestAlterS ?? 0;
  const filter = new Set((o.ursachen?.length ? o.ursachen : REVERSE_ENTSTOERBAR).filter(u => (REVERSE_ENTSTOERBAR as readonly string[]).includes(u)));
  // Intern ohne Seitengrenze: diagnoseReverse kappt auf diagnose_max_limit.
  const d = await diagnoseReverse({ reverseId: o.reverseId, pool: db, limit: Number.MAX_SAFE_INTEGER });
  const kandidaten = (d.auftraege as ReverseDiagnoseEintrag[]).filter(e => e.automatisch && filter.has(e.ursache)
    && (!o.auftragId || e.auftrag_id === o.auftragId || e.p20_auftrag_id === o.auftragId) && (e.alter_s ?? 0) >= mindest);
  const instanzen = ((d.container as Row).instanzen as Row[]).filter(c => c.ursache && filter.has(String(c.ursache)) && !o.auftragId && Number(c.alter_s ?? 0) >= mindest);
  const massnahmen: ReverseMassnahme[] = [];
  const jetzt = () => new Date().toISOString();
  const neu = (ursache: string, massnahme: string, ziel: string | null, ergebnis: string) => {
    const m = { zeit: jetzt(), quelle, ursache, massnahme, ziel, ergebnis }; massnahmen.push(m); if (ausfuehren) merke(m);
  };
  const erledigt = new Set<string>();
  for (const e of kandidaten) {
    const ziel = e.auftrag_id ?? e.p20_auftrag_id;
    if (e.ursache === 'kein_ausfuehrer') {
      if (e.p20_auftrag_id && erledigt.has('w:' + e.p20_auftrag_id) && !e.auftrag_id) continue;
      if (!ausfuehren) { neu(e.ursache, e.p20_auftrag_id ? 'container_auftrag_stornieren' : 'auftrag_als_fehler_markieren', ziel, 'vorschau'); continue; }
      const r = await tx(db, async c => {
        let storniert = false;
        if (e.p20_auftrag_id) {
          if (erledigt.has('w:' + e.p20_auftrag_id)) return 'unveraendert';
          erledigt.add('w:' + e.p20_auftrag_id);
          // N2: nur ein noch pending Job wird storniert; Auftrag/Schicht nur, wenn das Storno wirklich griff.
          const u = await c.query("UPDATE work_jobs SET state='cancelled',error_code='kein_ausfuehrer',updated_at=clock_timestamp() WHERE id=$1 AND state='pending' RETURNING id", [e.p20_auftrag_id]);
          if (!u.rowCount) return 'unveraendert';
          storniert = true;
          await audit(c, e.p20_auftrag_id, { quelle, ursache: e.ursache, massnahme: 'storniert', kind: e.kind });
          await c.query(`UPDATE reverse_auftraege SET status='fehler',fehlercode='kein_ausfuehrer',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp()
            WHERE p20_auftrag_id=$1 AND status IN ('offen','wartet','laeuft')`, [e.p20_auftrag_id]);
          await c.query(`UPDATE reverse_schichten SET status='fehler',fehlercode='kein_ausfuehrer' WHERE aktuell AND status IN ('offen','wartet','laeuft')
            AND auftrag_id IN (SELECT id FROM reverse_auftraege WHERE p20_auftrag_id=$1)`, [e.p20_auftrag_id]);
        } else if (e.auftrag_id) {
          const a = await c.query(`UPDATE reverse_auftraege SET status='fehler',fehlercode='kein_ausfuehrer',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp()
            WHERE id=$1 AND status IN ('offen','wartet','laeuft') RETURNING id`, [e.auftrag_id]);
          await c.query("UPDATE reverse_schichten SET status='fehler',fehlercode='kein_ausfuehrer' WHERE auftrag_id=$1 AND aktuell AND status IN ('offen','wartet','laeuft')", [e.auftrag_id]);
          storniert = storniert || !!a.rowCount;
        }
        return storniert ? 'storniert' : 'unveraendert';
      });
      neu(e.ursache, 'storniert', ziel, r);
    } else if (e.ursache === 'lease_abgelaufen' && e.p20_auftrag_id) {
      if (!ausfuehren) { neu(e.ursache, 'lease_freigeben', ziel, 'vorschau'); continue; }
      const r = await tx(db, async c => {
        const u = await c.query(`UPDATE work_jobs SET state=CASE WHEN deadline<=clock_timestamp() THEN 'expired' ELSE 'pending' END,
            owner_node=NULL,boot_generation=NULL,owner_auth_hash=NULL,claim_token=NULL,lease_until=NULL,staged_output_ref=NULL,
            resource_unconfirmed=TRUE,updated_at=clock_timestamp()
          WHERE id=$1 AND state IN ('leased','staged') AND lease_until<=clock_timestamp() RETURNING state`, [e.p20_auftrag_id]);
        if (u.rowCount) await audit(c, e.p20_auftrag_id, { quelle, ursache: e.ursache, massnahme: 'lease_freigegeben', physicalResourceState: 'unknown' });
        return u.rowCount ? 'freigegeben:' + String(u.rows[0].state) : 'unveraendert';
      });
      neu(e.ursache, 'lease_freigeben', ziel, r);
    } else if (e.ursache === 'container_haengt') {
      // N1: genau die Instanz dieses Auftrags (global: work_job_id null; alter Modus: der eigene Job-Container).
      const key = 'i:' + String(e.container_instanz ?? 'global');
      if (erledigt.has(key)) continue;
      erledigt.add(key);
      neu(e.ursache, 'container_neustart', ziel, ausfuehren ? await neustart(db, quelle, e.p20_auftrag_id, {
        instance_id:String(e.container_instanz),generation:String(e.container_generation),container_id:e.container_id as string|null,
        job_id:e.p20_auftrag_id,attempt:Number(e.container_versuch),tool_id:String(e.container_tool),descriptor_hash:String(e.container_descriptor_hash) }) : 'vorschau');
    }
  }
  for (const c of instanzen) {
    const key = 'i:' + String(c.instance_id);
    if (erledigt.has(key)) continue;
    erledigt.add(key);
    neu(String(c.ursache), 'container_neustart', 'instanz:' + String(c.instance), ausfuehren ? await neustart(db, quelle, (c.work_job_id ?? null) as string | null, {instance_id:String(c.instance_id),generation:String(c.generation),container_id:c.container_id as string|null,tool_id:String(c.tool_id),descriptor_hash:String(c.descriptor_hash)}) : 'vorschau');
  }
  return { vorschau: !ausfuehren, massnahmen, anzahl: massnahmen.length, ...(massnahmen.length ? {} : { hinweis: 'Nichts zu entstören.' }) };
}

async function neustart(db: Db, quelle: string, jobId: string | null, beleg: {instance_id:string;generation:string;container_id:string|null;job_id?:string|null;attempt?:number;tool_id?:string;descriptor_hash?:string}): Promise<string> {
  const hook = reverseAusfuehrer()?.containerNeustart;
  if (!hook) return 'nicht_moeglich: kein Reverse-Executor/Lebenszyklus angemeldet';
  try {
    const r = await hook(jobId,beleg);
    await tx(db, c => audit(c, null, { quelle, ursache: 'container_haengt', massnahme: 'container_neustart', ergebnis: r, job: jobId }));
    return r.neu_gestartet || r.zustand==='stopping' ? 'ausstehend: generationsgebundene Beendigung im Lebenszyklus' : 'unveraendert: ' + String(r.zustand ?? 'kein Container');
  } catch (e) { return 'fehler: ' + (e as Error).message; }
}

let timerAktiv = false;
function entstoererAktiv(): boolean { return timerAktiv; }

/**
 * Automatischer Entstörer im API-Prozess. Startfähigkeit (Infrastruktur): SYNAPSE_REVERSE_ENTSTOERER=0 startet den Worker nicht.
 * P18-T86: Ob er wirkt, steuert der Produkt-Schalter reverse_entstoerer_auto (Standard EIN wie bisher, intern-Override).
 * Intervall, Gnadenfrist (Leases/Container) und Frist für ausführerlose Aufträge sind Reverse-Einstellungen
 * (entstoerer_intervall_ms, entstoerer_gnade_s, entstoerer_ohne_ausfuehrer_s) und gelten ab dem nächsten Durchlauf.
 */
export function starteReverseEntstoerer(o: { pool?: Db } = {}): { durchlauf: () => Promise<Row>; beende: () => void } | null {
  if (process.env.SYNAPSE_REVERSE_ENTSTOERER === '0') return null;
  let laeuft: Promise<Row> | null = null;
  const durchlauf = async (): Promise<Row> => {
    if (laeuft) return laeuft;
    laeuft = (async () => {
      const ergebnis: Row = { kein_ausfuehrer: null, rest: null };
      try {
        const { leseReverseEinstellwerte, reverseZahl, leseReverseProduktSchalter } = await import('./reverse-einstellwerte.js');
        const schalter = await leseReverseProduktSchalter('reverse_entstoerer_auto');
        if (!schalter.aktiv) {
          letzterAutoLauf = { am: new Date().toISOString(), massnahmen: 0, uebersprungen: 'reverse_entstoerer_auto_aus' };
          return { ...ergebnis, schalter };
        }
        const s = await leseReverseEinstellwerte({});
        const gnade = reverseZahl(s, 'entstoerer_gnade_s'), ohne = reverseZahl(s, 'entstoerer_ohne_ausfuehrer_s');
        ergebnis.kein_ausfuehrer = await entstoereReverse({ pool: o.pool, ausfuehren: true, quelle: 'automatik', ursachen: ['kein_ausfuehrer'], mindestAlterS: ohne });
        ergebnis.rest = await entstoereReverse({ pool: o.pool, ausfuehren: true, quelle: 'automatik', ursachen: ['lease_abgelaufen', 'container_haengt', 'container_verwaist'], mindestAlterS: gnade });
        const n = Number((ergebnis.kein_ausfuehrer as Row).anzahl) + Number((ergebnis.rest as Row).anzahl);
        letzterAutoLauf = { am: new Date().toISOString(), massnahmen: n };
        if (n) console.warn('[reverse-entstoerer] ' + n + ' Maßnahme(n):', JSON.stringify([...((ergebnis.kein_ausfuehrer as Row).massnahmen as Row[]), ...((ergebnis.rest as Row).massnahmen as Row[])].map(m => m.ursache + '->' + m.ergebnis)));
      } catch (e) {
        letzterAutoLauf = { am: new Date().toISOString(), massnahmen: 0, fehler: (e as Error).message };
        console.error('[reverse-entstoerer] Durchlauf fehlgeschlagen:', (e as Error).message);
      }
      return ergebnis;
    })().finally(() => { laeuft = null; });
    return laeuft;
  };
  registriereWorker({ name: 'reverse-entstoerer', beschreibung: 'P18-T64 Reverse-Aufträge ohne Ausführer, abgelaufene Leases und hängende Container automatisch entstören', durchlauf });
  // Selbst neu planender Takt: das Intervall wird je Runde aus reverse_einstellungen gelesen.
  let timer: NodeJS.Timeout | null = null, beendet = false;
  const planen = async (): Promise<void> => {
    let intervall = Number(REVERSE_EINSTELLKATALOG.entstoerer_intervall_ms.standard);
    try {
      const { leseReverseEinstellwerte, reverseZahl } = await import('./reverse-einstellwerte.js');
      intervall = reverseZahl(await leseReverseEinstellwerte({}), 'entstoerer_intervall_ms');
    } catch { /* Katalogstandard */ }
    if (beendet) return;
    timer = setTimeout(() => { if (!workerPausiert('reverse-entstoerer')) void durchlauf(); void planen(); }, intervall);
    timer.unref();
  };
  void planen();
  timerAktiv = true;
  return { durchlauf, beende: () => { beendet = true; if (timer) clearTimeout(timer); timerAktiv = false; } };
}
