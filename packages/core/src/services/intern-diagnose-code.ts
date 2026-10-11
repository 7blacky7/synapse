/**
 * MODUL: Intern-Diagnose, Code-Pfad (P15-T15, Welle 1)
 * ZWECK: Antworten auf "warum passiert hier nichts?" fuer Code-Dateien, Chunks, Projekte und Shell-Jobs,
 *        Sicht auf Parse-Ausfaelle und den Parser-Pool, gezieltes Neu-Parsen einer Datei und der
 *        PG-Teil des Sync-Inspektors. Eingehaengt ueber intern-diagnose.ts (Dispatcher).
 *
 * NUR LESEN, mit EINER Ausnahme: parse_neu mit ausfuehren:true parst Dateien neu (parseAndEmbed mit
 *   erzwingeParse, Standard ohne Embeddings). Ohne ausfuehren nur Vorschau.
 * PROZESS: parser_pool und Worker-Pausen zeigen DIESEN Prozess (REST-API). Pool und Platte des lokalen
 *   Daemons kommen seit P15-T23 ueber die Bruecke (intern-diagnose-daemon.ts, prozess "daemon").
 * ANTWORT: Objekte mit befund[] in Klartext; Fehler wirft DiagnoseFehler (der Dispatcher faengt).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { getPool, imHintergrund } from '../db/client.js';
import { parseAndEmbed } from './code.js';
import { alleSchalter } from './intern-schalter.js';
import { workerStatus } from './worker-steuerung.js';
import { getParserPoolZustand } from '../parser/worker-pool.js';

export class DiagnoseFehler extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DiagnoseFehler';
  }
}

/** Gibt es die Tabelle? parse_failures entsteht erst beim ersten Ausfall (db/parse-failures.ts). */
export async function tabelleDa(name: string): Promise<boolean> {
  const { rows } = await getPool().query<{ t: string | null }>('SELECT to_regclass($1) AS t', ['public.' + name]);
  return rows[0]?.t !== null;
}

function alterMin(t: Date | string | null | undefined): number | null {
  if (!t) return null;
  return Math.round((Date.now() - new Date(t).getTime()) / 6000) / 10;
}

/** Schalter + pausierte Worker dieses Prozesses, die Code-Arbeit anhalten. */
async function bremsen(): Promise<{ schalter: Array<Record<string, unknown>>; pausiert: string[] }> {
  let schalter: Array<Record<string, unknown>> = [];
  try {
    schalter = ((await alleSchalter()) as unknown as Array<Record<string, unknown>>).filter((s) => s.aktiv === true);
  } catch { /* Tabelle fehlt -> keine Schalter */ }
  const pausiert = workerStatus().filter((w) => w.zustand === 'pausiert').map((w) => `${w.name} bis ${w.pause?.bis} (${w.pause?.grund})`);
  return { schalter, pausiert };
}

async function projektStand(project: string): Promise<{ registriert: boolean; aktiv: boolean; hosts: unknown[]; stufe: number; stufe_gesetzt: boolean }> {
  const pool = getPool();
  const { rows } = await pool.query<{ hostname: string; enabled: boolean; last_access: Date }>(
    'SELECT hostname, enabled, last_access FROM projects WHERE name = $1 ORDER BY hostname', [project],
  );
  const prio = await pool.query<{ stufe: number }>('SELECT stufe FROM embed_prioritaet WHERE project = $1', [project]).catch(() => ({ rows: [] as Array<{ stufe: number }> }));
  return {
    registriert: rows.length > 0,
    aktiv: rows.some((r) => r.enabled),
    hosts: rows,
    stufe: prio.rows[0]?.stufe ?? 3,
    stufe_gesetzt: prio.rows.length > 0,
  };
}

// ───── warum_nicht ──────────────────────────────────────────────────────

export interface WarumNichtAuftrag {
  chunk_id?: string;
  project?: string;
  file_path?: string;
  shell_job_id?: string;
}

