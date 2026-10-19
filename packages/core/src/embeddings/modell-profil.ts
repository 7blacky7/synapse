/**
 * MODUL: Embedding-Modellprofil (P12-T4, P12-T6, P15-T8)
 * ZWECK: Alles, was am Embedding-Modell haengt und nicht aus dem Modell selbst kommt, an EINER
 *        Stelle: Praefixe, Kennung des Vektorraums, Stueckgroesse/num_ctx und Score-Schwellen.
 *
 * 1. PRAEFIXE (T4): Moderne Embedding-Modelle sind darauf trainiert, dass eine SUCHANFRAGE
 *    anders eingeleitet wird als ein gespeichertes DOKUMENT. Gemessen (Projekt
 *    embedding-vergleich, 09.10.2026): qwen3-embedding:8b Stichwortsuche MRR 69.1 ohne vs. 86.7
 *    mit Instruct-Praefix; Nemotron/Gemma verlieren ohne Praefix 5-7 Punkte.
 *
 * 2. KENNUNG (T6): Welches Modell einen Vektor erzeugt hat, wandert an jeden Qdrant-Punkt
 *    (Payload embedding_modell) und in embedding_collections.
 *
 * 3. MODELLPROFILE IN POSTGRESQL (P15-T8, User-Vorgabe 11.10.2026: "Kalibrierungen je Modell
 *    getrennt und zentral, ausserhalb der Funktionen; ist Modell X aktiv, gelten automatisch die
 *    Werte von X"). Tabelle embedding_modell_profile (db/schema.ts), Schluessel Modellname + Digest.
 *    Bis dahin standen die Praefixe als PROFILE-Liste hier im Code und die Score-Schwellen als
 *    Zahlen in graph.ts (0.55), error-patterns.ts (0.65), global-search (0.5) ... - alle auf der
 *    qwen-Skala. Nach dem Wechsel auf Nemotron filterten sie still fast alles weg.
 *
 * ⚠️ KEIN ERSATZWERT IM CODE (Regel regel-keine-festverdrahteten-modellwerte): fehlt das Profil
 *    oder ein Feld darin, gibt es ModellNichtKalibriertError (code modell_nicht_kalibriert) bzw.
 *    das Feature liefert keine gefilterten Treffer und sagt das. NULL in der Tabelle heisst
 *    "nicht kalibriert", '' bei einem Praefix heisst "bewusst ohne Praefix".
 *
 * UEBERSTEUERN (Env, Betreiber-Konfiguration - hat Vorrang vor dem Profil):
 *   EMBEDDING_PRAEFIXE=aus           schaltet beide Praefixe ab
 *   EMBEDDING_QUERY_PREFIX=...       Suchanfrage-Praefix (\n wird als Zeilenumbruch gelesen)
 *   EMBEDDING_DOC_PREFIX=...         Dokument-Praefix
 *   SCORE_SCHWELLE_<ZWECK>=0.4       Score-Schwelle eines Zwecks (z. B. SCORE_SCHWELLE_GRAPH_CODE)
 * Rechenknoten (SYNAPSE_COMPUTE_NODE=1) lesen KEIN PostgreSQL - sie bekommen Praefixe und
 * Stueckgroesse ueber den Referenzvertrag der API als Env (compute-node-agent uebernehmeReferenz).
 */
import { getConfig } from '../config.js';
import { getPool } from '../db/client.js';
import { ollamaModellInfo } from './ollama-modell-info.js';

/** query = Suchanfrage (search*, Hooks, Duplikat-/Pattern-Abgleich); dokument = gespeicherter Inhalt. */
export type EmbedArt = 'query' | 'dokument';

interface Praefixe {
  query: string;
  dokument: string;
}

/**
 * Zwecke der Score-Schwellen (Schluessel in score_schwellen). Jede Schwelle gilt nur fuer die
 * Score-Skala EINES Modells - deshalb stehen sie im Profil und nicht hier.
 */
