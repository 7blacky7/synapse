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
import { reverseAusfuehrer, zerlegeReverseFehlercode } from './reverse-ausfuehrer.js';
import { registriereWorker, workerPausiert } from './worker-steuerung.js';

type Row = Record<string, unknown>;
type Db = Pick<Pool, 'query' | 'connect'>;

export const REVERSE_URSACHEN = ['kein_ausfuehrer', 'wartet_auf_platz', 'wartet_auf_start', 'in_warteschlange', 'laeuft',
  'lease_abgelaufen', 'container_haengt', 'container_gesperrt', 'container_verwaist', 'auftrag_verwaist', 'werkzeug_fehler',
  'fachlicher_fehler'] as const;
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
let letzterAutoLauf: { am: string; massnahmen: number; fehler?: string } | null = null;
function merke(m: ReverseMassnahme): void { verlauf.unshift(m); if (verlauf.length > 50) verlauf.length = 50; }

async function tabelleDa(db: Pick<Pool, 'query'>, name: string): Promise<boolean> {
  return !!(await db.query('SELECT to_regclass($1) AS t', [name])).rows[0]?.t;
}

export async function diagnoseReverse(o: ReverseDiagnoseOptionen = {}): Promise<Row> {
  const db = o.pool ?? getPool();
  const rid = o.reverseId ?? null, limit = Math.min(Math.max(o.limit ?? 200, 1), 1000);
  const aus = reverseAusfuehrer(), kinds = aus?.kinds ?? [];
  const gnade = envZahl('SYNAPSE_REVERSE_ENTSTOERER_GNADE_S', 300);
  const fehlerStunden = envZahl('SYNAPSE_REVERSE_DIAGNOSE_FEHLER_STUNDEN', 24, 1);
  const jobs = (await db.query(`SELECT w.id::text AS id,w.kind,w.state,w.attempt,w.error_code,w.owner_node,w.lease_until,w.input_ref->>'id' AS reverse_id,
     (w.lease_until IS NOT NULL AND w.lease_until<=clock_timestamp()-($3*interval '1 second')) AS lease_abgelaufen,
     (w.lease_until IS NOT NULL AND w.lease_until<=clock_timestamp()) AS lease_ueberfaellig,
     EXTRACT(EPOCH FROM clock_timestamp()-w.created_at)::int AS alter_s
    FROM work_jobs w WHERE w.capability='reverse_bibliothek' AND w.kind<>'tool-warmup' AND w.state IN ('pending','leased','staged')
     AND ($1::text IS NULL OR w.input_ref->>'id'=$1) ORDER BY w.created_at,w.id LIMIT $2`, [rid, limit, gnade])).rows;
  // N5: ausfuehrung/lease_bis/werkzeug kommen erst mit dem Pipeline-Schema -> tolerant über to_jsonb lesen.
  const auftraege = (await db.query(`SELECT a.id::text AS id,a.eintrag_id,a.schicht,a.status,a.fehlercode,to_jsonb(a)->>'ausfuehrung' AS ausfuehrung,a.p20_auftrag_id::text AS p20,
     to_jsonb(a)->>'lease_bis' AS lease_bis,a.versuch,to_jsonb(a)->>'werkzeug' AS werkzeug,EXTRACT(EPOCH FROM clock_timestamp()-a.created_at)::int AS alter_s,w.state AS work_state,w.error_code AS work_fehler,w.kind AS work_kind
    FROM reverse_auftraege a LEFT JOIN work_jobs w ON w.id=a.p20_auftrag_id
    WHERE (a.status IN ('offen','wartet','laeuft') OR (a.status='fehler' AND a.updated_at>clock_timestamp()-($3*interval '1 hour')))
     AND ($1::text IS NULL OR a.eintrag_id=$1) ORDER BY a.created_at,a.id LIMIT $2`, [rid, limit, fehlerStunden])).rows;
  let container: Row[] = [], belegt = 0;
  if (await tabelleDa(db, 'tool_containers')) {
    container = (await db.query(`SELECT t.instance_id,t.state,t.work_job_id::text AS work_job_id,t.last_error,t.blocked_until,
       EXTRACT(EPOCH FROM clock_timestamp()-COALESCE(t.operation_at,t.ready_at,t.updated_at))::int AS alter_s,
       (SELECT count(*) FROM tool_container_runs r WHERE r.instance_id=t.instance_id AND r.state='unknown')::int AS runs_unbekannt,
       (SELECT count(*) FROM tool_container_runs r WHERE r.instance_id=t.instance_id AND r.state='running')::int AS runs_laufend,
       (t.work_job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM work_jobs w WHERE w.id=t.work_job_id AND w.state IN ('pending','leased','staged'))) AS job_beendet
      FROM tool_containers t WHERE t.tool_id='reverse-e' AND t.state<>'cold' ORDER BY t.instance_id`)).rows;
    belegt = Number((await db.query("SELECT count(*)::int AS n FROM tool_containers WHERE state IN('warm','stopping') OR (state='waiting' AND operation_token IS NOT NULL)")).rows[0].n);
  }
  let max = envZahl('SYNAPSE_TOOL_MAX_CONTAINERS', 4, 1);
  if (aus?.kapazitaet) { try { const k = await aus.kapazitaet(); belegt = k.belegt; max = k.max; } catch { /* Schätzung aus PG bleibt */ } }
  const reverseWarm = container.find(c => c.state === 'warm' && !c.work_job_id) ?? container.find(c => c.state === 'warm');
  const containerInfo = container.map(c => {
    const haengt = Number(c.runs_unbekannt) > 0 && Number(c.runs_laufend) === 0 && Number(c.alter_s) >= gnade
      || (c.state === 'waiting' && Number(c.alter_s) >= gnade);
    const ursache: ReverseUrsache | null = c.state === 'blocked' ? 'container_gesperrt' : haengt ? 'container_haengt'
      : c.state === 'warm' && c.job_beendet ? 'container_verwaist' : null;
    return { instance: String(c.instance_id).slice(0, 12), zustand: c.state, scope: c.work_job_id ? 'auftrag' : 'global', work_job_id: c.work_job_id,
      alter_s: zahl(c.alter_s), runs_unbekannt: Number(c.runs_unbekannt), letzter_fehler: c.last_error ?? null, gesperrt_bis: iso(c.blocked_until),
      ...(ursache ? { ursache, ursache_text: TEXT[ursache].text, empfohlen: TEXT[ursache].schritt } : {}), _instance_id: c.instance_id };
  });
  const eintraege: ReverseDiagnoseEintrag[] = [];
  const eintrag = (x: Partial<ReverseDiagnoseEintrag> & { ursache: ReverseUrsache }): void => {
    eintraege.push({ auftrag_id: null, p20_auftrag_id: null, reverse_id: null, schicht: null, kind: null, zustand: 'offen', work_zustand: null,
      alter_s: null, lease_bis: null, owner: null, container_zustand: null, fehlercode: null, fehler_detail: null, ...x,
      ursache_text: TEXT[x.ursache].text, empfohlen: TEXT[x.ursache].schritt, automatisch: x.automatisch ?? REVERSE_ENTSTOERBAR.includes(x.ursache) } as ReverseDiagnoseEintrag);
  };
  const jobUrsache = (w: Row): { ursache: ReverseUrsache; container_zustand: string | null; container_instanz: string | null; container_job: string | null } => {
    const eigen = containerInfo.find(c => c.work_job_id === w.id) ?? (reverseWarm ? containerInfo.find(c => c._instance_id === reverseWarm.instance_id) : undefined)
      ?? containerInfo.find(c => !c.work_job_id);
    const cz = eigen ? String(eigen.zustand) : 'cold';
    const mit = (ursache: ReverseUrsache) => ({ ursache, container_zustand: cz, container_instanz: eigen ? String(eigen.instance) : null, container_job: (eigen?.work_job_id ?? null) as string | null });
    // N2: erst der Job-Zustand. Nur ein pending Job ohne Ausführer ist 'kein_ausfuehrer'; geleaste laufen aus bzw. werden über die Lease behandelt.
    if (w.lease_abgelaufen) return mit('lease_abgelaufen');
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
    if (w) { eintrag({ ...basis, ...jobUrsache(w) }); continue; }
    if (a.ausfuehrung === 'api') { eintrag({ ...basis, ursache: a.status === 'laeuft' ? 'laeuft' : 'in_warteschlange' }); continue; }
    if (a.p20 && a.work_state && !['pending', 'leased', 'staged'].includes(String(a.work_state))) { eintrag({ ...basis, ursache: 'auftrag_verwaist' }); continue; }
    if (!kinds.includes(String(basis.kind))) { eintrag({ ...basis, ursache: 'kein_ausfuehrer' }); continue; }
    eintrag({ ...basis, ursache: f.code === 'container_gesperrt' ? 'container_gesperrt' : 'wartet_auf_start' });
  }
  for (const w of jobs) {
    if (gesehen.has(String(w.id))) continue;
    eintrag({ p20_auftrag_id: String(w.id), reverse_id: (w.reverse_id ?? null) as string | null, kind: String(w.kind), zustand: String(w.state),
      work_zustand: String(w.state), alter_s: zahl(w.alter_s), lease_bis: iso(w.lease_until), owner: (w.owner_node ?? null) as string | null,
      ...jobUrsache(w) });
  }
  const ursachen: Record<string, number> = {};
  for (const e of eintraege) ursachen[e.ursache] = (ursachen[e.ursache] ?? 0) + 1;
  for (const c of containerInfo) if (c.ursache) ursachen[c.ursache] = (ursachen[c.ursache] ?? 0) + 1;
  return {
    ausfuehrer: aus ? { aktiv: true, kinds, parallel: aus.parallel } : { aktiv: false, kinds: [], hinweis: 'Kein Reverse-Executor angemeldet (SYNAPSE_REVERSE_ENABLED/Konfiguration prüfen).' },
    container: { belegt, max, reverse_container: containerInfo.filter(c => c.zustand !== 'blocked').length, instanzen: containerInfo.map(({ _instance_id, ...c }) => c) },
    auftraege: eintraege, ursachen, anzahl: eintraege.length,
    automatik: { aktiv: entstoererAktiv(), letzter_lauf: letzterAutoLauf, massnahmen: verlauf.slice(0, 20) },
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
  const d = await diagnoseReverse({ reverseId: o.reverseId, pool: db, limit: 1000 });
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
      neu(e.ursache, 'container_neustart', ziel, ausfuehren ? await neustart(db, quelle, e.container_job ?? null) : 'vorschau');
    }
  }
  for (const c of instanzen) {
    const key = 'i:' + String(c.instance);
    if (erledigt.has(key)) continue;
    erledigt.add(key);
    neu(String(c.ursache), 'container_neustart', 'instanz:' + String(c.instance), ausfuehren ? await neustart(db, quelle, (c.work_job_id ?? null) as string | null) : 'vorschau');
  }
  return { vorschau: !ausfuehren, massnahmen, anzahl: massnahmen.length, ...(massnahmen.length ? {} : { hinweis: 'Nichts zu entstören.' }) };
}

