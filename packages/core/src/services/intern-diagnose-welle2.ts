/**
 * MODUL: Intern-Diagnose, Welle 2 (P15-T16)
 * ZWECK: Weitere Diagnose-Actions des intern-Tools. Eingehaengt ueber intern-diagnose.ts (Dispatcher,
 *        DIAGNOSE_ACTIONS, DIAGNOSE_PARAMETER) - intern-tool.ts bleibt unberuehrt.
 *
 * ACTIONS
 *   vektorraum_pruefen  Stichprobe aus Qdrant gegen frisch eingebetteten PG-Text (aktives Modell): Kosinus-Band,
 *                       fremde Vektoren je Monat / Herkunft (92009f99, 6cb6443b: Fehler blieb stumm)
 *   claims              Code-Embedding-Claims je Knoten (aktiv, abgelaufen, Versuche), Zieldimension gegen die
 *                       Code-Collections der Projekte mit Rueckstand (ea0c2d70)
 *   ereignisse          offene Events ohne ACK; mit ziel_agent: Server-Sicht (getPendingEvents) gegen die
 *                       gemeinsame Event-Sichtbarkeit (529ff248)
 *   pipeline_trace      eine Datei durch alle Stufen: Datei/Hash, Parse, Chunks/Claims, Qdrant-Punkte
 *                       (erwartet vs vorhanden). ausfuehren:true = parseAndEmbed + Vorher/Nachher (16e5472a)
 *   parser_messen       Datei ueber den ECHTEN Pool-Pfad parsen (nicht parser.parse im Hauptthread, f82b86a7):
 *                       Dauer, Limit, Ergebnis, Pool-Zaehler und Threads vorher/nachher. Standard Vorschau.
 *
 * SCHREIBEN: nur pipeline_trace mit ausfuehren:true (parseAndEmbed wie parse_neu). vektorraum_pruefen ruft das
 *   Embedding-Modell (Stichprobe, hoechstens 50 Texte), schreibt aber nichts. parser_messen schreibt nichts,
 *   belegt aber einen Pool-Slot.
 * ANTWORT: Objekte mit befund[]; Parameterfehler wirft DiagnoseFehler (der Dispatcher faengt).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { getPool, imHintergrund } from '../db/client.js';
import { getQdrantClient } from '../qdrant/client.js';
import { getCollectionVectorSize } from '../qdrant/collections.js';
import { scrollePunktIds } from '../qdrant/operations.js';
import { COLLECTIONS } from '../types/index.js';
import { embedBatch, embeddingModellKennung, zielDimension } from '../embeddings/index.js';
import { deterministicChunkPointId } from './embedding-chunk-id.js';
import { getPendingEvents } from './events.js';
import { HOOK_EVENTS_SQL, hookEventsParameter } from './event-sichtbarkeit.js';
import { parseAndEmbed } from './code.js';
import { getParserPool, getParserPoolZustand } from '../parser/worker-pool.js';
import { memoryNachzug } from './memory.js';
import { thoughtNachzug } from './thoughts.js';
import { proposalNachzug } from './proposals.js';
import { planNachzug } from './plans.js';
import { errorPatternNachzug } from './error-patterns.js';
import { techDocNachzug } from './tech-docs.js';
import type { NachzugQuelle } from './embed-nachzug.js';
import { taskNachzug } from './plan-suche.js';
import { DiagnoseFehler, tabelleDa } from './intern-diagnose-code.js';

const rund = (x: number, s = 4) => Math.round(x * 10 ** s) / 10 ** s;

function threadZahl(): number | null {
  try {
    return existsSync('/proc/self/task') ? readdirSync('/proc/self/task').length : null;
  } catch {
    return null;
  }
}

// ───── vektorraum_pruefen ──────────────────────────────────────────────

/** Arten mit Wissens-Quelle (Text exakt wie im Schreibweg: NachzugQuelle.lese). Skills: eigene Qdrant, numerische IDs. */
const WISSEN: Record<string, { quelle: () => NachzugQuelle; projekt: boolean }> = {
  memories: { quelle: () => memoryNachzug, projekt: true },
  thoughts: { quelle: () => thoughtNachzug, projekt: true },
  proposals: { quelle: () => proposalNachzug, projekt: true },
  plans: { quelle: () => planNachzug, projekt: true },
  tasks: { quelle: () => taskNachzug, projekt: true },
  error_patterns: { quelle: () => errorPatternNachzug, projekt: false },
  tech_docs: { quelle: () => techDocNachzug, projekt: true },
};
export const VEKTORRAUM_ARTEN = ['code', ...Object.keys(WISSEN)];

interface Probe {
  id: string;
  collection: string;
  text: string;
  embedded_at: Date | null;
  herkunft: string | null;
}