export const SCORE_ZWECKE = {
  tasks: 'Dublettenhinweis vor dem Anlegen einer Task (Titel + Beschreibung)',
  plans: 'Kalibrierung der semantischen Plansuche (Name + Beschreibung + Ziele)',
  hook: 'Skill-Vorschlaege der Claude-Code-Hooks (skill-suggest*.sh ueber skills search)',
  channel_skill: 'Serverseitige Skill-Vorschlaege aus Channel/Memory/Thought/Task-Texten (skill-hook.ts)',
  channel_skill_abstand: 'Mindestabstand Platz 1 zu Platz 2 bei channel_skill, sonst mehrdeutig (Score-Differenz)',
  graph_code: 'Web-UI Graph, Datei-Details: semantisch aehnliche Dateien (routes/graph.ts)',
  graph_wissen: 'Web-UI Graph: Memories/Thoughts als Nachbarn (routes/graph.ts)',
  error_patterns: 'Warnung vor bekannten Fehlermustern beim Schreiben (error-patterns.ts)',
  global_search: 'Globale Suche ueber alle Projekte (global-search.ts, /api/search/global)',
  tech_docs_gut: 'Ab diesem Score gilt ein Tech-Doc-Treffer als gut, sonst Context7-Nachladen (tech-docs.ts)',
  code_semantic_fallback: 'code_intel search: semantischer Rueckfall bei 0 Volltext-Treffern (mcp-server)',
} as const;
export type ScoreZweck = keyof typeof SCORE_ZWECKE;

/** Altnamen der Env, die vor P15-T8 schon galten - bleiben als Uebersteuerung gueltig. */
const ALTE_SCHWELLEN_ENV: Partial<Record<ScoreZweck, string>> = {
  channel_skill: 'CHANNEL_SKILL_MIN_SCORE',
  hook: 'SKILL_HOOK_MIN_SCORE',
};

export interface ModellProfil {
  modell: string;
  /** '' = gilt fuer jeden Digest des Modells, sonst Anfang des sha256 (mind. 12 Zeichen) */
  digest: string;
  queryPraefix: string | null;
  dokPraefix: string | null;
  /** Kontrollwert: die wirksame Zieldimension kommt aus zielDimension() (EMBEDDING_TARGET_DIM) */
  zielDimension: number | null;
  numCtx: number | null;
  numBatch: number | null;
  maxStueckZeichen: number | null;
  scoreSchwellen: Record<string, number>;
  kalibriertAm: string | null;
  kalibriertVon: string | null;
  notiz: string | null;
  messwerte: unknown;
  aktualisiertAm: string | null;
}

/** Modell nicht (vollstaendig) kalibriert - es gibt bewusst keinen Ersatzwert. */
export class ModellNichtKalibriertError extends Error {
  readonly code = 'modell_nicht_kalibriert';

  constructor(readonly modell: string, readonly feld: string, readonly grund: string) {
    super(
      `modell_nicht_kalibriert: Embedding-Modell "${modell}" hat keinen Wert fuer ${feld} (${grund}). ` +
        'Profil pflegen: intern(action:"modellprofil") zeigt den Stand, intern(action:"modellprofil_setzen") setzt Werte.',
    );
    this.name = 'ModellNichtKalibriertError';
  }
}

function envText(name: string): string | undefined {
  const wert = process.env[name];
  return wert === undefined ? undefined : wert.replace(/\\n/g, '\n');
}

