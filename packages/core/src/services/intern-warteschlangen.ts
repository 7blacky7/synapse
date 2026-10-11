/**
 * MODUL: Intern-Warteschlangen (P15-T12, Etappe 3/4, 11.10.2026)
 * ZWECK: Warteschlangen einsehen (warteschlange_liste) und umsortieren (warteschlange_verschieben, E4)
 *        fuer das Tool 'intern'. intern-tool.ts haengt nur ein (WARTESCHLANGEN_ACTIONS,
 *        WARTESCHLANGEN_PARAMETER, WARTESCHLANGEN_BESCHREIBUNG, fuehreWarteschlangeAus) — Muster
 *        intern-diagnose.ts.
 *
 * WARTESCHLANGEN
 *   PG (nur in der API, von dort fuer alle Prozesse lesbar):
 *     code_chunks       offene Code-Chunks (Embedding), Claims, Leases, Stufe je Projekt
 *     parser            Projekte mit Parse-Backlog bzw. faellige Dateien eines Projekts
 *     wissen_nachzug    Wissens-Eintraege ohne Vektor (memories, thoughts, ...)
 *     shell_jobs, specialist_jobs, project_init_jobs   pending/running
 *   Speicher (warteschlangen-register.ts, je Prozess):
 *     embedding_queue   wartende Embedding-Auftraege (API und Daemon)
 *     index, asset      nur im Daemon (manager.ts), ueber die Bruecke (prozess "daemon")
 * ANTWORT: { success, action, ... }; fuehreWarteschlangeAus wirft nie.
 */

import { getPool, imHintergrund } from '../db/client.js';
import { embeddingWarteschlangeEintraege, getEmbeddingQueueStats } from '../embeddings/index.js';
import { BACKLOG_TABELLEN_INFO, zaehleOffeneEmbeddings } from './embed-backlog.js';
import { listeFaelligeDateien, projekteMitBacklog } from './code.js';
import { DaemonBrueckeFehler, daemonUebersicht, sendeAnDaemon } from './daemon-bruecke.js';
import {
  holeWarteschlange,
  registriereWarteschlange,
  seiteAusListe,
  warteschlangenNamen,
  type WarteschlangenEintrag,
  type WarteschlangenFilter,
  type WarteschlangenListe,
} from './warteschlangen-register.js';

export class WarteschlangenFehler extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export const WARTESCHLANGEN_ACTIONS = ['warteschlange_liste'] as const;
export type WarteschlangenAction = (typeof WARTESCHLANGEN_ACTIONS)[number];

export function istWarteschlangenAction(action: string): action is WarteschlangenAction {
  return (WARTESCHLANGEN_ACTIONS as readonly string[]).includes(action);
}

/** Satz fuer die Tool-Beschreibung (intern-tool.ts haengt ihn an). */
export const WARTESCHLANGEN_BESCHREIBUNG =
  'WARTESCHLANGEN: warteschlange_liste (warteschlange, project, eintrag_status, eintrag_typ, limit, offset, prozess): ' +
  'ohne warteschlange Uebersicht aller Warteschlangen mit Anzahlen (API, PG, verbundene Daemons); mit Name Eintraege ' +
  '(id, projekt, typ, status, prioritaet, rang, alter_s) paginiert. Namen: code_chunks, parser, wissen_nachzug, shell_jobs, ' +
  'specialist_jobs, project_init_jobs, embedding_queue; im Daemon (prozess "daemon") index, asset, embedding_queue. ';

/** Nur NEUE Parameter (project, limit, prozess nutzt die Action mit). */
export const WARTESCHLANGEN_PARAMETER: Record<string, unknown> = {
  warteschlange: { type: 'string', description: 'warteschlange_*: Name (warteschlange_liste ohne Namen zeigt alle mit Anzahlen)' },
  eintrag_status: { type: 'string', description: 'warteschlange_liste: Filter auf den Status der Eintraege (z. B. offen, geclaimt, lease_abgelaufen, pending, running)' },
  eintrag_typ: { type: 'string', description: 'warteschlange_liste: Filter auf den Typ (z. B. Tabelle bei wissen_nachzug, Grund bei parser, Endung bei code_chunks)' },
  offset: { type: 'number', description: 'warteschlange_liste: so viele Eintraege ueberspringen (Blaettern, Standard 0)' },
};