/** Erklaert, warum ein Chunk / eine Datei / ein Projekt / ein Shell-Job nicht bearbeitet wird. */
export async function warumNicht(a: WarumNichtAuftrag): Promise<Record<string, unknown>> {
  if (a.shell_job_id) return warumNichtShell(a.shell_job_id);
  if (a.chunk_id) return warumNichtChunk(a.chunk_id);
  if (a.project && a.file_path) return warumNichtDatei(a.project, a.file_path);
  if (a.project) return warumNichtProjekt(a.project);
  throw new DiagnoseFehler('parameter_fehlt', 'warum_nicht: chunk_id ODER project + file_path ODER project ODER shell_job_id angeben.');
}

async function warumNichtChunk(id: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, project, file_path, chunk_index, embedded_at, claimed_by, lease_until, claim_attempt,
            length(content)::int AS zeichen, (lease_until IS NOT NULL AND lease_until >= NOW()) AS lease_aktiv
       FROM code_chunks WHERE id = $1`, [id],
  );
  const c = rows[0];
  if (!c) return { art: 'chunk', chunk_id: id, gefunden: false, befund: ['Chunk nicht in code_chunks - Datei neu gechunkt (andere ID) oder geloescht.'] };
  const befund: string[] = [];
  if (c.embedded_at) {
    befund.push(`Nichts offen: eingebettet am ${new Date(c.embedded_at).toISOString()}${c.claimed_by ? ' (zuletzt geclaimt von ' + c.claimed_by + ')' : ''}.`);
    return { art: 'chunk', chunk: c, befund };
  }
  const p = await projektStand(c.project);
  if (!p.registriert) befund.push(`Projekt ${c.project} steht nicht in der Registry (projects) - Claims waehlen nur registrierte Projekte.`);
  else if (!p.aktiv) befund.push(`Projekt ${c.project} ist deaktiviert (enabled=false auf allen Hosts) - keine Claims.`);
  const b = await bremsen();
  for (const s of b.schalter) if (s.name === 'embedding') befund.push(`Schalter embedding ist an (${s.modus}, bis ${s.bis ?? 'dauerhaft'}) - claimEmbeddingChunks liefert nichts.`);
  for (const w of b.pausiert) befund.push(`Worker in diesem Prozess pausiert: ${w}.`);
  if (c.lease_aktiv) befund.push(`Geclaimt von ${c.claimed_by} bis ${new Date(c.lease_until).toISOString()} - wartet auf dessen Abschluss oder Ablauf.`);
  else if (c.lease_until) befund.push(`Lease von ${c.claimed_by} ist abgelaufen (${new Date(c.lease_until).toISOString()}) - der Chunk ist wieder claimbar.`);
  if (c.claim_attempt >= 3) befund.push(`claim_attempt ${c.claim_attempt}: wurde mehrfach geclaimt und nie abgeschlossen - Verdacht auf einen Fehler beim Einbetten genau dieses Chunks (Laenge ${c.zeichen} Zeichen).`);
  // Reihenfolge: Projekte mit kleinerer Stufe kommen zuerst dran
  const vor = await pool.query<{ projekte: number; chunks: number }>(
    `SELECT count(DISTINCT cc.project)::int AS projekte, count(*)::int AS chunks
       FROM code_chunks cc
      WHERE cc.embedded_at IS NULL
        AND COALESCE((SELECT e.stufe FROM embed_prioritaet e WHERE e.project = cc.project), 3) < $1
        AND EXISTS (SELECT 1 FROM projects pr WHERE pr.name = cc.project AND pr.enabled)`, [p.stufe],
  );
  if (vor.rows[0].chunks > 0) {
    befund.push(`Prioritaet: Projekt hat Stufe ${p.stufe}; vor ihm liegen ${vor.rows[0].projekte} Projekt(e) mit kleinerer Stufe und ${vor.rows[0].chunks} offenen Chunks.`);
  }
  const knoten = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM embedding_knoten WHERE letzter_kontakt > NOW() - INTERVAL '2 minutes' AND NOT gesperrt_vom_user`).catch(() => ({ rows: [{ n: 0 }] }));
  if (befund.length === 0) befund.push(`Kein Hindernis gefunden: der Chunk ist claimbar. Aktive GPU-Knoten (Kontakt < 2 min): ${knoten.rows[0].n}; der Server-Loop claimt als 'unraid-local'. intern(durchsatz) zeigt, ob ueberhaupt etwas fertig wird.`);
  return { art: 'chunk', chunk: c, projekt: p, aktive_knoten: knoten.rows[0].n, befund };
}