async function neustart(db: Db, quelle: string, jobId: string | null): Promise<string> {
  const hook = reverseAusfuehrer()?.containerNeustart;
  if (!hook) return 'nicht_moeglich: kein Reverse-Executor/Lebenszyklus angemeldet';
  try {
    const r = await hook(jobId);
    await tx(db, c => audit(c, null, { quelle, ursache: 'container_haengt', massnahme: 'container_neustart', ergebnis: r, job: jobId }));
    return r.neu_gestartet ? 'gestoppt: Lebenszyklus startet neu' : 'unveraendert: ' + String(r.zustand ?? 'kein Container');
  } catch (e) { return 'fehler: ' + (e as Error).message; }
}

let timerAktiv = false;
function entstoererAktiv(): boolean { return timerAktiv; }

/**
 * Automatischer Entstörer im API-Prozess. Aus: SYNAPSE_REVERSE_ENTSTOERER=0.
 * Intervall SYNAPSE_REVERSE_ENTSTOERER_MS (60000), Gnadenfrist SYNAPSE_REVERSE_ENTSTOERER_GNADE_S (300) für
 * Leases/Container, SYNAPSE_REVERSE_ENTSTOERER_KEIN_AUSFUEHRER_S (60) für ausführerlose Aufträge.
 */
export function starteReverseEntstoerer(o: { pool?: Db } = {}): { durchlauf: () => Promise<Row>; beende: () => void } | null {
  if (process.env.SYNAPSE_REVERSE_ENTSTOERER === '0') return null;
  const intervall = envZahl('SYNAPSE_REVERSE_ENTSTOERER_MS', 60000, 1000);
  const gnade = envZahl('SYNAPSE_REVERSE_ENTSTOERER_GNADE_S', 300);
  const ohne = envZahl('SYNAPSE_REVERSE_ENTSTOERER_KEIN_AUSFUEHRER_S', 60);
  let laeuft: Promise<Row> | null = null;
  const durchlauf = async (): Promise<Row> => {
    if (laeuft) return laeuft;
    laeuft = (async () => {
      const ergebnis: Row = { kein_ausfuehrer: null, rest: null };
      try {
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
  const timer = setInterval(() => { if (!workerPausiert('reverse-entstoerer')) void durchlauf(); }, intervall);
  timer.unref();
  timerAktiv = true;
  return { durchlauf, beende: () => { clearInterval(timer); timerAktiv = false; } };
}