// ───── Hilfen ───────────────────────────────────────────────────────────

function text(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function zahl(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return undefined;
}

function fehler(action: string, code: string, message: string): Record<string, unknown> {
  return { success: false, action, error: code, message };
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const alterS = (d: Date | string | null | undefined, jetzt = Date.now()): number | null =>
  d ? Math.max(0, Math.round((jetzt - new Date(d).getTime()) / 1000)) : null;

function filterAus(a: Record<string, unknown>): WarteschlangenFilter {
  const limit = zahl(a, 'limit');
  const offset = zahl(a, 'offset');
  if (limit !== undefined && !(Number.isFinite(limit) && limit >= 1)) throw new WarteschlangenFehler('parameter_ungueltig', 'limit: 1..200.');
  if (offset !== undefined && !(Number.isFinite(offset) && offset >= 0)) throw new WarteschlangenFehler('parameter_ungueltig', 'offset: Zahl >= 0.');
  return {
    project: text(a, 'project'),
    status: text(a, 'eintrag_status'),
    typ: text(a, 'eintrag_typ'),
    limit: Math.min(Math.floor(limit ?? 20), 200),
    offset: Math.floor(offset ?? 0),
  };
}

// ───── PG-Warteschlangen (nur in der API) ──────────────────────────────

interface PgWarteschlange {
  name: string;
  beschreibung: string;
  reihenfolge: string;
  verschiebbar: string;
  uebersicht: (project?: string) => Promise<Record<string, unknown>>;
  liste: (f: WarteschlangenFilter) => Promise<WarteschlangenListe>;
}

const CHUNK_STATUS_SQL = `CASE WHEN cc.lease_until IS NULL THEN 'offen'
                               WHEN cc.lease_until >= NOW() THEN 'geclaimt'
                               ELSE 'lease_abgelaufen' END`;

const CODE_CHUNKS: PgWarteschlange = {
  name: 'code_chunks',
  beschreibung: 'Code-Chunks ohne Vektor (embedded_at NULL); Server und GPU-Knoten claimen sie (embedding-claims.ts).',
  reihenfolge: 'Projekt nach embed_prioritaet-Stufe (1 zuerst, ohne Eintrag 3), innerhalb der Stufe zufaellig; im Projekt file_path, chunk_index. Geleaste Chunks werden uebersprungen.',
  verschiebbar: 'E4: Projekt ueber embed_prioritaet; einzelne Chunks/Dateien vorziehen, ans Projektende, zurueckstellen, einreihen.',
  async uebersicht(project) {
    const pool = getPool();
    const [je, knoten] = await Promise.all([
      pool.query<{ project: string; offen: number; geclaimt: number; lease_abgelaufen: number; stufe: number | null; enabled: boolean | null }>(
        `SELECT q.project, q.offen, q.geclaimt, q.lease_abgelaufen, e.stufe,
                (SELECT bool_or(p.enabled) FROM projects p WHERE p.name = q.project) AS enabled
           FROM (SELECT cc.project, count(*)::int AS offen,
                        count(*) FILTER (WHERE cc.lease_until >= NOW())::int AS geclaimt,
                        count(*) FILTER (WHERE cc.lease_until < NOW())::int AS lease_abgelaufen
                   FROM code_chunks cc
                  WHERE cc.embedded_at IS NULL AND ($1::text IS NULL OR cc.project = $1)
                  GROUP BY cc.project) q
           LEFT JOIN embed_prioritaet e ON e.project = q.project
          ORDER BY COALESCE(e.stufe, 3), q.offen DESC`,
        [project ?? null],
      ),
      pool.query<{ claimed_by: string; n: number }>(
        `SELECT claimed_by, count(*)::int AS n FROM code_chunks
          WHERE embedded_at IS NULL AND lease_until >= NOW() AND ($1::text IS NULL OR project = $1)
          GROUP BY claimed_by ORDER BY 2 DESC`,
        [project ?? null],
      ),
    ]);
    const projekte = je.rows.map((r) => ({
      projekt: r.project,
      stufe: r.stufe ?? 3,
      aktiv: r.enabled === true,
      offen: r.offen,
      geclaimt: r.geclaimt,
      lease_abgelaufen: r.lease_abgelaufen,
    }));
    return {
      anzahl: projekte.reduce((s, p) => s + p.offen, 0),
      projekte,
      claims_je_knoten: Object.fromEntries(knoten.rows.map((r) => [r.claimed_by, r.n])),
      hinweis: 'Inaktive Projekte (aktiv:false) werden nicht geclaimt. Reihenfolge innerhalb einer Stufe ist zufaellig.',
    };
  },
  async liste(f) {
    const pool = getPool();
    const werte: unknown[] = [f.project ?? null, f.status ?? null, f.typ ?? null];
    const wo = `cc.embedded_at IS NULL
          AND ($1::text IS NULL OR cc.project = $1)
          AND ($2::text IS NULL OR ${CHUNK_STATUS_SQL} = $2)
          AND ($3::text IS NULL OR cf.file_type = $3)`;
    const [gesamt, seite] = await Promise.all([
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM code_chunks cc
           ${f.typ ? 'JOIN code_files cf ON cf.project = cc.project AND cf.file_path = cc.file_path' : 'CROSS JOIN (SELECT NULL::text AS file_type) cf'}
          WHERE ${wo}`,
        werte,
      ),
      pool.query<{
        id: string; project: string; file_path: string; chunk_index: number; claimed_by: string | null;
        lease_until: Date | null; claim_attempt: number; file_type: string | null; updated_at: Date | null;
        status: string; stufe: number | null;
      }>(
        `SELECT cc.id, cc.project, cc.file_path, cc.chunk_index, cc.claimed_by, cc.lease_until, cc.claim_attempt,
                cf.file_type, cf.updated_at, ${CHUNK_STATUS_SQL} AS status,
                (SELECT e.stufe FROM embed_prioritaet e WHERE e.project = cc.project) AS stufe
           FROM code_chunks cc
           JOIN code_files cf ON cf.project = cc.project AND cf.file_path = cc.file_path
          WHERE ${wo}
          ORDER BY cc.project, cc.file_path, cc.chunk_index
          LIMIT $4 OFFSET $5`,
        [...werte, f.limit, f.offset],
      ),
    ]);
    const jetzt = Date.now();
    const eintraege: WarteschlangenEintrag[] = seite.rows.map((r) => ({
      id: String(r.id),
      projekt: r.project,
      typ: r.file_type ?? 'unbekannt',
      status: r.status,
      prioritaet: r.stufe ?? 3,
      rang: null,
      alter_s: alterS(r.updated_at, jetzt),
      details: {
        file_path: r.file_path,
        chunk_index: r.chunk_index,
        claimed_by: r.claimed_by,
        lease_until: iso(r.lease_until),
        claim_attempt: r.claim_attempt,
      },
    }));
    return {
      gesamt: gesamt.rows[0]?.n ?? 0,
      eintraege,
      sortierung: 'project, file_path, chunk_index (Projektreihenfolge der Claims: uebersicht)',
      alter_bezug: 'alter_s = seit der letzten Aenderung der Datei (code_files.updated_at)',
    };
  },
};

const PARSER: PgWarteschlange = {
  name: 'parser',
  beschreibung: 'Parse-Backlog: Projekte mit faelligen Dateien (neu, embed_offen, veraltet) fuer den Parser-Worker der API.',
  reihenfolge: 'Projekte nach embed_prioritaet-Stufe, dann groesster Rueckstand (projekteMitBacklog, bis 20 je Tick); Dateien eines Projekts parallel.',
  verschiebbar: 'E4: Projekt ueber embed_prioritaet (gemeinsam mit code_chunks). Einzelne Dateien: intern(parse_neu).',
  async uebersicht(project) {
    const projekte = await projekteMitBacklog(200);
    const gefiltert = project ? projekte.filter((p) => p.project === project) : projekte;
    return {
      anzahl: gefiltert.length,
      einheit: 'Projekte',
      projekte: gefiltert.map((p, i) => ({ projekt: p.project, rang: projekte.indexOf(p) + 1 || i + 1, faellig_mindestens: p.faellig })),
      hinweis: 'faellig_mindestens ist eine Untergrenze (Projekte nur mit Chunk-Rueckstand stehen mit 0); Dateien: warteschlange_liste(parser, project).',
    };
  },
  async liste(f) {
    if (!f.project) {
      const projekte = await projekteMitBacklog(200);
      const alle: WarteschlangenEintrag[] = projekte.map((p, i) => ({
        id: p.project, projekt: p.project, typ: 'projekt', status: 'faellig', prioritaet: null, rang: i + 1, alter_s: null,
        details: { faellig_mindestens: p.faellig },
      }));
      return { ...seiteAusListe(alle, { ...f, status: undefined, typ: undefined }), hinweis: 'Ohne project: Projekte in Abarbeitungsreihenfolge; mit project: faellige Dateien.' };
    }
    const { gesamt, dateien } = await listeFaelligeDateien(f.project, f.limit, f.offset, f.typ);
    const jetzt = Date.now();
    return {
      gesamt,
      eintraege: dateien.map((d) => ({
        id: d.file_path, projekt: f.project ?? null, typ: d.grund, status: 'faellig', prioritaet: null, rang: null,
        alter_s: alterS(d.updated_at, jetzt), details: { file_path: d.file_path, parsed_at: d.parsed_at },
      })),
      typ_bedeutung: 'neu = nie geparst, embed_offen = Chunks ohne Vektor, veraltet = aeltere Parser-Version',
    };
  },
};

const WISSEN_NACHZUG: PgWarteschlange = {
  name: 'wissen_nachzug',
  beschreibung: 'Wissens-Eintraege ohne Vektor (embedded_at NULL), Nachzug je Parser-Tick (embed-backlog.ts).',
  reihenfolge: 'Tabellen in fester Reihenfolge (skill_sections zuerst), je Tabelle der aelteste zuerst.',
  verschiebbar: 'E4: Eintrag/Tabelle sofort einbetten; hinten/zurueckstellen nicht sinnvoll (kleiner Bestand).',
  async uebersicht(project) {
    const je = await zaehleOffeneEmbeddings(project);
    return { anzahl: Object.values(je).reduce((s, n) => s + n, 0), je_tabelle: je };
  },
  async liste(f) {
    const pool = getPool();
    const je = await zaehleOffeneEmbeddings(f.project);
    const tabellen = BACKLOG_TABELLEN_INFO.filter((t) => !f.typ || t.name === f.typ);
    if (f.typ && tabellen.length === 0) {
      throw new WarteschlangenFehler('parameter_ungueltig', `eintrag_typ: ${BACKLOG_TABELLEN_INFO.map((t) => t.name).join(' | ')}.`);
    }
    const gesamt = tabellen.reduce((s, t) => s + (je[t.name] ?? 0), 0);
    const eintraege: WarteschlangenEintrag[] = [];
    let ueberspringen = f.offset;
    let rest = f.limit;
    let rangBasis = 0;
    const jetzt = Date.now();
    for (const t of tabellen) {
      const n = je[t.name] ?? 0;
      if (rest <= 0) break;
      if (ueberspringen >= n) { ueberspringen -= n; rangBasis += n; continue; }
      // Tabellen-/Spaltennamen stammen aus BACKLOG_TABELLEN_INFO (Konstante), nicht aus der Eingabe.
      const projektBed = t.mitProjekt ? '($1::text IS NULL OR project = $1)' : '$1::text IS NULL';
      const { rows } = await pool.query<{ id: string; project: string | null; zeit: Date | null }>(
        `SELECT ${t.idSpalte}::text AS id, ${t.mitProjekt ? 'project' : 'NULL::text AS project'}, ${t.sortSpalte} AS zeit
           FROM ${t.name}
          WHERE embedded_at IS NULL AND ${projektBed}
          ORDER BY ${t.sortSpalte}
          LIMIT $2 OFFSET $3`,
        [f.project ?? null, rest, ueberspringen],
      );
      rows.forEach((r, i) => eintraege.push({
        id: `${t.name}:${r.id}`, projekt: r.project, typ: t.name, status: 'offen', prioritaet: null,
        rang: rangBasis + ueberspringen + i + 1, alter_s: alterS(r.zeit, jetzt), details: { tabelle: t.name, zeit: iso(r.zeit) },
      }));
      rest -= rows.length;
      rangBasis += n;
      ueberspringen = 0;
    }
    return { gesamt, eintraege, je_tabelle: je };
  },
};

interface JobDef {
  name: string;
  tabelle: 'shell_jobs' | 'specialist_jobs' | 'project_init_jobs';
  projektSpalte: string;
  typSql: string;
  detailSql: string;
  beschreibung: string;
}

function jobWarteschlange(d: JobDef): PgWarteschlange {
  return {
    name: d.name,
    beschreibung: d.beschreibung,
    reihenfolge: 'pending: aeltester zuerst (created_at, je Projekt); running = gerade beim Daemon.',
    verschiebbar: 'Nein: der Claim folgt created_at und der Verfall pending-Jobs haengt an created_at; abbrechen ueber das jeweilige Tool.',
    async uebersicht(project) {
      const { rows } = await getPool().query<{ status: string; n: number; aeltester: Date | null }>(
        `SELECT status::text AS status, count(*)::int AS n, min(created_at) AS aeltester FROM ${d.tabelle}
          WHERE status IN ('pending', 'running') AND ($1::text IS NULL OR ${d.projektSpalte} = $1)
          GROUP BY status`,
        [project ?? null],
      );
      const je = Object.fromEntries(rows.map((r) => [r.status, r.n]));
      const aeltester = rows.map((r) => r.aeltester).filter(Boolean).sort((x, y) => +new Date(x!) - +new Date(y!))[0];
      return { anzahl: rows.reduce((s, r) => s + r.n, 0), je_status: je, aeltester_alter_s: alterS(aeltester) };
    },
    async liste(f) {
      const werte = [f.project ?? null, f.status ?? null, f.typ ?? null];
      const wo = `status IN ('pending', 'running')
          AND ($1::text IS NULL OR ${d.projektSpalte} = $1)
          AND ($2::text IS NULL OR status::text = $2)
          AND ($3::text IS NULL OR ${d.typSql} = $3)`;
      const pool = getPool();
      const [gesamt, seite] = await Promise.all([
        pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${d.tabelle} WHERE ${wo}`, werte),
        pool.query<{ id: string; projekt: string; typ: string; status: string; created_at: Date; claimed_by: string | null; claimed_at: Date | null; rang: number | null; detail: string | null }>(
          `SELECT id::text AS id, ${d.projektSpalte} AS projekt, ${d.typSql} AS typ, status::text AS status, created_at,
                  claimed_by, claimed_at, ${d.detailSql} AS detail,
                  CASE WHEN status = 'pending'
                       THEN row_number() OVER (PARTITION BY ${d.projektSpalte}, status ORDER BY created_at) END::int AS rang
             FROM ${d.tabelle}
            WHERE ${wo}
            ORDER BY (status = 'running') DESC, created_at
            LIMIT $4 OFFSET $5`,
          [...werte, f.limit, f.offset],
        ),
      ]);
      const jetzt = Date.now();
      return {
        gesamt: gesamt.rows[0]?.n ?? 0,
        eintraege: seite.rows.map((r) => ({
          id: r.id, projekt: r.projekt, typ: r.typ, status: r.status, prioritaet: null, rang: r.rang,
          alter_s: alterS(r.created_at, jetzt),
          details: { claimed_by: r.claimed_by, claimed_at: iso(r.claimed_at), detail: r.detail },
        })),
        rang_bedeutung: 'Position unter den pending-Jobs desselben Projekts',
      };
    },
  };
}