function kosinus(a: number[], b: number[]): number {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? s / Math.sqrt(na * nb) : 0;
}

function alsVektor(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (v && typeof v === 'object') {
    const erster = Object.values(v as Record<string, unknown>)[0];
    return Array.isArray(erster) ? (erster as number[]) : null;
  }
  return null;
}

async function zieheProbenCode(project: string, n: number): Promise<Probe[]> {
  const { rows } = await getPool().query<{ project: string; file_path: string; chunk_index: number; content: string; embedded_at: Date; claimed_by: string | null }>(
    `SELECT project, file_path, chunk_index, content, embedded_at, claimed_by FROM code_chunks
      WHERE project = $1 AND embedded_at IS NOT NULL ORDER BY random() LIMIT $2`, [project, n]);
  return rows.map((r) => ({
    id: deterministicChunkPointId(r.project, r.file_path, r.chunk_index, r.content),
    collection: COLLECTIONS.projectCode(r.project),
    text: r.content,
    embedded_at: r.embedded_at,
    herkunft: r.claimed_by ?? '(ohne Claim)',
  }));
}

async function zieheProbenWissen(art: string, project: string | undefined, n: number): Promise<Probe[]> {
  const w = WISSEN[art];
  const q = w.quelle();
  const projektFilter = w.projekt && project ? ' AND project = $2' : '';
  const { rows } = await getPool().query<{ id: string; embedded_at: Date }>(
    `SELECT ${q.idSpalte}::text AS id, embedded_at FROM ${q.tabelle}
      WHERE embedded_at IS NOT NULL${projektFilter} ORDER BY random() LIMIT $1`,
    projektFilter ? [n, project] : [n]);
  if (rows.length === 0) return [];
  const zeit = new Map(rows.map((r) => [r.id, r.embedded_at]));
  const punkte = await q.lese(rows.map((r) => r.id));
  return punkte.map((p) => ({ id: art === 'tasks' ? String(p.payload.task_id) : p.id, collection: p.collection, text: p.text, embedded_at: zeit.get(p.id) ?? null, herkunft: null }));
}