async function warumNichtDatei(project: string, filePath: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT file_path, file_type, file_size, (content IS NULL) AS ohne_inhalt, content_hash, parsed_at, parser_version,
            indexed_at, updated_at, deleted_at, chunk_count
       FROM code_files WHERE project = $1 AND file_path = $2`, [project, filePath],
  );
  const f = rows[0];
  const befund: string[] = [];
  if (!f) {
    befund.push('Datei steht nicht in code_files - nie synchronisiert (Ignore-Regel? Daemon fuer das Projekt aus?) oder anderer Pfad (Gross-/Kleinschreibung, fuehrendes ./).');
    return { art: 'datei', project, file_path: filePath, gefunden: false, befund };
  }
  const p = await projektStand(project);
  if (!p.registriert) befund.push(`Projekt ${project} steht nicht in der Registry - Parser-Worker und Claims ueberspringen es.`);
  else if (!p.aktiv) befund.push(`Projekt ${project} ist deaktiviert - Parser-Worker und Claims ueberspringen es.`);
  if (f.deleted_at) befund.push(`Datei ist als geloescht markiert (deleted_at ${new Date(f.deleted_at).toISOString()}).`);
  if (f.ohne_inhalt) befund.push('Kein Inhalt in PG (content NULL): Binaer- oder Mediendatei bzw. zu gross - wird nicht geparst.');
  let ausfall: Record<string, unknown> | null = null;
  if (await tabelleDa('parse_failures')) {
    const r = await pool.query('SELECT grund, details, parser, dauer_ms, datei_bytes, aufgetreten_am FROM parse_failures WHERE project = $1 AND file_path = $2', [project, filePath]);
    ausfall = r.rows[0] ?? null;
    if (ausfall) befund.push(`Parse-Ausfall vermerkt: ${ausfall.grund} am ${new Date(ausfall.aufgetreten_am as string).toISOString()} (${String(ausfall.details ?? '').slice(0, 200)}). Neu parsen: intern(parse_neu).`);
  }
  const b = await bremsen();
  if (!f.parsed_at && !f.ohne_inhalt) {
    befund.push('parsed_at ist NULL: Datei wartet auf den Parser-Worker (30-s-Takt, groesster Rueckstand je Stufe zuerst).');
    for (const s of b.schalter) if (s.name === 'parser') befund.push(`Schalter parser ist an (bis ${s.bis ?? 'dauerhaft'}) - der Parser-Worker holt nichts.`);
  }
  for (const w of b.pausiert) befund.push(`Worker in diesem Prozess pausiert: ${w}.`);
  const ch = await pool.query<{ gesamt: number; offen: number; geclaimt: number; max_attempt: number | null }>(
    `SELECT count(*)::int AS gesamt, count(*) FILTER (WHERE embedded_at IS NULL)::int AS offen,
            count(*) FILTER (WHERE embedded_at IS NULL AND lease_until >= NOW())::int AS geclaimt,
            max(claim_attempt) FILTER (WHERE embedded_at IS NULL) AS max_attempt
       FROM code_chunks WHERE project = $1 AND file_path = $2`, [project, filePath],
  );
  const c = ch.rows[0];
  if (f.parsed_at && c.gesamt === 0 && !f.ohne_inhalt) befund.push('Geparst, aber keine Chunks - leere Datei oder Chunking ohne Ergebnis.');
  if (c.offen > 0) {
    befund.push(`${c.offen}/${c.gesamt} Chunks ohne Vektor (${c.geclaimt} gerade geclaimt, hoechster claim_attempt ${c.max_attempt ?? 0}).`);
    for (const s of b.schalter) if (s.name === 'embedding') befund.push(`Schalter embedding ist an (${s.modus}) - keine Claims.`);
    if (process.env.SYNAPSE_PARSE_EMBED_OFFEN === '0') befund.push('SYNAPSE_PARSE_EMBED_OFFEN=0: Chunks ohne Vektor laufen NUR ueber die Claim-Schleife, nicht ueber den Parse-Weg.');
  }
  if (befund.length === 0) befund.push('Kein Hindernis gefunden: geparst, alle Chunks eingebettet.');
  return { art: 'datei', project, datei: f, chunks: c, parse_ausfall: ausfall, projekt: p, befund };
}

async function warumNichtProjekt(project: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const p = await projektStand(project);
  const befund: string[] = [];
  if (!p.registriert) befund.push('Nicht in der Registry (projects): Parser-Worker und Claims bedienen nur registrierte Projekte.');
  else if (!p.aktiv) befund.push('Deaktiviert (enabled=false auf allen Hosts).');
  const zahlen = await pool.query<{ dateien: number; ungeparst: number; ohne_inhalt: number }>(
    `SELECT count(*)::int AS dateien, count(*) FILTER (WHERE parsed_at IS NULL AND content IS NOT NULL)::int AS ungeparst,
            count(*) FILTER (WHERE content IS NULL)::int AS ohne_inhalt
       FROM code_files WHERE project = $1 AND deleted_at IS NULL`, [project],
  );
  const chunks = await pool.query<{ offen: number; geclaimt: number; abgelaufen: number }>(
    `SELECT count(*)::int AS offen, count(*) FILTER (WHERE lease_until >= NOW())::int AS geclaimt,
            count(*) FILTER (WHERE lease_until < NOW())::int AS abgelaufen
       FROM code_chunks WHERE project = $1 AND embedded_at IS NULL`, [project],
  );
  let ausfaelle = 0;
  if (await tabelleDa('parse_failures')) {
    ausfaelle = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM parse_failures WHERE project = $1', [project])).rows[0].n;
  }
  const b = await bremsen();
  for (const s of b.schalter) befund.push(`Schalter ${s.name} ist an (${s.modus ?? ''}, bis ${s.bis ?? 'dauerhaft'}).`);
  for (const w of b.pausiert) befund.push(`Worker in diesem Prozess pausiert: ${w}.`);
  const z = zahlen.rows[0];
  const c = chunks.rows[0];
  if (z.ungeparst > 0) befund.push(`${z.ungeparst} Dateien warten aufs Parsen.`);
  if (c.offen > 0) befund.push(`${c.offen} Chunks ohne Vektor (${c.geclaimt} geclaimt, ${c.abgelaufen} mit abgelaufenem Lease). Stufe ${p.stufe}${p.stufe_gesetzt ? '' : ' (Standard)'}.`);
  if (ausfaelle > 0) befund.push(`${ausfaelle} Parse-Ausfaelle offen - intern(parse_ausfaelle, project).`);
  if (befund.length === 0) befund.push('Kein Rueckstand und kein Hindernis gefunden.');
  return { art: 'projekt', project, projekt: p, dateien: z, chunks: c, parse_ausfaelle: ausfaelle, befund };
}

async function warumNichtShell(id: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DiagnoseFehler('parameter_ungueltig', 'shell_job_id: Job-UUID (aus shell(history)).');
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, project, status, left(command, 200) AS command, agent_id, claimed_by, claimed_at, created_at, completed_at, error, message
       FROM shell_jobs WHERE id = $1`, [id],
  );
  const j = rows[0];
  if (!j) return { art: 'shell_job', shell_job_id: id, gefunden: false, befund: ['Job nicht gefunden (falsche ID - stream_id ist keine Job-ID - oder aufgeraeumt).'] };
  const hb = await pool.query('SELECT hostname, daemon_pid, last_seen, EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS alter_s FROM daemon_heartbeats WHERE project = $1', [j.project]);
  const vorher = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM shell_jobs WHERE project = $1 AND status = 'pending' AND created_at < $2`, [j.project, j.created_at],
  );
  const befund: string[] = [];
  const h = hb.rows[0];
  if (j.status === 'pending') {
    if (!h) befund.push(`Fuer Projekt ${j.project} hat sich nie ein Daemon gemeldet (daemon_heartbeats) - niemand claimt den Job.`);
    else if (h.alter_s > 30) befund.push(`Daemon ${h.hostname} zuletzt vor ${h.alter_s} s gesehen (> 30 s) - vermutlich aus; der Job bleibt pending.`);
    if (vorher.rows[0].n > 0) befund.push(`${vorher.rows[0].n} aeltere Jobs des Projekts sind ebenfalls noch pending.`);
    if (befund.length === 0) befund.push('Daemon lebt, nichts davor - der Job sollte gleich geclaimt werden (LISTEN shell_job_created bzw. Safety-Poll 10 s). Ist die shell-Queue im Daemon pausiert? intern(worker_status, prozess daemon).');
  } else if (j.status === 'running') {
    befund.push(`Laeuft seit ${alterMin(j.claimed_at)} min auf ${j.claimed_by ?? '?'}.`);
  } else {
    befund.push(`Abgeschlossen: ${j.status}${j.error ? ' (' + j.error + ')' : ''} am ${j.completed_at ? new Date(j.completed_at).toISOString() : '?'}.`);
  }
  return { art: 'shell_job', job: j, daemon: h ?? null, aeltere_pending: vorher.rows[0].n, befund };
}

// ───── parse_ausfaelle / parse_neu ─────────────────────────────────────

export async function parseAusfaelle(project: string | undefined, limit: number): Promise<Record<string, unknown>> {
  if (!(await tabelleDa('parse_failures'))) {
    return { anzahl: 0, eintraege: [], hinweis: 'Tabelle parse_failures gibt es noch nicht - es gab nie einen Parse-Ausfall (sie entsteht beim ersten).' };
  }
  const pool = getPool();
  const [liste, je] = await Promise.all([
    pool.query(
      `SELECT project, file_path, grund, left(details, 300) AS details, parser, dauer_ms, datei_bytes, aufgetreten_am
         FROM parse_failures WHERE ($1::text IS NULL OR project = $1)
        ORDER BY aufgetreten_am DESC LIMIT $2`, [project ?? null, limit],
    ),
    pool.query(
      `SELECT project, grund, count(*)::int AS n, max(aufgetreten_am) AS zuletzt
         FROM parse_failures WHERE ($1::text IS NULL OR project = $1)
        GROUP BY project, grund ORDER BY n DESC`, [project ?? null],
    ),
  ]);
  const anzahl = je.rows.reduce((s, r) => s + Number(r.n), 0);
  return {
    anzahl,
    je_projekt_grund: je.rows,
    eintraege: liste.rows,
    hinweis: 'Ein Eintrag verschwindet, sobald dieselbe Datei wieder erfolgreich geparst wird. Neu parsen: intern(parse_neu, project, file_path | alle_ausfaelle, ausfuehren:true).',
  };
}

export interface ParseNeuAuftrag {
  project: string;
  dateien?: string[];
  alle_ausfaelle?: boolean;
  limit: number;
  ausfuehren: boolean;
  mit_embeddings: boolean;
}

async function dateiStand(project: string, filePath: string, mitAusfall: boolean): Promise<Record<string, unknown>> {
  const pool = getPool();
  const f = await pool.query(
    `SELECT (content IS NULL) AS ohne_inhalt, deleted_at, parsed_at, parser_version, file_size,
            (SELECT count(*)::int FROM code_symbols s WHERE s.project = cf.project AND s.file_path = cf.file_path) AS symbole
       FROM code_files cf WHERE project = $1 AND file_path = $2`, [project, filePath],
  );
  const ausfall = mitAusfall
    ? (await pool.query('SELECT grund, left(details, 200) AS details, aufgetreten_am FROM parse_failures WHERE project = $1 AND file_path = $2', [project, filePath])).rows[0] ?? null
    : null;
  return f.rows[0] ? { gefunden: true, ...f.rows[0], parse_ausfall: ausfall } : { gefunden: false, parse_ausfall: ausfall };
}

/** Vorschau (Standard) oder gezieltes Neu-Parsen mit erzwingeParse. */
export async function parseNeu(a: ParseNeuAuftrag): Promise<Record<string, unknown>> {
  const pool = getPool();
  const mitAusfall = await tabelleDa('parse_failures');
  let dateien = a.dateien ?? [];
  if (a.alle_ausfaelle) {
    if (!mitAusfall) dateien = [];
    else {
      const r = await pool.query<{ file_path: string }>(
        'SELECT file_path FROM parse_failures WHERE project = $1 ORDER BY aufgetreten_am LIMIT $2', [a.project, a.limit],
      );
      dateien = r.rows.map((x) => x.file_path);
    }
  }
  if (dateien.length === 0) {
    throw new DiagnoseFehler('parameter_fehlt', a.alle_ausfaelle ? `Keine Parse-Ausfaelle in ${a.project}.` : 'parse_neu: file_path (Text oder Liste) oder alle_ausfaelle:true angeben.');
  }
  if (dateien.length > a.limit) dateien = dateien.slice(0, a.limit);
  const vorher: Array<Record<string, unknown>> = [];
  for (const d of dateien) vorher.push({ file_path: d, ...(await dateiStand(a.project, d, mitAusfall)) });
  const p = await projektStand(a.project);
  if (!a.ausfuehren) {
    return {
      modus: 'vorschau',
      project: a.project,
      projekt_aktiv: p.aktiv,
      dateien: vorher,
      hinweis: `Nur Vorschau, nichts geparst. Ausfuehren mit ausfuehren:true: parseAndEmbed mit erzwingeParse je Datei, ${a.mit_embeddings ? 'MIT' : 'ohne'} Neu-Chunken/Einbetten (mit_embeddings).`,
    };
  }
  if (!p.aktiv) throw new DiagnoseFehler('projekt_inaktiv', `Projekt ${a.project} ist nicht registriert oder deaktiviert - Parser-Worker und Claims bedienen es nicht. Erst project(enable), dann neu parsen.`);
  const ergebnis: Array<Record<string, unknown>> = [];
  for (const v of vorher) {
    const datei = String(v.file_path);
    if (!v.gefunden || v.ohne_inhalt) {
      ergebnis.push({ file_path: datei, uebersprungen: !v.gefunden ? 'nicht in code_files' : 'kein Inhalt in PG' });
      continue;
    }
    const t0 = Date.now();
    let fehler: string | null = null;
    try {
      // Hintergrund-Pool: ein Neu-Parse darf die Verbindungen der Tool-Anfragen nicht belegen (P5-T15)
      await imHintergrund(() => parseAndEmbed(a.project, datei, { erzwingeParse: true, ohneEmbeddings: !a.mit_embeddings }));
    } catch (err) {
      fehler = err instanceof Error ? err.message : String(err);
    }
    const nachher = await dateiStand(a.project, datei, mitAusfall || (await tabelleDa('parse_failures')));
    ergebnis.push({
      file_path: datei,
      dauer_ms: Date.now() - t0,
      fehler,
      symbole_vorher: v.symbole,
      symbole_nachher: nachher.symbole,
      ausfall_vorher: v.parse_ausfall ? (v.parse_ausfall as Record<string, unknown>).grund : null,
      ausfall_nachher: nachher.parse_ausfall ? (nachher.parse_ausfall as Record<string, unknown>).grund : null,
      parsed_at: nachher.parsed_at,
    });
  }
  return {
    modus: 'ausgefuehrt',
    project: a.project,
    ergebnis,
    hinweis: 'ausfall_nachher null = Eintrag aufgeloest. Ein neuer Ausfall steht wieder in parse_ausfaelle.',
  };
}

// ───── sync_inspektor (PG-Teil) ─────────────────────────────────────────

export async function syncInspektor(project: string, filePath: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT content, content_hash, file_size, updated_at, indexed_at, parsed_at, deleted_at
       FROM code_files WHERE project = $1 AND file_path = $2`, [project, filePath],
  );
  const f = rows[0];
  const versionen = await pool.query(
    `SELECT id::text, agent_id, edit_action, content_hash, size_bytes, batch_id::text, left(reason, 200) AS reason, created_at
       FROM file_versions WHERE project = $1 AND file_path = $2 ORDER BY created_at DESC, id DESC LIMIT 5`, [project, filePath],
  );
  const reservierungen = await pool.query(
    `SELECT agent_id, reserved_at, expires_at, plan_id::text FROM file_reservations
      WHERE project = $1 AND file_path = $2 AND released_at IS NULL AND expires_at > NOW()`, [project, filePath],
  );
  const plaene = await pool.query(
    `SELECT id::text, owner_agent_id, status::text, created_at FROM file_batch_plans
      WHERE project = $1 AND status = 'open'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(ops) o WHERE o->>'file_path' = $2)`, [project, filePath],
  );
  const watcher = await pool.query(
    `SELECT event_type, details, created_at FROM watcher_events WHERE project = $1 AND file_path = $2
      ORDER BY created_at DESC LIMIT 5`, [project, filePath],
  ).catch(() => ({ rows: [] as unknown[] }));
  const hb = await pool.query(
    'SELECT hostname, last_seen, EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS alter_s FROM daemon_heartbeats WHERE project = $1', [project],
  );
  const befund: string[] = [];
  let pg: Record<string, unknown> | null = null;
  if (!f) {
    befund.push('Datei steht nicht in code_files.');
  } else {
    const berechnet = f.content === null ? null : createHash('sha256').update(f.content, 'utf8').digest('hex');
    pg = {
      content_hash: f.content_hash,
      hash_aus_inhalt: berechnet,
      zeichen: f.content === null ? null : f.content.length,
      file_size: f.file_size,
      updated_at: f.updated_at, indexed_at: f.indexed_at, parsed_at: f.parsed_at, deleted_at: f.deleted_at,
    };
    if (berechnet && f.content_hash && berechnet !== f.content_hash) befund.push('content_hash passt NICHT zum Inhalt in PG - Hash veraltet, der Sync vergleicht dann falsch.');
    if (f.deleted_at) befund.push(`In PG als geloescht markiert (${new Date(f.deleted_at).toISOString()}).`);
    const letzte = versionen.rows[0];
    if (!letzte) {
      befund.push('Keine file_version: die Datei wurde nie ueber das files-Tool geschrieben (nur Watcher/Erstscan). Zuruecksetzen ueber files(restore) geht dann nicht.');
    } else if (letzte.content_hash !== f.content_hash) {
      const neuer = new Date(f.updated_at) > new Date(letzte.created_at);
      befund.push(neuer
        ? `PG-Stand weicht von der letzten file_version (${letzte.id}, ${letzte.agent_id ?? '?'}) ab und ist NEUER: zuletzt von der Platte gekommen (Editor, git, lokaler Edit ohne files-Tool).`
        : `PG-Stand weicht von der letzten file_version (${letzte.id}) ab, ist aber AELTER - unerwartet, Versionierung pruefen.`);
    } else {
      befund.push(`PG-Stand = letzte file_version ${letzte.id} (${letzte.agent_id ?? '?'}, ${new Date(letzte.created_at).toISOString()}).`);
    }
  }
  if (reservierungen.rows.length > 0) befund.push(`${reservierungen.rows.length} aktive Reservierung(en).`);
  if (plaene.rows.length > 0) befund.push(`${plaene.rows.length} offene(r) Plan/Plaene mit Ops auf dieser Datei - ein commit aendert sie gleich.`);
  const h = hb.rows[0];
  if (!h) befund.push('Kein Daemon-Heartbeat fuer das Projekt: PG -> Platte findet derzeit nicht statt.');
  else if (h.alter_s > 30) befund.push(`Daemon ${h.hostname} zuletzt vor ${h.alter_s} s gesehen: PG -> Platte steht vermutlich.`);
  return {
    project, file_path: filePath,
    pg,
    versionen: versionen.rows,
    reservierungen: reservierungen.rows,
    offene_plaene: plaene.rows,
    watcher_events: watcher.rows,
    daemon: h ?? null,
    platte: null,
    befund,
    daemon_teil: 'Plattenstand (existiert, groesse, mtime, sha256, Vergleich mit PG): prozess "daemon" bzw. "daemon:<host>" angeben.',
  };
}