const PG_WARTESCHLANGEN: PgWarteschlange[] = [
  CODE_CHUNKS,
  PARSER,
  WISSEN_NACHZUG,
  jobWarteschlange({
    name: 'shell_jobs', tabelle: 'shell_jobs', projektSpalte: 'project', typSql: `COALESCE(agent_id, 'unbekannt')`,
    detailSql: 'left(command, 200)', beschreibung: 'shell-Auftraege an den lokalen Daemon (typ = Agent).',
  }),
  jobWarteschlange({
    name: 'specialist_jobs', tabelle: 'specialist_jobs', projektSpalte: 'project', typSql: 'action',
    detailSql: 'left(args::text, 200)', beschreibung: 'Spezialisten-Auftraege an den lokalen Daemon (typ = Action).',
  }),
  jobWarteschlange({
    name: 'project_init_jobs', tabelle: 'project_init_jobs', projektSpalte: 'name', typSql: `COALESCE(template, 'ohne')`,
    detailSql: `concat_ws(' ', 'host=' || hostname, 'von=' || requested_by)`, beschreibung: 'Projekt-Anlage durch den lokalen Daemon (typ = Vorlage).',
  }),
];

function pgWarteschlange(name: string): PgWarteschlange | undefined {
  return PG_WARTESCHLANGEN.find((w) => w.name === name);
}