export async function vektorraumPruefen(opt: { art: string; project?: string; stichprobe: number; schwelle: number }): Promise<Record<string, unknown>> {
  if (!VEKTORRAUM_ARTEN.includes(opt.art)) throw new DiagnoseFehler('parameter_ungueltig', `art: ${VEKTORRAUM_ARTEN.join(' | ')} (skills: eigene Qdrant mit numerischen IDs, nicht unterstuetzt).`);
  if (opt.art === 'code' && !opt.project) throw new DiagnoseFehler('parameter_fehlt', 'vektorraum_pruefen art code braucht project.');
  const proben = await imHintergrund(() => opt.art === 'code'
    ? zieheProbenCode(opt.project as string, opt.stichprobe)
    : zieheProbenWissen(opt.art, opt.project, opt.stichprobe));
  if (proben.length === 0) {
    return { art: opt.art, project: opt.project ?? null, stichprobe: 0, befund: ['Keine eingebetteten Zeilen fuer diese Auswahl - nichts zu pruefen.'] };
  }

  // Gespeicherte Vektoren je Collection holen
  const client = getQdrantClient();
  const gespeichert = new Map<string, number[]>();
  const jeCollection = new Map<string, string[]>();
  for (const p of proben) jeCollection.set(p.collection, [...(jeCollection.get(p.collection) ?? []), p.id]);
  const collectionDim: Record<string, number | null> = {};
  for (const [collection, ids] of jeCollection) {
    collectionDim[collection] = await getCollectionVectorSize(collection);
    try {
      const punkte = await client.retrieve(collection, { ids, with_vector: true, with_payload: false });
      for (const pt of punkte) {
        const v = alsVektor(pt.vector);
        if (v) gespeichert.set(`${collection}|${String(pt.id).toLowerCase()}`, v);
      }
    } catch { /* Collection fehlt -> alle Proben "kein Punkt" */ }
  }

  // Frisch einbetten (aktives Modell, Dokument-Praefix wie im Schreibweg)
  const neu = await embedBatch(proben.map((p) => p.text), { priority: 'interactive' });
  const ziel = await zielDimension().catch(() => null);

  const ergebnis = proben.map((p, i) => {
    const alt = gespeichert.get(`${p.collection}|${p.id.toLowerCase()}`) ?? null;
    const frisch = neu[i];
    let cos: number | null = null;
    let befund: string | null = null;
    if (!alt) befund = 'kein Punkt in Qdrant';
    else if (alt.length !== frisch.length) befund = `Dimension ${alt.length} statt ${frisch.length}`;
    else {
      cos = rund(kosinus(alt, frisch));
      if (cos < opt.schwelle) befund = `fremd (Kosinus ${cos} < ${opt.schwelle})`;
    }
    return {
      id: p.id, collection: p.collection, embedded_at: p.embedded_at, herkunft: p.herkunft,
      kosinus: cos, dim_qdrant: alt?.length ?? null, dim_neu: frisch.length, befund,
    };
  });

  const werte = ergebnis.map((e) => e.kosinus).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const fremd = ergebnis.filter((e) => e.befund !== null);
  const gruppe = (schluessel: (e: typeof ergebnis[number]) => string) => {
    const g: Record<string, { n: number; fremd: number }> = {};
    for (const e of ergebnis) {
      const k = schluessel(e);
      const s = (g[k] ??= { n: 0, fremd: 0 });
      s.n++;
      if (e.befund) s.fremd++;
    }
    return g;
  };
  const jeMonat = gruppe((e) => (e.embedded_at ? new Date(e.embedded_at).toISOString().slice(0, 7) : '(ohne)'));
  const jeHerkunft = opt.art === 'code' ? gruppe((e) => e.herkunft ?? '(ohne)') : undefined;

  const befund: string[] = [];
  if (fremd.length === 0) {
    befund.push(`Vektorraum einheitlich: alle ${ergebnis.length} Stichproben mit dem aktiven Modell reproduzierbar (Kosinus min ${werte[0]}).`);
  } else {
    befund.push(`VEKTORRAUM-BRUCH: ${fremd.length} von ${ergebnis.length} Stichproben passen nicht zum aktiven Modell (${embeddingModellKennung()}). Suche liefert dafuer stumm schlechte Scores - neu einbetten (intern neu_einbetten) oder Herkunft pruefen.`);
    const monate = Object.entries(jeMonat).filter(([, s]) => s.fremd > 0).map(([m, s]) => `${m}: ${s.fremd}/${s.n}`);
    if (monate.length > 0) befund.push(`Fremd je Monat (embedded_at): ${monate.join(', ')}.`);
    if (jeHerkunft) {
      const h = Object.entries(jeHerkunft).filter(([, s]) => s.fremd > 0).map(([k, s]) => `${k}: ${s.fremd}/${s.n}`);
      if (h.length > 0) befund.push(`Fremd je Knoten (claimed_by): ${h.join(', ')}.`);
    }
  }
  for (const [c, d] of Object.entries(collectionDim)) {
    if (d !== null && ziel !== null && d !== ziel) befund.push(`Collection ${c} hat ${d}d, Zieldimension ist ${ziel}d.`);
  }
  return {
    art: opt.art,
    project: opt.project ?? null,
    modell: embeddingModellKennung(),
    ziel_dimension: ziel,
    schwelle: opt.schwelle,
    stichprobe: ergebnis.length,
    kosinus: werte.length > 0 ? { min: werte[0], median: werte[Math.floor(werte.length / 2)], max: werte[werte.length - 1] } : null,
    fremd: fremd.length,
    je_monat: jeMonat,
    ...(jeHerkunft ? { je_herkunft: jeHerkunft } : {}),
    collection_dimension: collectionDim,
    proben: ergebnis,
    befund,
    hinweis: 'Gleicher Text + gleiches Modell + gleicher Praefix ergibt Kosinus ~1 (GPU-Rundung bis ~0.999). Deutlich darunter: Vektor stammt von einem anderen Modell/Praefix/Kontext. Text wie im Schreibweg (Code: Chunk-Inhalt, Wissen: NachzugQuelle.lese).',
  };
}

// ───── claims ──────────────────────────────────────────────────────────