// ───── parser_pool ──────────────────────────────────────────────────────

/** Threads dieses Prozesses laut /proc/self/task (Linux), sonst null. */
function threadZahl(): number | null {
  try {
    return existsSync('/proc/self/task') ? readdirSync('/proc/self/task').length : null;
  } catch {
    return null;
  }
}

export function parserPool(prozess = 'api'): Record<string, unknown> {
  const daemonTeil = prozess === 'api' ? { daemon_teil: DAEMON_POOL } : {};
  const zustand = getParserPoolZustand();
  const befund: string[] = [];
  const threads = threadZahl();
  if (!zustand) {
    befund.push(process.env.PARSER_WORKER_THREADS === '0'
      ? 'Pool deaktiviert (PARSER_WORKER_THREADS=0): Parse laeuft im Hauptthread, ohne Reissleine.'
      : 'Pool in diesem Prozess noch nie benutzt (wird beim ersten Parse angelegt).');
    return { prozess, pool: null, threads_prozess: threads, befund, ...daemonTeil };
  }
  const slots = (zustand.slots as Array<Record<string, unknown>>) ?? [];
  const still = slots.filter((s) => s.stillgelegt === true);
  if (still.length > 0) {
    befund.push(`${still.length} Slot(s) STILLGELEGT (nach ${zustand.max_retries} Fehlschlaegen nicht neu gestartet): ${still.map((s) => s.slot).join(', ')}. Auftraege dafuer bleiben in der Queue (07ac26de).`);
  }
  if (still.length === slots.length && slots.length > 0) befund.push('ALLE Slots stillgelegt: jeder neue Parse wartet fuer immer - Prozess neu starten.');
  if (Number(zustand.warteschlange) > 0 && slots.every((s) => s.busy === true)) befund.push(`${zustand.warteschlange} Auftraege warten, alle Slots belegt.`);
  for (const s of slots) {
    const lz = Number(s.laufzeit_ms ?? 0);
    const lim = Number(s.limit_ms ?? 0);
    if (s.laufende_datei && lim > 0 && lz > lim * 0.8) befund.push(`Slot ${s.slot}: ${s.laufende_datei} laeuft ${lz} ms von ${lim} ms Limit - Haenger-Verdacht.`);
  }
  if (Number(zustand.beendet_exit_ausstehend) > 0) befund.push(`${zustand.beendet_exit_ausstehend} beendete Worker ohne exit-Ereignis - moegliche verwaiste Threads.`);
  if (befund.length === 0) befund.push('Pool unauffaellig.');
  return {
    prozess,
    pool: zustand,
    threads_prozess: threads,
    hinweis: 'threads_prozess zaehlt ALLE Threads (libuv, V8, Pool) - nur im Verlauf aussagekraeftig: steigt sie nach Timeouts dauerhaft, leben beendete Worker weiter.',
    befund,
    ...daemonTeil,
  };
}

const DAEMON_POOL = 'Der Daemon parst mit eigenem Pool (indexFile): prozess "daemon" bzw. "daemon:<host>" zeigt ihn.';