// ───── Speicher-Warteschlangen jedes Prozesses ─────────────────────────

let kernAngemeldet = false;

/** embedding_queue gibt es in jedem Prozess (API und Daemon). Idempotent. */
function meldeKernWarteschlangenAn(): void {
  if (kernAngemeldet) return;
  kernAngemeldet = true;
  registriereWarteschlange({
    name: 'embedding_queue',
    beschreibung: 'Wartende Embedding-Auftraege dieses Prozesses (Slots EMBED_MAX_CONCURRENT).',
    reihenfolge: 'interaktiv vor Hintergrund, je Prioritaet FIFO; Hintergrund startet erst, wenn nichts Interaktives laeuft.',
    verschiebbar: 'Nein: Auftraege leben Sekunden; interaktive verdraengen Hintergrund ohnehin.',
    uebersicht: () => {
      const s = getEmbeddingQueueStats();
      return { anzahl: s.queued.interactive + s.queued.background, wartend: s.queued, laufend: s.active, max_gleichzeitig: s.maxConcurrent, laengste_wartezeit_ms: s.currentLongestWaitMs };
    },
    liste: (f) => seiteAusListe(embeddingWarteschlangeEintraege().map((e) => ({
      id: String(e.position), projekt: null, typ: e.prioritaet, status: 'wartend', prioritaet: e.prioritaet,
      rang: e.position, alter_s: Math.round(e.wartet_ms / 1000), details: { wartet_ms: e.wartet_ms },
    })), f),
  });
}