export async function claimsStatus(opt: { project?: string; limit: number }): Promise<Record<string, unknown>> {
  const pool = getPool();
  const p = opt.project ?? null;
  const [jeKnoten, versuche, jeProjekt] = await Promise.all([
    pool.query<{ knoten: string; aktiv: number; abgelaufen: number; naechster_ablauf: Date | null; letzter_ablauf: Date | null; max_versuch: number }>(
      `SELECT claimed_by AS knoten,
              count(*) FILTER (WHERE lease_until >= NOW())::int AS aktiv,
              count(*) FILTER (WHERE lease_until < NOW())::int AS abgelaufen,
              min(lease_until) FILTER (WHERE lease_until >= NOW()) AS naechster_ablauf,
              max(lease_until) FILTER (WHERE lease_until >= NOW()) AS letzter_ablauf,
              max(claim_attempt)::int AS max_versuch
         FROM code_chunks
        WHERE embedded_at IS NULL AND claimed_by IS NOT NULL AND ($1::text IS NULL OR project = $1)
        GROUP BY 1 ORDER BY aktiv DESC`, [p]),
    pool.query<{ versuch: number; n: number }>(
      `SELECT LEAST(claim_attempt, 5)::int AS versuch, count(*)::int AS n FROM code_chunks
        WHERE embedded_at IS NULL AND ($1::text IS NULL OR project = $1) GROUP BY 1 ORDER BY 1`, [p]),
    pool.query<{ project: string; offen: number }>(
      `SELECT project, count(*)::int AS offen FROM code_chunks
        WHERE embedded_at IS NULL AND ($1::text IS NULL OR project = $1)
        GROUP BY 1 ORDER BY offen DESC LIMIT $2`, [p, opt.limit]),
  ]);
  const abgelaufenBeispiele = (await pool.query(
    `SELECT id, project, file_path, chunk_index, claimed_by, claim_attempt, lease_until,
            EXTRACT(EPOCH FROM (NOW() - lease_until))::int AS abgelaufen_vor_s
       FROM code_chunks WHERE embedded_at IS NULL AND lease_until < NOW() AND ($1::text IS NULL OR project = $1)
      ORDER BY lease_until LIMIT 5`, [p])).rows;

  let ziel: number | null = null;
  let zielFehler: string | null = null;
  try { ziel = await zielDimension(); } catch (err) { zielFehler = (err as Error).message; }
  const dimension = [];
  for (const r of jeProjekt.rows) {
    const collection = COLLECTIONS.projectCode(r.project);
    const d = await getCollectionVectorSize(collection);
    dimension.push({ project: r.project, offen: r.offen, collection, dimension: d, passt: d === null ? null : d === ziel });
  }

  const befund: string[] = [];
  if (zielFehler) befund.push(`Zieldimension nicht bestimmbar (${zielFehler}) - Abschluesse pruefen den Vektor gegen zielDimension().`);
  for (const d of dimension) {
    if (d.dimension !== null && ziel !== null && d.dimension !== ziel) {
      befund.push(`Projekt ${d.project}: Collection ${d.collection} hat ${d.dimension}d, Zieldimension ${ziel}d - Abschluesse (${d.offen} offen) schreiben in eine Collection falscher Groesse und scheitern.`);
    }
  }
  for (const k of jeKnoten.rows) {
    if (k.abgelaufen > 0) befund.push(`Knoten ${k.knoten}: ${k.abgelaufen} Claim(s) abgelaufen ohne Abschluss (werden neu vergeben; haeuft es sich, bricht der Knoten ab).`);
  }
  const oft = versuche.rows.filter((v) => v.versuch >= 3).reduce((s, v) => s + v.n, 0);
  if (oft > 0) befund.push(`${oft} offene Chunks mit claim_attempt >= 3 - scheitern wiederholt.`);
  if (befund.length === 0) befund.push('Claims unauffaellig.');
  return {
    project: p,
    ziel_dimension: ziel,
    je_knoten: jeKnoten.rows,
    versuche: versuche.rows,
    abgelaufen_beispiele: abgelaufenBeispiele,
    dimension,
    befund,
    hinweis: 'Ein Claim = code_chunks.claimed_by + lease_until (embedded_at NULL). aktiv: lease_until >= jetzt. versuche: claim_attempt (5 = 5 und mehr). dimension: Code-Collections der Projekte mit dem groessten Rueckstand gegen zielDimension().',
  };
}

// ───── ereignisse ──────────────────────────────────────────────────────

// P15-T26: Die Hook-Sicht kommt aus derselben Quelle wie der Hook selbst (event-sichtbarkeit.ts,
// HOOK_EVENTS_SQL) - hier stand vorher eine eigene, veraltete Kopie ohne Sitzungs- und PLAN_READY-Filter.

