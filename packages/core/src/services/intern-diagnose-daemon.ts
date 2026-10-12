/**
 * MODUL: Intern-Diagnose, Daemon-Teil (P15-T23, Folge von P15-T15)
 * ZWECK: Was nur der lokale FileWatcher-Daemon sieht, ueber die Bruecke aus P15-T12 E2 (daemon-bruecke.ts):
 *   sync_datei   Plattenstand EINER Datei (existiert, groesse, mtime, sha256) gegen den PG-Stand
 *                (content_hash, updated_at, deleted_at, bekannte file_versions) mit Klartext-Befund und den
 *                Pausen der Sync-Worker dieses Prozesses (sync_pg_fs, sync_fs_pg).
 *   parser_pool  Parser-Pool DIESES Prozesses (dieselbe Antwort wie die API-Action, prozess daemon:<host>).
 *
 * DAEMON-SEITE: fuehreDiagnoseLokal() ruft intern-bruecke.ts (file-watcher-daemon-ts) fuer die Befehle
 *   sync_datei | parser_pool auf. Den Projektpfad liefert der Daemon aus seiner config.json.
 * API-SEITE: ergaenzeSyncInspektorUmDaemon() / parserPoolUeberDaemon() fuer intern-diagnose.ts
 *   (Parameter prozess "daemon" | "daemon:<host>").
 *
 * NUR LESEN. Dateizugriff ausschliesslich innerhalb des Projektpfads aus der Daemon-Config: kein absoluter
 * Pfad, kein "..", der reale Pfad (Symlinks aufgeloest) muss unter dem realen Projektpfad liegen.
 * Gehasht wird hoechstens SYNC_DATEI_MAX_BYTES (64 MiB), darueber nur Groesse/mtime.
 * HASH: wie storeFileContent (code.ts) - sha256 ueber den UTF-8-Text; zusaetzlich sha256 der Rohbytes,
 *   damit ungueltiges UTF-8 (Hash ungleich obwohl "gleich") sichtbar wird.
 */

import { createHash } from 'node:crypto';
import {dateiDiff,diffText,diffMaxZeichen} from './file-diff.js';
import {maskiereDatei} from './env-maske.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { getPool } from '../db/client.js';
import { workerPausiert } from './worker-steuerung.js';
import { DaemonBrueckeFehler, sendeAnDaemon } from './daemon-bruecke.js';
import { DiagnoseFehler, parserPool } from './intern-diagnose-code.js';

export const DIAGNOSE_DAEMON_BEFEHLE = ['sync_datei', 'parser_pool'] as const;
const SYNC_DATEI_MAX_BYTES = 64 * 1024 * 1024;

export interface DiagnoseDaemonKontext {
  /** z. B. "daemon:<host>" - steht in jeder Antwort */
  prozess: string;
  /** Projektpfad aus der Daemon-Config; undefined = Projekt dort nicht eingetragen */
  projektPfad: (project: string) => string | undefined;
}

const sha256 = (daten: string | Buffer): string =>
  typeof daten === 'string'
    ? createHash('sha256').update(daten, 'utf8').digest('hex')
    : createHash('sha256').update(daten).digest('hex');

function alsIso(t: unknown): string | null {
  if (t === null || t === undefined) return null;
  const d = t instanceof Date ? t : new Date(String(t));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Projektrelativen Pfad pruefen und absolut machen. Wirft DiagnoseFehler bei Ausbruchsversuch. */
function sichererPfad(root: string, rel: string): string {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new DiagnoseFehler('parameter_ungueltig', 'file_path: projektrelativer Pfad erwartet (kein absoluter Pfad).');
  }
  const norm = path.normalize(rel);
  if (norm === '..' || norm.startsWith('..' + path.sep) || norm.split(/[\\/]/).includes('..')) {
    throw new DiagnoseFehler('parameter_ungueltig', 'file_path: ".." ist nicht erlaubt.');
  }
  const abs = path.resolve(root, norm);
  const basis = path.resolve(root);
  if (abs !== basis && !abs.startsWith(basis + path.sep)) {
    throw new DiagnoseFehler('parameter_ungueltig', 'file_path liegt ausserhalb des Projektpfads.');
  }
  return abs;
}

/**
 * Plattenstand einer Datei gegen PG. Laeuft im Daemon (dort liegt die Platte).
 * Liefert immer ein Objekt; PG-Fehler stehen unter pg_fehler, der Plattenteil bleibt.
 */