// ───── Dispatcher ──────────────────────────────────────────────────────

/** Uebersicht oder Liste im eigenen Prozess. prozessName 'api' schliesst die PG-Warteschlangen ein. */
export async function fuehreWarteschlangeLokal(
  action: string,
  a: Record<string, unknown>,
  prozessName = 'api',
): Promise<Record<string, unknown>> {
  meldeKernWarteschlangenAn();
  const mitPg = prozessName === 'api';
  if (action !== 'warteschlange_liste') return fehler(action, 'unbekannte_action', `Unbekannte action "${action}".`);
  const name = text(a, 'warteschlange');
  const f = filterAus(a);
  if (!name) {
    const uebersicht: Record<string, unknown> = {};
    const reihen: Array<Promise<void>> = [];
    if (mitPg) {
      for (const w of PG_WARTESCHLANGEN) {
        reihen.push(imHintergrund(() => w.uebersicht(f.project))
          .then((u) => { uebersicht[w.name] = { ort: 'pg', ...u }; })
          .catch((err) => { uebersicht[w.name] = { ort: 'pg', fehler: (err as Error).message }; }));
      }
    }
    for (const n of warteschlangenNamen()) {
      const w = holeWarteschlange(n)!;
      reihen.push(Promise.resolve().then(() => w.uebersicht())
        .then((u) => { uebersicht[n] = { ort: prozessName, ...u }; })
        .catch((err) => { uebersicht[n] = { ort: prozessName, fehler: (err as Error).message }; }));
    }
    await Promise.all(reihen);
    return {
      success: true,
      action,
      prozess: prozessName,
      ...(f.project ? { project: f.project } : {}),
      warteschlangen: Object.fromEntries(Object.keys(uebersicht).sort().map((k) => [k, uebersicht[k]])),
      hinweis: 'Eintraege: warteschlange_liste(warteschlange, project?, eintrag_status?, eintrag_typ?, limit, offset).',
    };
  }
  const pg = mitPg ? pgWarteschlange(name) : undefined;
  const sp = holeWarteschlange(name);
  if (!pg && !sp) {
    const bekannt = [...(mitPg ? PG_WARTESCHLANGEN.map((w) => w.name) : []), ...warteschlangenNamen()];
    return fehler(action, 'unbekannte_warteschlange', `Unbekannt in ${prozessName}: ${name}. Bekannt: ${bekannt.join(', ')}.${mitPg ? ' Daemon-Warteschlangen (index, asset): prozess "daemon".' : ''}`);
  }
  const def = (pg ?? sp)!;
  const liste = pg ? await imHintergrund(() => pg.liste(f)) : await sp!.liste(f);
  return {
    success: true,
    action,
    prozess: prozessName,
    warteschlange: name,
    beschreibung: def.beschreibung,
    reihenfolge: def.reihenfolge,
    verschiebbar: def.verschiebbar,
    filter: { project: f.project ?? null, eintrag_status: f.status ?? null, eintrag_typ: f.typ ?? null },
    limit: f.limit,
    offset: f.offset,
    ...liste,
    weitere: liste.gesamt !== null ? Math.max(0, liste.gesamt - f.offset - liste.eintraege.length) : null,
  };
}