export async function ereignisse(opt: { project?: string; zielAgent?: string; stunden: number; limit: number }): Promise<Record<string, unknown>> {
  const pool = getPool();
  const p = opt.project ?? null;
  const { rows } = await pool.query(
    `SELECT e.id, e.project, e.event_type, e.priority, e.scope, e.source_id, left(e.payload, 160) AS payload, e.created_at,
            EXTRACT(EPOCH FROM (NOW() - e.created_at))::int AS alter_s,
            (SELECT count(*)::int FROM agent_event_acks k WHERE k.event_id = e.id) AS acks,
            CASE WHEN e.scope LIKE 'agent:%' THEN EXISTS (SELECT 1 FROM agent_event_acks k WHERE k.event_id = e.id AND k.agent_id = substr(e.scope, 7)) END AS ziel_quittiert,
            (SELECT count(*)::int FROM wrapper_status ws
              WHERE ws.project = e.project AND ws.status <> 'stopped' AND e.scope = 'all'
                AND NOT EXISTS (SELECT 1 FROM agent_event_acks k WHERE k.event_id = e.id AND k.agent_id = ws.agent_name)) AS wrapper_ohne_ack
       FROM agent_events e
      WHERE e.requires_ack AND e.created_at > NOW() - make_interval(hours => $2::int) AND ($1::text IS NULL OR e.project = $1)
      ORDER BY e.created_at DESC LIMIT $3`, [p, opt.stunden, opt.limit]);
  const offen = rows.filter((r) => (r.scope.startsWith('agent:') ? !r.ziel_quittiert : r.wrapper_ohne_ack > 0));
  const befund: string[] = [];
  const direkt = rows.filter((r) => r.scope.startsWith('agent:') && !r.ziel_quittiert && r.alter_s > 600);
  if (direkt.length > 0) befund.push(`${direkt.length} direkt adressierte(s) Event(s) seit > 10 min ohne ACK: ${direkt.slice(0, 5).map((r) => `${r.id} ${r.event_type} an ${r.scope.slice(6)}`).join(', ')}.`);

  let agent: Record<string, unknown> | undefined;
  if (opt.zielAgent) {
    if (!p) throw new DiagnoseFehler('parameter_fehlt', 'ereignisse mit ziel_agent braucht project.');
    // P15-T30: registered_at = erstmals; Events zaehlen ab aktiv_seit (Lebensphase), Fehlermuster ab sitzung_seit.
    const reg = (await pool.query<{ registered_at: Date; sitzung_seit: Date | null; aktiv_seit: Date | null; status: string | null }>(
      'SELECT registered_at, sitzung_seit, aktiv_seit, status FROM agent_sessions WHERE id = $1', [opt.zielAgent])).rows[0] ?? null;
    const server = await getPendingEvents(p, opt.zielAgent, 100);
    // P15-T26: Der interne Sichtvergleich nutzt die zentrale Eventsichtbarkeit aus event-sichtbarkeit.ts.
    // HOOK_EVENTS_SQL haelt den frueheren Filter fuer den Diagnosevergleich fest.
    const hook = (await pool.query(HOOK_EVENTS_SQL, hookEventsParameter(p, opt.zielAgent, 100))).rows;
    const serverIds = new Set(server.map((e) => Number(e.id)));
    const hookIds = new Set(hook.map((e) => Number(e.id)));
    const nurHook = hook.filter((e) => !serverIds.has(Number(e.id)));
    // requires_ack = false zeigt nur der Server (bewusster Filterunterschied), das ist keine Abweichung
    const nurServer = server.filter((e) => e.requiresAck && !hookIds.has(Number(e.id)));
    agent = {
      agent: opt.zielAgent,
      registriert_am: reg?.registered_at ?? null,
      sitzung_seit: reg ? (reg.sitzung_seit ?? reg.registered_at) : null,
      events_sichtbar_ab: reg ? (reg.aktiv_seit ?? reg.registered_at) : null,
      status: reg?.status ?? null,
      server_offen: server.map((e) => ({ id: e.id, typ: e.eventType, scope: e.scope, created_at: e.createdAt })),
      hook_offen: hook.length,
      hook_ids: hook.map((e) => Number(e.id)),
      nur_im_hook: nurHook,
      nur_beim_server: nurServer.map((e) => ({ id: e.id, typ: e.eventType, scope: e.scope, created_at: e.createdAt })),
    };
    if (nurHook.length > 0 || nurServer.length > 0) {
      befund.push(`${opt.zielAgent}: Event-Sicht-SQL und Server (getPendingEvents) weichen ab - nur in der Zusatzsicht ${nurHook.length}, nur im Server ${nurServer.length} (ACK-pflichtige). Beide nutzen eventsOffenBedingungSql (event-sichtbarkeit.ts); eine Abweichung weist auf unterschiedliche Code-Staende hin.`);
    }
  }
  if (befund.length === 0) befund.push('Keine auffaelligen offenen Events.');
  return {
    project: p,
    stunden: opt.stunden,
    gesamt: rows.length,
    offen: offen.length,
    events: offen,
    ...(agent ? { agent_sicht: agent } : {}),
    befund,
    hinweis: 'offen: direkt adressiert (scope agent:<id>) ohne ACK des Ziels, oder scope all mit laufenden Wrappern ohne ACK. agent_sicht vergleicht getPendingEvents (Server) mit der internen Zusatzsicht (event-sichtbarkeit.ts HOOK_EVENTS_SQL); die Auswahl folgt der Event-Prioritaet.',
  };
}

// ───── pipeline_trace ──────────────────────────────────────────────────