export async function syncDateiLokal(
  project: string,
  filePath: string,
  projektRoot: string | undefined,
  prozess = 'daemon',
  mitDiff = false,
): Promise<Record<string, unknown>> {
  if (!projektRoot) {
    throw new DiagnoseFehler('projekt_unbekannt',
      `Projekt ${project} steht nicht in der config.json dieses Daemons (${prozess}) - er synct es nicht.`);
  }
  const abs = sichererPfad(projektRoot, filePath);
  const befund: string[] = [];

  // ── Platte ──
  const platte: Record<string, unknown> = { pfad: abs, existiert: false };
  let hashText: string | null = null;
  let plattenText: string | null = null;
  let driftDiff: Record<string,unknown> | undefined;
  try {
    const st = await fsp.stat(abs);
    // Symlink-Ausbruch: realer Pfad muss unter dem realen Projektpfad liegen
    const [realDatei, realRoot] = await Promise.all([fsp.realpath(abs), fsp.realpath(projektRoot)]);
    if (realDatei !== realRoot && !realDatei.startsWith(realRoot + path.sep)) {
      throw new DiagnoseFehler('parameter_ungueltig', 'file_path zeigt ueber einen Symlink aus dem Projektpfad heraus.');
    }
    platte.existiert = true;
    platte.verzeichnis = st.isDirectory();
    platte.groesse = st.size;
    platte.mtime = st.mtime.toISOString();
    platte.mtime_alter_s = Math.round((Date.now() - st.mtimeMs) / 1000);
    if (st.isFile()) {
      if (st.size <= SYNC_DATEI_MAX_BYTES) {
        const buf = await fsp.readFile(abs);
        const text = buf.toString('utf8');
        if(mitDiff)plattenText=text;
        hashText = sha256(text);
        const roh = sha256(buf);
        platte.sha256 = hashText;
        platte.utf8_gueltig = roh === hashText;
        if (roh !== hashText) {
          platte.sha256_roh = roh;
          befund.push('Datei ist kein gueltiges UTF-8: der Sync speichert den dekodierten Text, Rohbytes und PG unterscheiden sich daher immer.');
        }
      } else {
        platte.sha256 = null;
        befund.push(`Datei groesser als ${SYNC_DATEI_MAX_BYTES} Bytes - nicht gehasht, nur Groesse/mtime.`);
      }
    } else if (st.isDirectory()) {
      befund.push('Pfad ist ein Verzeichnis, keine Datei.');
    }
  } catch (err) {
    if (err instanceof DiagnoseFehler) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      platte.fehler = `${code ?? 'fehler'}: ${(err as Error).message}`;
      befund.push(`Platte nicht lesbar (${code ?? 'fehler'}).`);
    }
  }

  // ── PG ──
  let pg: Record<string, unknown> | null = null;
  let pgFehler: string | null = null;
  let bekannteVersion: Record<string, unknown> | null = null;
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT content_hash, file_size, updated_at, deleted_at, (content IS NULL) AS ohne_inhalt
         FROM code_files WHERE project = $1 AND file_path = $2`, [project, filePath],
    );
    const f = rows[0];
    if(mitDiff&&!platte.fehler && (hashText !== (f && !f.deleted_at ? f.content_hash : null) || (platte.existiert === true) !== Boolean(f && !f.deleted_at))) {
      const basis=(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND deleted_at IS NULL',[project,filePath])).rows[0]?.content??'';
      const lokal=plattenText??'';
      if(basis.length<=diffMaxZeichen()&&lokal.length<=diffMaxZeichen()) {
        const d=dateiDiff(maskiereDatei(filePath,basis),maskiereDatei(filePath,lokal));
        const roh=dateiDiff(basis,lokal);
        const bereiche=roh.hunks.flatMap(h=>h.bereiche);
        driftDiff={...diffText(d,d.hunks,()=> 'PG → Platte',120),bereiche:bereiche.slice(0,120),bereiche_gesamt:bereiche.length,
          nur_zeilenenden:roh.nur_zeilenenden,zeilenbasis:'0-basiert, halboffen: a=PG, b=Platte'};
      } else driftDiff={nicht_verfuegbar:'Datei über Diff-Größenbudget',abruf:'sync_inspektor für Hashvergleich'};
    }
    if (f) {
      pg = {
        content_hash: f.content_hash,
        file_size: f.file_size,
        updated_at: alsIso(f.updated_at),
        deleted_at: alsIso(f.deleted_at),
        ohne_inhalt: f.ohne_inhalt === true,
      };
      if (hashText && f.content_hash && hashText !== f.content_hash) {
        const v = await pool.query(
          `SELECT id::text, agent_id, created_at FROM file_versions
            WHERE project = $1 AND file_path = $2 AND content_hash = $3
            ORDER BY created_at DESC, id DESC LIMIT 1`, [project, filePath, hashText],
        );
        if (v.rows[0]) bekannteVersion = { id: v.rows[0].id, agent_id: v.rows[0].agent_id, created_at: alsIso(v.rows[0].created_at) };
      }
    }
  } catch (err) {
    pgFehler = (err as Error).message;
    befund.push(`PG aus dem Daemon nicht abfragbar: ${pgFehler}`);
  }

  // ── Vergleich ──
  let gleichPg: boolean | null = null;
  if (!pgFehler) {
    const existiert = platte.existiert === true && platte.verzeichnis !== true;
    if (!pg) {
      if (existiert) befund.push('Datei liegt auf der Platte, steht aber NICHT in code_files: Platte -> PG hat sie nicht uebernommen (Ignore-Regel, Watcher fuer das Projekt aus, sync_fs_pg pausiert, Ereignis wartet noch).');
      else befund.push('Weder auf der Platte noch in code_files.');
    } else if (pg.deleted_at) {
      if (existiert) befund.push(`In PG als geloescht markiert (${String(pg.deleted_at)}), auf der Platte aber VORHANDEN.`);
      else befund.push('In PG geloescht und auf der Platte nicht vorhanden - konsistent.');
    } else if (!existiert) {
      befund.push('Steht in code_files, fehlt aber auf der Platte: PG -> Platte hat sie nicht geschrieben (sync_pg_fs pausiert, Watcher aus) oder sie wurde lokal geloescht und der Loeschvorgang ist noch nicht in PG.');
    } else if (pg.ohne_inhalt) {
      befund.push('code_files ohne Inhalt (content NULL, z. B. Asset/zu gross): kein Hash-Vergleich moeglich.');
    } else if (hashText) {
      gleichPg = hashText === pg.content_hash;
      if (gleichPg) {
        befund.push('Platte = PG (Hash gleich).');
      } else if (bekannteVersion) {
        befund.push(`Platte weicht ab und zeigt einen AELTEREN bekannten Stand (file_version ${String(bekannteVersion.id)}): PG -> Platte hat den neuen Stand noch nicht geschrieben; Platte -> PG uebernimmt ihn bewusst nicht.`);
      } else {
        befund.push('Platte weicht ab, ihr Hash ist PG UNBEKANNT: lokale Aenderung, die Platte -> PG noch nicht uebernommen hat (sync_fs_pg pausiert, Ereignis wartet auf einen Index-Slot, Ignore-Regel, Watcher aus).');
      }
      if (!gleichPg && pg.updated_at && platte.mtime) {
        const pgNeuer = new Date(String(pg.updated_at)).getTime() > new Date(String(platte.mtime)).getTime();
        befund.push(pgNeuer ? 'PG updated_at ist neuer als die mtime der Platte.' : 'mtime der Platte ist neuer als PG updated_at.');
      }
    }
  }

  const syncPausen = { sync_pg_fs: Boolean(workerPausiert('sync_pg_fs')), sync_fs_pg: Boolean(workerPausiert('sync_fs_pg')) };
  if (syncPausen.sync_pg_fs) befund.push('Worker sync_pg_fs ist in diesem Daemon PAUSIERT: PG -> Platte steht.');
  if (syncPausen.sync_fs_pg) befund.push('Worker sync_fs_pg ist in diesem Daemon PAUSIERT: Platte -> PG steht.');

  return {
    success: true,
    action: 'sync_datei',
    prozess,
    project,
    file_path: filePath,
    platte,
    pg,
    pg_fehler: pgFehler,
    gleich_pg: gleichPg,
    bekannte_version: bekannteVersion,
    ...(mitDiff ? {drift_diff:driftDiff} : {}),
    sync_pausen: syncPausen,
    befund,
  };
}

/** Daemon-Seite: Befehle sync_datei | parser_pool ausfuehren. Wirft nie. */
export async function fuehreDiagnoseLokal(
  befehl: string,
  args: Record<string, unknown>,
  kontext: DiagnoseDaemonKontext,
): Promise<Record<string, unknown>> {
  try {
    if (befehl === 'parser_pool') return { success: true, action: 'parser_pool', ...parserPool(kontext.prozess) };
    if (befehl === 'sync_datei') {
      const project = typeof args.project === 'string' ? args.project : '';
      const filePath = typeof args.file_path === 'string' ? args.file_path : '';
      if (!project || !filePath) throw new DiagnoseFehler('parameter_fehlt', 'sync_datei: project und file_path angeben.');
      return await syncDateiLokal(project, filePath, kontext.projektPfad(project), kontext.prozess, args.mit_diff === true);
    }
    return { success: false, action: befehl, error: 'befehl_unbekannt', message: `Kein Diagnose-Befehl: ${befehl}.` };
  } catch (err) {
    if (err instanceof DiagnoseFehler) return { success: false, action: befehl, error: err.code, message: err.message };
    return { success: false, action: befehl, error: 'daemon_fehler', message: err instanceof Error ? err.message : String(err) };
  }
}

// ───── API-Seite ────────────────────────────────────────────────────────

/** prozess-Parameter: null = API (Standard), sonst Ziel-Host (undefined = der einzige verbundene Daemon). */
export function diagnoseZiel(prozess: string | undefined): { daemon: false } | { daemon: true; host: string | undefined } {
  const p = prozess ?? 'api';
  if (p === 'api') return { daemon: false };
  if (p === 'daemon') return { daemon: true, host: undefined };
  if (p.startsWith('daemon:') && p.length > 'daemon:'.length) return { daemon: true, host: p.slice('daemon:'.length) };
  throw new DiagnoseFehler('parameter_ungueltig', 'prozess: api | daemon | daemon:<host>.');
}

/**
 * sync_inspektor mit prozess daemon: haengt den Plattenstand des Daemons an die PG-Antwort.
 * Ist der Daemon nicht erreichbar, bleibt der PG-Teil gueltig; platte traegt dann den Fehler.
 */
export async function ergaenzeSyncInspektorUmDaemon(
  pgTeil: Record<string, unknown>,
  project: string,
  filePath: string,
  host: string | undefined,
): Promise<Record<string, unknown>> {
  const { daemon_teil: _hinweis, ...pgOhneHinweis } = pgTeil;
  pgTeil = pgOhneHinweis;
  const befund = Array.isArray(pgTeil.befund) ? [...(pgTeil.befund as string[])] : [];
  try {
    const { host: ziel, ergebnis } = await sendeAnDaemon('sync_datei', { project, file_path: filePath }, host);
    if (ergebnis.success === false) {
      befund.push(`Daemon ${ziel}: ${String(ergebnis.message ?? ergebnis.error)}`);
      return { ...pgTeil, prozess: `daemon:${ziel}`, host: ziel, platte: { fehler: ergebnis.error, message: ergebnis.message }, befund };
    }
    for (const b of (ergebnis.befund as string[] | undefined) ?? []) befund.push(`Platte (${ziel}): ${b}`);
    // platte flach: Plattenfelder + Vergleich; die PG-Sicht des Daemons heisst pg_sicht_daemon (pg oben = API-Sicht)
    const { success: _s, action: _a, project: _p, file_path: _f, befund: _b, prozess: _z, platte, pg: pgDaemon, ...vergleich } = ergebnis;
    return {
      ...pgTeil,
      prozess: `daemon:${ziel}`,
      host: ziel,
      platte: { ...((platte as Record<string, unknown>) ?? {}), ...vergleich, pg_sicht_daemon: pgDaemon ?? null },
      gleich_pg: ergebnis.gleich_pg ?? null,
      befund,
    };
  } catch (err) {
    if (!(err instanceof DaemonBrueckeFehler)) throw err;
    befund.push(`Plattenstand nicht verfuegbar: ${err.message}`);
    return { ...pgTeil, platte: { fehler: err.code, message: err.message }, befund };
  }
}

/** parser_pool mit prozess daemon: Pool des Daemon-Prozesses. Bruecken-Fehler gehen an den Aufrufer. */
export async function parserPoolUeberDaemon(host: string | undefined): Promise<Record<string, unknown>> {
  const { host: ziel, ergebnis } = await sendeAnDaemon('parser_pool', {}, host);
  return { ...ergebnis, action: 'parser_pool', prozess: `daemon:${ziel}`, host: ziel };
}