/** Dispatcher fuer intern-tool.ts. Wirft nie. */
export async function fuehreWarteschlangeAus(
  action: string,
  a: Record<string, unknown>,
  _agentId?: string,
): Promise<Record<string, unknown>> {
  try {
    const prozess = text(a, 'prozess') ?? 'api';
    if (prozess === 'api') {
      const erg = await fuehreWarteschlangeLokal(action, a, 'api');
      // Uebersicht: verbundene Daemons best effort mit anhaengen (kurzer Timeout, Fehler nur vermerken).
      if (erg.success === true && !text(a, 'warteschlange')) {
        const daemons: Record<string, unknown> = {};
        await Promise.all(daemonUebersicht().filter((d) => d.verbunden).map(async (d) => {
          try {
            const { ergebnis } = await sendeAnDaemon(action, { project: text(a, 'project') }, d.host, 3_000);
            daemons[`daemon:${d.host}`] = ergebnis.success === false ? { fehler: ergebnis.error, message: ergebnis.message } : ergebnis.warteschlangen;
          } catch (err) {
            daemons[`daemon:${d.host}`] = { fehler: (err as Error).message };
          }
        }));
        if (Object.keys(daemons).length > 0) erg.daemons = daemons;
      }
      return erg;
    }
    if (prozess !== 'daemon' && !prozess.startsWith('daemon:')) {
      return fehler(action, 'parameter_ungueltig', 'prozess: api | daemon | daemon:<host>.');
    }
    filterAus(a); // Parameter vor dem Versand pruefen
    const host = prozess.startsWith('daemon:') ? prozess.slice('daemon:'.length) : undefined;
    const weiter: Record<string, unknown> = {};
    for (const k of ['warteschlange', 'project', 'eintrag_status', 'eintrag_typ', 'limit', 'offset']) {
      if (a[k] !== undefined) weiter[k] = a[k];
    }
    const { host: ziel, ergebnis } = await sendeAnDaemon(action, weiter, host);
    return { ...ergebnis, action, prozess: `daemon:${ziel}`, host: ziel };
  } catch (err) {
    if (err instanceof WarteschlangenFehler || err instanceof DaemonBrueckeFehler) return fehler(action, err.code, err.message);
    return fehler(action, 'interner_fehler', err instanceof Error ? err.message : String(err));
  }
}