async function stufen(project: string, filePath: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const f = (await pool.query(
    `SELECT file_type, file_size, content, content_hash, updated_at, indexed_at, parsed_at, parser_version, deleted_at,
            (SELECT count(*)::int FROM code_symbols s WHERE s.project = cf.project AND s.file_path = cf.file_path) AS symbole
       FROM code_files cf WHERE project = $1 AND file_path = $2`, [project, filePath])).rows[0];
  if (!f) return { gefunden: false };
  const hash = f.content === null ? null : createHash('sha256').update(f.content, 'utf8').digest('hex');
  const ausfall = (await tabelleDa('parse_failures'))
    ? (await pool.query('SELECT grund, left(details, 200) AS details, aufgetreten_am FROM parse_failures WHERE project = $1 AND file_path = $2', [project, filePath])).rows[0] ?? null
    : null;
  const chunks = (await pool.query<{ id: string; chunk_index: number; content: string; embedded_at: Date | null; claimed_by: string | null; lease_until: Date | null; claim_attempt: number }>(
    `SELECT id::text, chunk_index, content, embedded_at, claimed_by, lease_until, claim_attempt FROM code_chunks
      WHERE project = $1 AND file_path = $2 ORDER BY chunk_index`, [project, filePath])).rows;
  const jetzt = Date.now();
  const erwartet = new Map<string, number>();
  for (const c of chunks) if (c.embedded_at) erwartet.set(deterministicChunkPointId(project, filePath, c.chunk_index, c.content).toLowerCase(), c.chunk_index);
  const collection = COLLECTIONS.projectCode(project);
  let punkte: string[] | null = null;
  let qdrantFehler: string | null = null;
  try {
    punkte = (await scrollePunktIds(collection, { must: [{ key: 'project', match: { value: project } }, { key: 'file_path', match: { value: filePath } }] }, 1000))
      .map((x) => String(x).toLowerCase());
  } catch (err) { qdrantFehler = (err as Error).message; }
  const vorhanden = new Set(punkte ?? []);
  const fehlend = [...erwartet.entries()].filter(([id]) => !vorhanden.has(id)).map(([, idx]) => idx);
  const verwaist = (punkte ?? []).filter((id) => !erwartet.has(id));
  return {
    gefunden: true,
    datei: {
      file_type: f.file_type, file_size: f.file_size, ohne_inhalt: f.content === null,
      content_hash: f.content_hash, hash_aus_inhalt: hash, hash_passt: hash === null ? null : hash === f.content_hash,
      updated_at: f.updated_at, indexed_at: f.indexed_at, parsed_at: f.parsed_at, parser_version: f.parser_version, deleted_at: f.deleted_at,
    },
    parse: { symbole: f.symbole, parse_ausfall: ausfall },
    chunks: {
      anzahl: chunks.length,
      eingebettet: chunks.filter((c) => c.embedded_at).length,
      offen: chunks.filter((c) => !c.embedded_at).length,
      geclaimt: chunks.filter((c) => !c.embedded_at && c.lease_until && new Date(c.lease_until).getTime() >= jetzt).length,
      lease_abgelaufen: chunks.filter((c) => !c.embedded_at && c.lease_until && new Date(c.lease_until).getTime() < jetzt).length,
      max_versuch: chunks.reduce((m, c) => Math.max(m, c.claim_attempt ?? 0), 0),
      knoten: [...new Set(chunks.map((c) => c.claimed_by).filter(Boolean))],
      ids: chunks.map((c) => c.id),
    },
    qdrant: {
      collection,
      punkte: punkte?.length ?? null,
      erwartet: erwartet.size,
      fehlend: fehlend.length,
      fehlend_chunk_index: fehlend.slice(0, 20),
      verwaist: verwaist.length,
      verwaist_beispiele: verwaist.slice(0, 10),
      fehler: qdrantFehler,
    },
  };
}

function stufenBefund(s: Record<string, unknown>): string[] {
  const b: string[] = [];
  if (!s.gefunden) return ['Datei steht nicht in code_files.'];
  const d = s.datei as Record<string, unknown>;
  const pa = s.parse as Record<string, unknown>;
  const c = s.chunks as Record<string, number>;
  const q = s.qdrant as Record<string, unknown>;
  if (d.ohne_inhalt) b.push('Stufe Datei: kein Inhalt in PG - Parser und Chunker haben nichts.');
  if (d.hash_passt === false) b.push('Stufe Datei: content_hash passt nicht zum Inhalt - Aenderungserkennung vergleicht falsch.');
  if (d.deleted_at) b.push('Stufe Datei: als geloescht markiert.');
  if (!d.parsed_at) b.push('Stufe Parse: nie geparst (parsed_at NULL).');
  if (pa.parse_ausfall) b.push(`Stufe Parse: Ausfall vermerkt (${(pa.parse_ausfall as Record<string, unknown>).grund}).`);
  if (d.parsed_at && Number(pa.symbole) === 0) b.push('Stufe Parse: geparst, aber 0 Symbole.');
  if (c.anzahl === 0) b.push('Stufe Chunks: keine Chunks - Embedding hat nichts zu tun.');
  if (c.offen > 0) b.push(`Stufe Embedding: ${c.offen} Chunk(s) offen (${c.geclaimt} geclaimt, ${c.lease_abgelaufen} mit abgelaufenem Lease, max claim_attempt ${c.max_versuch}).`);
  if (q.fehler) b.push(`Stufe Qdrant: Abfrage fehlgeschlagen (${q.fehler}).`);
  if (Number(q.fehlend) > 0) b.push(`Stufe Qdrant: ${q.fehlend} eingebettete(r) Chunk(s) ohne Punkt (embedded_at gesetzt, Vektor fehlt - still verloren).`);
  if (Number(q.verwaist) > 0) b.push(`Stufe Qdrant: ${q.verwaist} Punkt(e) ohne passenden Chunk (Altstand frueherer Dateiversion).`);
  if (b.length === 0) b.push('Alle Stufen stimmig.');
  return b;
}