function positiveZahl(wert: unknown): number | null {
  const n = Number(wert);
  return wert !== null && wert !== undefined && wert !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Name des Text-Embedding-Modells, so wie der Provider es anspricht. Ohne Konfiguration: Fehler. */
export function embeddingModellName(): string {
  const cfg = getConfig().embeddings;
  const name = cfg.provider === 'ollama' ? process.env.OLLAMA_MODEL || cfg.ollama.model : cfg.model;
  if (!name) {
    throw new Error(
      `Kein Embedding-Modell konfiguriert (Provider ${cfg.provider}): ` +
        (cfg.provider === 'ollama' ? 'OLLAMA_MODEL' : 'EMBEDDING_MODEL') + ' setzen. Es gibt keinen Standardnamen im Code.',
    );
  }
  return name;
}

// ───── Profil aus PostgreSQL ────────────────────────────────────────────

interface ProfilStand {
  modell: string;
  digest: string | null;
  profil: ModellProfil | null;
  /** warum kein Profil gilt (kein_profil, digest_unbekannt, pg_fehler ...); null = Profil da */
  grund: string | null;
  bis: number;
}

let stand: ProfilStand | null = null;
let laedt: Promise<ProfilStand> | null = null;

function ttlMs(): number {
  const n = Number(process.env.SYNAPSE_MODELLPROFIL_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** Ohne Tag meint Ollama :latest - beide Schreibweisen finden dasselbe Profil. */
function namensFormen(modell: string): string[] {
  return modell.includes(':') ? [modell, modell.replace(/:latest$/, '')] : [modell, `${modell}:latest`];
}

function normalDigest(wert: string | null | undefined): string {
  return (wert ?? '').trim().toLowerCase().replace(/^sha256:/, '');
}

interface ProfilZeile {
  modell: string; digest: string; query_praefix: string | null; dok_praefix: string | null;
  ziel_dimension: number | null; num_ctx: number | null; num_batch: number | null; max_stueck_zeichen: number | null;
  score_schwellen: Record<string, unknown> | null; kalibriert_am: Date | null; kalibriert_von: string | null;
  notiz: string | null; messwerte: unknown; aktualisiert_am: Date | null;
}

function zuProfil(z: ProfilZeile): ModellProfil {
  const schwellen: Record<string, number> = {};
  for (const [zweck, wert] of Object.entries(z.score_schwellen ?? {})) {
    const n = Number(wert);
    if (wert !== null && Number.isFinite(n)) schwellen[zweck] = n;
  }
  return {
    modell: z.modell,
    digest: z.digest,
    queryPraefix: z.query_praefix,
    dokPraefix: z.dok_praefix,
    zielDimension: positiveZahl(z.ziel_dimension),
    numCtx: positiveZahl(z.num_ctx),
    numBatch: positiveZahl(z.num_batch),
    maxStueckZeichen: positiveZahl(z.max_stueck_zeichen),
    scoreSchwellen: schwellen,
    kalibriertAm: z.kalibriert_am ? new Date(z.kalibriert_am).toISOString() : null,
    kalibriertVon: z.kalibriert_von,
    notiz: z.notiz,
    messwerte: z.messwerte ?? null,
    aktualisiertAm: z.aktualisiert_am ? new Date(z.aktualisiert_am).toISOString() : null,
  };
}

export const PROFIL_SPALTEN =
  'modell, digest, query_praefix, dok_praefix, ziel_dimension, num_ctx, num_batch, max_stueck_zeichen, ' +
  'score_schwellen, kalibriert_am, kalibriert_von, notiz, messwerte, aktualisiert_am';

/** Digest des aktiven Modells: SYNAPSE_OLLAMA_MODEL_DIGEST, sonst Ollama /api/tags; sonst null. */
async function aktiverDigest(): Promise<string | null> {
  const env = normalDigest(process.env.SYNAPSE_OLLAMA_MODEL_DIGEST);
  if (env) return env;
  if (getConfig().embeddings.provider !== 'ollama') return null;
  try {
    return (await ollamaModellInfo()).digest;
  } catch {
    return null;
  }
}

async function ladeStand(): Promise<ProfilStand> {
  const modell = embeddingModellName();
  const bis = Date.now() + ttlMs();
  if (process.env.SYNAPSE_COMPUTE_NODE === '1') {
    return { modell, digest: null, profil: null, grund: 'rechenknoten_ohne_db (Werte kommen als Env aus dem Referenzvertrag)', bis };
  }
  let zeilen: ProfilZeile[];
  try {
    const { rows } = await getPool().query<ProfilZeile>(
      `SELECT ${PROFIL_SPALTEN} FROM embedding_modell_profile WHERE modell = ANY($1::text[])`,
      [namensFormen(modell)],
    );
    zeilen = rows;
  } catch (err) {
    // PG kurz weg: ein schon geladenes Profil weiter benutzen statt mitten im Betrieb alles abzuschalten.
    if (stand && stand.modell === modell && stand.profil) return { ...stand, bis };
    return { modell, digest: null, profil: null, grund: `pg_fehler: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), bis };
  }
  if (zeilen.length === 0) return { modell, digest: null, profil: null, grund: 'kein_profil', bis };
  // Digest nur ermitteln, wenn ein Profil ihn braucht (spart Ollama-Anfragen).
  const digest = zeilen.some((z) => z.digest !== '') ? await aktiverDigest() : null;
  const passend = zeilen
    .filter((z) => z.digest === '' || (digest !== null && digest.startsWith(normalDigest(z.digest))))
    .sort((a, b) => b.digest.length - a.digest.length);
  if (passend.length > 0) return { modell, digest, profil: zuProfil(passend[0]), grund: null, bis };
  // Ollama kurz nicht erreichbar (Digest unbekannt): das zuletzt passende Profil desselben Modells
  // weiter benutzen, statt fuer ein Cache-Intervall alles mit modell_nicht_kalibriert abzulehnen.
  if (digest === null && stand && stand.modell === modell && stand.profil) return { ...stand, bis };
  return {
    modell,
    digest,
    profil: null,
    grund: digest === null ? 'digest_unbekannt (Profil nur fuer bestimmte Digests, aktiver Digest nicht ermittelbar)' : `digest_passt_nicht (aktiv ${digest.slice(0, 12)})`,
    bis,
  };
}

async function aktuellerStand(neu = false): Promise<ProfilStand> {
  if (!neu && stand && stand.bis > Date.now() && stand.modell === embeddingModellName()) return stand;
  laedt ??= ladeStand()
    .then((s) => { stand = s; return s; })
    .finally(() => { laedt = null; });
  return laedt;
}

/** Profil des aktiven Modells (je Prozess gecacht, SYNAPSE_MODELLPROFIL_TTL_MS, Standard 60 s); null = keins. */
export async function aktivesModellprofil(optionen: { neu?: boolean } = {}): Promise<ModellProfil | null> {
  return (await aktuellerStand(optionen.neu)).profil;
}

/** Stand mit Begruendung - fuer intern(modellprofil) und Fehlermeldungen. */
export async function modellprofilStand(optionen: { neu?: boolean } = {}): Promise<Omit<ProfilStand, 'bis'>> {
  const { bis: _bis, ...rest } = await aktuellerStand(optionen.neu);
  return rest;
}

/** Laedt das Profil, falls noch nicht geschehen. Vor jedem synchronen Zugriff (aktivePraefixe, Kennung) aufrufen. */
export async function sichereModellprofil(): Promise<void> {
  await aktuellerStand();
}

/** Zuletzt geladenes Profil ohne I/O (null = keins oder noch nicht geladen). */
export function geladenesModellprofil(): ModellProfil | null {
  return stand?.profil ?? null;
}

/** Nach intern(modellprofil_setzen) und in Tests: naechster Zugriff liest neu. */
export function vergissModellprofil(): void {
  stand = null;
}

// ───── Praefixe ────────────────────────────────────────────────────────

/**
 * Praefixe fuer das aktive Modell. Reihenfolge je Feld: Env -> Profil -> Fehler.
 * Synchron (wird in jedem embed() gebraucht) - das Profil muss vorher geladen sein
 * (sichereModellprofil(); embed()/embedBatch() tun das selbst).
 */
export function aktivePraefixe(): Praefixe {
  if ((process.env.EMBEDDING_PRAEFIXE || '').toLowerCase() === 'aus') return { query: '', dokument: '' };
  const envQuery = envText('EMBEDDING_QUERY_PREFIX');
  const envDok = envText('EMBEDDING_DOC_PREFIX');
  if (envQuery !== undefined && envDok !== undefined) return { query: envQuery, dokument: envDok };
  const s = stand;
  if (!s) throw new ModellNichtKalibriertError(embeddingModellName(), 'praefixe', 'Profil noch nicht geladen (sichereModellprofil fehlt)');
  const query = envQuery ?? s.profil?.queryPraefix ?? null;
  const dokument = envDok ?? s.profil?.dokPraefix ?? null;
  if (query === null) throw new ModellNichtKalibriertError(s.modell, 'query_praefix', s.grund ?? 'Feld im Profil leer');
  if (dokument === null) throw new ModellNichtKalibriertError(s.modell, 'dok_praefix', s.grund ?? 'Feld im Profil leer');
  return { query, dokument };
}

/** Setzt den passenden Praefix vor den Text. Ohne Angabe gilt 'dokument' (sicherer Standard: Schreibwege). */
export function mitPraefix(text: string, art: EmbedArt = 'dokument'): string {
  const p = aktivePraefixe();
  const praefix = art === 'query' ? p.query : p.dokument;
  return praefix ? praefix + text : text;
}

/**
 * Kennung des Vektorraums: Provider, Modell, Zieldimension und Dokument-Praefix-Variante.
 * Zwei Vektoren sind nur vergleichbar, wenn ihre Kennungen gleich sind. Der Digest steht mit
 * drin, wenn er konfiguriert ist (Referenzvertrag SYNAPSE_OLLAMA_MODEL_DIGEST) - ein neu
 * quantisiertes Modell unter gleichem Namen ist ein anderer Vektorraum.
 * Braucht die Praefixe -> vorher sichereModellprofil().
 */
export function embeddingModellKennung(): string {
  const cfg = getConfig().embeddings;
  const digest = normalDigest(process.env.SYNAPSE_OLLAMA_MODEL_DIGEST);
  const ziel = Number(process.env.EMBEDDING_TARGET_DIM) || 0;
  const dokPraefix = aktivePraefixe().dokument ? 'dokpraefix' : 'ohne-dokpraefix';
  return [
    `${cfg.provider}:${embeddingModellName()}`,
    digest ? `digest:${digest.slice(0, 12)}` : null,
    ziel ? `dim:${ziel}` : 'dim:nativ',
    dokPraefix,
  ].filter(Boolean).join('|');
}

// ───── Score-Schwellen ─────────────────────────────────────────────────

function schwelleAusEnv(zweck: ScoreZweck): number | null {
  for (const name of [`SCORE_SCHWELLE_${zweck.toUpperCase()}`, ALTE_SCHWELLEN_ENV[zweck]]) {
    if (!name) continue;
    const roh = process.env[name];
    const n = Number(roh);
    if (roh !== undefined && roh.trim() !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/** Score-Schwelle eines Zwecks fuer das aktive Modell: Env -> Profil -> ModellNichtKalibriertError. */
export async function scoreSchwelle(zweck: ScoreZweck): Promise<number> {
  const env = schwelleAusEnv(zweck);
  if (env !== null) return env;
  const s = await aktuellerStand();
  const wert = s.profil?.scoreSchwellen[zweck];
  if (typeof wert === 'number') return wert;
  throw new ModellNichtKalibriertError(
    s.modell,
    `score_schwellen.${zweck}`,
    s.profil ? 'Zweck im Profil nicht gesetzt' : (s.grund ?? 'kein Profil'),
  );
}

/**
 * Wie scoreSchwelle, wirft aber nicht: schwelle null + hinweis, wenn das Modell fuer den Zweck nicht
 * kalibriert ist. Fuer Features, die dann keine gefilterten Treffer liefern und das melden.
 */
export async function scoreSchwelleOderHinweis(zweck: ScoreZweck): Promise<{ schwelle: number | null; hinweis?: string }> {
  try {
    return { schwelle: await scoreSchwelle(zweck) };
  } catch (err) {
    if (err instanceof ModellNichtKalibriertError) return { schwelle: null, hinweis: err.message };
    throw err;
  }
}

/**
 * P23-T6 (Diagnose intern skill_probe): wirksame Schwelle wie scoreSchwelle MIT Quelle - 'env:<NAME>',
 * 'modellprofil:<modell>' oder 'nicht_kalibriert' (dann schwelle null + hinweis). Gleiche Reihenfolge wie scoreSchwelle.
 */
export async function scoreSchwelleMitQuelle(zweck: ScoreZweck): Promise<{ schwelle: number | null; quelle: string; hinweis?: string }> {
  for (const name of [`SCORE_SCHWELLE_${zweck.toUpperCase()}`, ALTE_SCHWELLEN_ENV[zweck]]) {
    if (!name) continue;
    const roh = process.env[name];
    const n = Number(roh);
    if (roh !== undefined && roh.trim() !== '' && Number.isFinite(n)) return { schwelle: n, quelle: `env:${name}` };
  }
  const r = await scoreSchwelleOderHinweis(zweck);
  if (r.schwelle === null) return { schwelle: null, quelle: 'nicht_kalibriert', hinweis: r.hinweis };
  const s = await aktuellerStand();
  return { schwelle: r.schwelle, quelle: `modellprofil:${s.modell}` };
}