export async function pipelineTrace(opt: { project: string; filePath: string; ausfuehren: boolean; mitEmbeddings: boolean }): Promise<Record<string, unknown>> {
  const vorher = await imHintergrund(() => stufen(opt.project, opt.filePath));
  if (!opt.ausfuehren || !vorher.gefunden) {
    return {
      modus: 'vorschau',
      project: opt.project, file_path: opt.filePath,
      stufen: vorher,
      befund: stufenBefund(vorher),
      hinweis: `Nur gelesen. ausfuehren:true: parseAndEmbed mit erzwingeParse, ${opt.mitEmbeddings ? 'MIT' : 'ohne'} Neu-Chunken (mit_embeddings), danach dieselben Stufen erneut mit Vorher/Nachher.`,
    };
  }
  const aktiv = (await getPool().query<{ aktiv: boolean }>('SELECT bool_or(enabled) AS aktiv FROM projects WHERE name = $1', [opt.project])).rows[0]?.aktiv === true;
  if (!aktiv) throw new DiagnoseFehler('projekt_inaktiv', `Projekt ${opt.project} ist nicht registriert oder deaktiviert.`);
  const t0 = Date.now();
  let fehler: string | null = null;
  try {
    await imHintergrund(() => parseAndEmbed(opt.project, opt.filePath, { erzwingeParse: true, ohneEmbeddings: !opt.mitEmbeddings }));
  } catch (err) {
    fehler = err instanceof Error ? err.message : String(err);
  }
  const dauer = Date.now() - t0;
  const nachher = await imHintergrund(() => stufen(opt.project, opt.filePath));
  const idsV = new Set(((vorher.chunks as Record<string, unknown>)?.ids as string[]) ?? []);
  const idsN = new Set(((nachher.chunks as Record<string, unknown>)?.ids as string[]) ?? []);
  const sym = (s: Record<string, unknown>) => Number((s.parse as Record<string, unknown> | undefined)?.symbole ?? 0);
  const pts = (s: Record<string, unknown>) => (s.qdrant as Record<string, unknown> | undefined)?.punkte ?? null;
  return {
    modus: 'ausgefuehrt',
    project: opt.project, file_path: opt.filePath,
    dauer_ms: dauer,
    fehler,
    delta: {
      symbole: { vorher: sym(vorher), nachher: sym(nachher) },
      chunks: { vorher: idsV.size, nachher: idsN.size, behalten: [...idsN].filter((x) => idsV.has(x)).length, neu: [...idsN].filter((x) => !idsV.has(x)).length, entfernt: [...idsV].filter((x) => !idsN.has(x)).length },
      qdrant_punkte: { vorher: pts(vorher), nachher: pts(nachher) },
      parsed_at: { vorher: (vorher.datei as Record<string, unknown>).parsed_at, nachher: (nachher.datei as Record<string, unknown> | undefined)?.parsed_at ?? null },
    },
    vorher,
    nachher,
    befund: [...(fehler ? [`parseAndEmbed: ${fehler}`] : []), ...stufenBefund(nachher)],
    hinweis: 'Embedding der Chunks laeuft danach ueber Claims (GPU-Knoten / Server-Loop), nicht in diesem Aufruf - offen nachher ist normal; erneut pipeline_trace ohne ausfuehren zeigt den Fortschritt.',
  };
}

// ───── parser_messen ───────────────────────────────────────────────────

function poolZaehler(): Record<string, unknown> | null {
  const z = getParserPoolZustand() as Record<string, unknown> | null;
  if (!z) return null;
  const slots = (z.slots as Array<Record<string, unknown>>) ?? [];
  return {
    groesse: z.groesse, timeouts_gesamt: z.timeouts_gesamt, beendet_gesamt: z.beendet_gesamt,
    beendet_exit_ausstehend: z.beendet_exit_ausstehend, warteschlange: z.warteschlange,
    stillgelegt: slots.filter((s) => s.stillgelegt === true).length, belegt: slots.filter((s) => s.busy === true).length,
  };
}

export async function parserMessen(opt: { project: string; filePath: string; ausfuehren: boolean }): Promise<Record<string, unknown>> {
  const f = (await getPool().query<{ file_type: string; content: string | null; file_size: number }>(
    'SELECT file_type, content, file_size FROM code_files WHERE project = $1 AND file_path = $2', [opt.project, opt.filePath])).rows[0];
  if (!f) throw new DiagnoseFehler('nicht_gefunden', `${opt.project}/${opt.filePath} steht nicht in code_files.`);
  if (f.content === null) throw new DiagnoseFehler('ohne_inhalt', `${opt.filePath}: kein Inhalt in PG.`);
  const basis = {
    project: opt.project, file_path: opt.filePath, file_type: f.file_type, zeichen: f.content.length,
    parser_timeout_env: process.env.PARSER_TIMEOUT_MS ?? null,
  };
  const pool = getParserPool();
  if (!pool) {
    return { modus: opt.ausfuehren ? 'ausgefuehrt' : 'vorschau', ...basis, pool: null, befund: ['Pool deaktiviert (PARSER_WORKER_THREADS=0): Parse liefe im Hauptthread ohne Reissleine - hier nicht gemessen.'] };
  }
  const vorher = poolZaehler();
  if (!opt.ausfuehren) {
    return {
      modus: 'vorschau', ...basis, pool: vorher, threads: threadZahl(),
      befund: [`Nur Vorschau. ausfuehren:true parst ${opt.filePath} einmal ueber den Pool (belegt einen Slot, schreibt nichts).`],
    };
  }
  const threadsVorher = threadZahl();
  const t0 = Date.now();
  const lauf = pool.parse({ filePath: opt.filePath, fileType: f.file_type, content: f.content });
  // Direkt nach dem Dispatch steht die Datei im Slot - Limit ablesen (kein Slot frei: Auftrag wartet in der Queue)
  const slot = ((getParserPoolZustand() as Record<string, unknown> | null)?.slots as Array<Record<string, unknown>> | undefined)
    ?.find((s) => s.laufende_datei === opt.filePath) ?? null;
  let ergebnis: Record<string, number> | null = null;
  let fehler: { name: string; message: string } | null = null;
  try {
    const r = await lauf;
    ergebnis = r ? {
      symbole: r.symbols.length, referenzen: r.references.length,
      statements: r.statements?.length ?? 0, call_kanten: r.callEdges?.length ?? 0,
    } : null;
  } catch (err) {
    fehler = { name: (err as Error).name ?? 'Error', message: (err as Error).message ?? String(err) };
  }
  const dauer = Date.now() - t0;
  // exit eines beendeten Workers kommt asynchron - kurz warten, damit nachher stimmt
  if (fehler) await new Promise((r) => setTimeout(r, 500));
  const nachher = poolZaehler();
  const befund: string[] = [];
  if (fehler?.name === 'ParseTimeoutError') befund.push(`TIMEOUT nach ${dauer} ms (Limit ${slot?.limit_ms ?? '?'} ms): Worker beendet - diese Datei bringt den Parser zum Haengen (Regex-Backtracking?).`);
  else if (fehler) befund.push(`Parse-Fehler: ${fehler.name}: ${fehler.message}`);
  else if (ergebnis === null) befund.push(`Kein Parser fuer file_type ${f.file_type} (Ergebnis null).`);
  else befund.push(`OK in ${dauer} ms: ${ergebnis.symbole} Symbole, ${ergebnis.referenzen} Referenzen.`);
  if (!slot) befund.push('Kein freier Slot beim Start - Messung enthaelt Wartezeit in der Queue.');
  const tv = Number(vorher?.timeouts_gesamt ?? 0);
  const tn = Number(nachher?.timeouts_gesamt ?? 0);
  return {
    modus: 'ausgefuehrt', ...basis,
    dauer_ms: dauer,
    limit_ms: slot?.limit_ms ?? null,
    slot: slot?.slot ?? null,
    ergebnis,
    fehler,
    pool_vorher: vorher,
    pool_nachher: nachher,
    timeouts_neu: tn - tv,
    threads: { vorher: threadsVorher, nachher: threadZahl() },
    befund,
    hinweis: 'Gemessen ueber getParserPool().parse wie im Indexer (Worker-Thread mit Zeitlimit), nicht parser.parse im Hauptthread. Pool und Threads gelten fuer DIESEN Prozess (API).',
  };
}
