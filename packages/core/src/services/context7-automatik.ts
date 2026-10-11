/**
 * MODUL: Context7-Automatik
 * ZWECK: Holt Framework-Docs fuer die in Projekten erkannten Bibliotheken automatisch von Context7
 *        und cached sie GLOBAL (tech_docs, project NULL) — sparsam, weil Context7 im Free-Tier laeuft.
 *        (P12-T17, User-Vorgaben 11.10.2026)
 *
 * ABLAUF (ein Lauf alle SYNAPSE_CONTEXT7_INTERVALL_MIN, angestossen aus dem Parser-Worker der API):
 *   1. Bestand uebernehmen (einmal je Prozess): jede Bibliothek, die schon Context7-Zeilen in
 *      tech_docs hat, kommt OHNE Abruf ins Register (status 'bestand', abgerufen_am = aeltestes
 *      indexed_at, naechster_check = jetzt + Intervall). Was da ist, wird nicht neu geholt.
 *   2. Erkennung aus PG, nicht vom Dateisystem: je Projekt ein Fingerabdruck aus den Manifesten
 *      (code_files: package.json, requirements.txt, ...) und der Zahl der Import-Symbole
 *      (code_symbols). Nur wenn er sich geaendert hat, laeuft die Erkennung
 *      (detectTechnologiesAusInhalten, nur bekannte Pakete). Bibliotheken (framework/library, KEINE
 *      Sprachen/Tools, KEINE reinen devDependency-Bibliotheken = confidence 'low'), die im Register
 *      fehlen, kommen in die Warteschlange. Projekt B laedt nichts, was Projekt A schon hat.
 *   3. Faellige Update-Checks (naechster_check <= jetzt) kommen ebenfalls in die Warteschlange —
 *      nur in Kontingent-Stufe 'voll'.
 *      Status 'nur_suche' (nur vom Such-Auto-Fetch geholt, ~5 Snippets) gilt als NEU: der
 *      Gesamtabruf folgt, danach 'abgerufen'.
 *      REIHENFOLGE: neue vor Update-Checks; dann Framework vor Bibliothek, Manifest vor reinem
 *      Import, in mehreren Projekten benutzt vor Einzelfall.
 *   4. Hoechstens SYNAPSE_CONTEXT7_MAX_JE_TICK Bibliotheken je Lauf, Pause zwischen den Bibliotheken:
 *      - NAMENS-RANGFOLGE (Pflicht, Context7Client.waehleBibliothek/bewerteNamen): exakt (title oder
 *        letzter id-Teil = Name) vor Titel-Wort ("Flask Documentation"; nie Flask-Login, React Router),
 *        sonst 'nicht_gefunden', kein Docs-Abruf. Je Stufe trustScore, dann totalSnippets.
 *      - NEU: 1x /v2/libs/search + 1x Gesamtabruf /v1/<id>?tokens=N&type=txt (User-Entscheidung
 *        11.10.2026: immer das Maximum — Context7 zaehlt Aufrufe, nicht Tokens; Messwert
 *        tokens=10000 -> ~91 Snippets, tokens=30000 -> 361, /v2/context liefert nur ~5). Lehnt Context7
 *        den tokens-Wert mit 4xx ab (nicht 429/Quota), genau EIN Wiederholversuch mit dem in der
 *        Meldung genannten Maximum bzw. 50000; der funktionierende Wert wird in
 *        context7_automatik_stand.tokens_max gemerkt und kuenftig benutzt.
 *        SYNAPSE_CONTEXT7_TOKENS=0 -> altes Verhalten: eine allgemeine /v2/context-Abfrage.
 *      - BESTAND ohne library_id: der erste Check speichert NUR die Zuordnung, und nur bei Stufe
 *        'exakt'. Kein Abruf.
 *      - UPDATE-CHECK: 1x /v2/libs/search. Nur wenn lastUpdateDate neuer ist als der eigene Stand
 *        (quelle_stand bzw. abgerufen_am), derselbe EINE Abruf wie bei NEU dazu. Alte Chunks
 *        werden NIE automatisch geloescht (Dedupe per content_hash in speichereContext7Chunks —
 *        unveraenderte Snippets kommen also nicht doppelt, nur geaenderte/neue kommen dazu).
 *   5. Speichern NUR ueber speichereContext7Chunks (tech-docs.ts, PG-first, global, Embedding
 *      im Hintergrund).
 *
 * KONTINGENT: zaehlt der Context7-Client bei JEDEM Aufruf (context7-kontingent.ts: Monatsbudget,
 *   Stufen, Tagesgrenze, Pause nach 429). Die Automatik ruft mit Aufrufart 'neu' bzw. 'update',
 *   laeuft nur in den Stufen 'voll' und 'nur_neue' und beendet ihren Lauf, sobald das Kontingent
 *   einen Aufruf ablehnt (Eintrag bleibt in der Warteschlange). Sonstige Fehler je Bibliothek: nur
 *   geloggt + im Register (letzter_fehler), neuer Versuch nach SYNAPSE_CONTEXT7_FEHLER_PAUSE_H.
 *
 * ENV (alle optional; Budget/Stufen/Tagesgrenze siehe context7-kontingent.ts):
 *   SYNAPSE_CONTEXT7_AUTO=0              schaltet die Automatik ab (Default: an)
 *   SYNAPSE_CONTEXT7_INTERVALL_MIN=10    Abstand der Laeufe in Minuten
 *   SYNAPSE_CONTEXT7_MAX_JE_TICK=2       Bibliotheken je Lauf
 *   SYNAPSE_CONTEXT7_PAUSE_MS=5000       Pause zwischen zwei Context7-Aufrufen
 *   SYNAPSE_CONTEXT7_CHECK_TAGE=30       Abstand der Update-Checks je Bibliothek
 *   SYNAPSE_CONTEXT7_FEHLER_PAUSE_H=24   Wartezeit nach sonstigem Fehler je Bibliothek
 *   SYNAPSE_CONTEXT7_TOKENS=100000       Umfang des Gesamtabrufs; 0 = nur /v2/context (~5 Snippets)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: liest code_files/code_symbols/projects/tech_docs, schreibt context7_bibliotheken
 *     (und tokens_max in context7_automatik_stand); Docs ueber speichereContext7Chunks nach tech_docs
 *   - Netzwerk: Context7 (siehe oben, gedrosselt)
 *   - Registriert beim Init den Context7-Abfrage-Beobachter von tech-docs.ts (Queries aus dem
 *     Such-Auto-Fetch landen im Register, nur zur Information)
 *
 * ABHAENGIGKEITEN:
 *   - ../db/client.js, ./context7.js, ./context7-kontingent.js, ./tech-detection.js, ./tech-docs.js (intern)
 */

import { getPool, imHintergrund } from '../db/client.js';
import { schalterHaeltAn } from './intern-schalter.js';
import { getContext7Client, Context7Fehler, type Context7Bibliothek, type Context7Doc } from './context7.js';
import { context7Kontingent, type Context7Aufrufart } from './context7-kontingent.js';
import {
  detectTechnologiesAusInhalten,
  ERKENNUNGS_DATEINAMEN,
  type DetectedTechnology,
} from './tech-detection.js';
import { speichereContext7Chunks, setzeContext7AbfrageBeobachter } from './tech-docs.js';

interface Konfig {
  aktiv: boolean;
  intervallMs: number;
  maxJeTick: number;
  pauseMs: number;
  checkTage: number;
  fehlerPauseH: number;
  gesamtTokens: number;
}

function envZahl(name: string, ersatz: number): number {
  const roh = process.env[name];
  if (roh === undefined || roh.trim() === '') return ersatz;
  const wert = Number(roh);
  return Number.isFinite(wert) && wert >= 0 ? wert : ersatz;
}

/** Bei jedem Lauf neu gelesen, damit eine geaenderte Env ohne Codeaenderung greift. */
function konfig(): Konfig {
  return {
    aktiv: process.env.SYNAPSE_CONTEXT7_AUTO !== '0',
    intervallMs: envZahl('SYNAPSE_CONTEXT7_INTERVALL_MIN', 10) * 60_000,
    maxJeTick: Math.max(1, Math.floor(envZahl('SYNAPSE_CONTEXT7_MAX_JE_TICK', 2))),
    pauseMs: envZahl('SYNAPSE_CONTEXT7_PAUSE_MS', 5_000),
    checkTage: envZahl('SYNAPSE_CONTEXT7_CHECK_TAGE', 30),
    fehlerPauseH: envZahl('SYNAPSE_CONTEXT7_FEHLER_PAUSE_H', 24),
    gesamtTokens: Math.floor(envZahl('SYNAPSE_CONTEXT7_TOKENS', 100_000)),
  };
}

/** Registerzeile (context7_bibliotheken). */
interface RegisterZeile {
  framework: string;
  anzeige_name: string | null;
  status: 'bestand' | 'abgerufen' | 'nur_suche' | 'nicht_gefunden' | 'fehler';
  library_id: string | null;
  quelle_stand: Date | null;
  abgerufen_am: Date | null;
  naechster_check: Date | null;
}

/** Warum ein Lauf vorzeitig endet: Kontingent lehnt ab bzw. Context7 meldet 429/Quota. */
type Abbruch = 'kontingent' | 'pause';

const ALLGEMEINE_ABFRAGE = (name: string): string => `${name} getting started core concepts`;
/** So steht der Gesamtabruf in der abfragen-Liste des Registers. */
const GESAMT_ABFRAGE = '(gesamtabruf)';
/** Rueckfallwert, wenn Context7 den tokens-Wert ablehnt und kein Maximum nennt. */
const TOKENS_RUECKFALL = 50_000;
const MAX_ABFRAGEN_JE_BIBLIOTHEK = 50;

// Prioritaet der Warteschlange (hoeher zuerst): neu > Update-Check, Framework > Bibliothek,
// Manifest > reiner Import, dazu +1 je Projekt, das die Bibliothek benutzt.
const PRIO_NEU = 100_000;
const PRIO_FRAMEWORK = 10_000;
const PRIO_MANIFEST = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Prozesszustand ──────────────────────────────────────────────────────────
let laeuft = false;
let letzterLauf = 0;
let bestandUebernommen = false;
/** Zuletzt geloggter Ruhegrund (Pause/Stufe) — damit er nicht bei jedem Lauf erneut im Log steht. */
let ruheGemeldet: string | null = null;
/** Fingerabdruck je Projekt — nur bei Aenderung laeuft die Erkennung. Leer nach Neustart = einmal alles. */
const fingerabdruecke = new Map<string, string>();
/** Eintrag der Warteschlange; prio entscheidet die Reihenfolge (hoeher zuerst). */
interface Vormerkung { name: string; prio: number }
/** Bibliotheken, die abgerufen bzw. geprueft werden sollen (Schluessel = framework klein). */
const warteschlange = new Map<string, Vormerkung>();

/**
 * Initialisiert die Automatik (einmal, aus dem Parser-Worker der API). Registriert den
 * Beobachter fuer Context7-Abfragen aus der Suche und loggt Einstellungen + Kontingent. Der
 * eigentliche Lauf kommt ueber context7AutomatikTick().
 */
export function initContext7Automatik(): void {
  const k = konfig();
  setzeContext7AbfrageBeobachter((framework, query) => merkeContext7Abfrage(framework, query));
  console.error(
    k.aktiv
      ? `[context7-auto] aktiv (alle ${k.intervallMs / 60_000} min, max ${k.maxJeTick} je Lauf, Update-Check alle ${k.checkTage} Tage, ${k.gesamtTokens > 0 ? `Gesamtabruf tokens=${k.gesamtTokens}` : 'nur /v2/context'})`
      : '[context7-auto] AUS (SYNAPSE_CONTEXT7_AUTO=0)',
  );
  void context7Kontingent()
    .then((s) => console.error(
      `[context7-kontingent] Monat ab ${s.monat}: ${s.verbraucht}/${s.budget} Aufrufe (Rest ${s.rest_prozent} %), Stufe ${s.stufe}, heute ${s.heute}/${s.tagesgrenze}${s.pause_bis && s.pause_bis.getTime() > Date.now() ? `, PAUSE bis ${s.pause_bis.toISOString()}` : ''}`,
    ))
    .catch((err: unknown) => console.error(`[context7-kontingent] Stand nicht lesbar: ${(err as Error).message}`));
}

/**
 * Stoesst einen baldigen Lauf an — z. B. nach project(init). Mit project wird nur dessen
 * Fingerabdruck vergessen (Erkennung laeuft neu), ohne project alle.
 */
export function stosseContext7An(project?: string): void {
  if (project) fingerabdruecke.delete(project);
  else fingerabdruecke.clear();
  letzterLauf = 0;
}

/**
 * Ein Tick — vom Parser-Worker bei JEDEM seiner Ticks gerufen (fire-and-forget). Die Automatik
 * entscheidet selbst, ob ein Lauf faellig ist, und laeuft nie doppelt.
 */
export async function context7AutomatikTick(): Promise<void> {
  const k = konfig();
  if (!k.aktiv || laeuft || Date.now() - letzterLauf < k.intervallMs) return;
  // P14-T2: Schalter context7 (intern-Tool) statt context7_automatik_stand.pause_bis von Hand
  if (await schalterHaeltAn('context7', 'context7-automatik')) return;
  laeuft = true;
  letzterLauf = Date.now();
  try {
    await imHintergrund(() => lauf(k)); // P5-T15: nie die Verbindungen der Tool-Anfragen
  } catch (err) {
    console.error(`[context7-auto] Lauf fehlgeschlagen: ${(err as Error).message}`);
  } finally {
    laeuft = false;
  }
}

/**
 * Erkennt die Technologien eines Projekts aus PG (Manifest-Inhalte in code_files +
 * Import-Symbole in code_symbols). Funktioniert ohne Dateisystem, also auch in der API.
 */
export async function erkenneTechnologienAusPg(project: string): Promise<DetectedTechnology[]> {
  const pool = getPool();
  const manifeste = await pool.query<{ file_path: string; content: string | null }>(
    `SELECT file_path, content
       FROM code_files
      WHERE project = $1 AND deleted_at IS NULL AND NOT ignored
        AND file_name = ANY($2::text[])
        AND file_path NOT LIKE '%node_modules/%'`,
    [project, ERKENNUNGS_DATEINAMEN],
  );
  const importe = await pool.query<{ modul: string; endung: string | null }>(
    `SELECT DISTINCT value AS modul, lower(substring(file_path from '\\.([A-Za-z0-9]+)$')) AS endung
       FROM code_symbols
      WHERE project = $1 AND symbol_type = 'import' AND value IS NOT NULL AND value !~ '^[./]'
      LIMIT 20000`,
    [project],
  );
  return detectTechnologiesAusInhalten(
    manifeste.rows.map((r) => ({ pfad: r.file_path, inhalt: r.content ?? '' })),
    importe.rows.map((r) => ({ modul: r.modul, endung: r.endung ?? '' })),
  );
}

/**
 * Merkt eine Context7-Abfrage im Register (Beobachter fuer den Such-Auto-Fetch von tech-docs.ts).
 * Die Abfragen selbst werden NICHT automatisch wiederholt. Ist die Bibliothek noch nicht im Register
 * (oder dort nicht_gefunden/fehler), bekommt sie status 'nur_suche' und naechster_check = jetzt: die
 * Suche hat nur ~5 Snippets geholt, die Automatik behandelt sie wie neu und macht den Gesamtabruf.
 * Eintraege 'bestand'/'abgerufen'/'nur_suche' bleiben sonst unveraendert, dort wird nur die Query angehaengt.
 * Best-effort: wirft nie.
 */
export async function merkeContext7Abfrage(framework: string, query: string): Promise<void> {
  const name = framework.trim();
  const abfrage = query.trim();
  if (!name || !abfrage) return;
  try {
    await getPool().query(
      `INSERT INTO context7_bibliotheken
              (framework, anzeige_name, status, abfragen, abgerufen_am, letzter_check, naechster_check)
       VALUES (lower($1), $1, 'nur_suche', ARRAY[$2::text], NOW(), NOW(), NOW())
       ON CONFLICT (framework) DO UPDATE SET
         abfragen = CASE
           WHEN $2 = ANY(context7_bibliotheken.abfragen)
             OR cardinality(context7_bibliotheken.abfragen) >= $3::int
           THEN context7_bibliotheken.abfragen
           ELSE array_append(context7_bibliotheken.abfragen, $2::text) END,
         status = CASE WHEN context7_bibliotheken.status IN ('nicht_gefunden', 'fehler')
                       THEN 'nur_suche' ELSE context7_bibliotheken.status END,
         naechster_check = CASE WHEN context7_bibliotheken.status IN ('nicht_gefunden', 'fehler')
                                THEN NOW() ELSE context7_bibliotheken.naechster_check END,
         abgerufen_am = COALESCE(context7_bibliotheken.abgerufen_am, NOW())`,
      [name, abfrage, MAX_ABFRAGEN_JE_BIBLIOTHEK],
    );
  } catch (err) {
    console.error(`[context7-auto] Abfrage fuer ${name} nicht gemerkt: ${(err as Error).message}`);
  }
}

// ─── Lauf ────────────────────────────────────────────────────────────────────

async function lauf(k: Konfig): Promise<void> {
  if (!bestandUebernommen) {
    await uebernimmBestand(k);
    bestandUebernommen = true;
  }

  // Kontingent zuerst: in Pause oder ab Stufe 'nur_suche' ruht die Automatik ganz
  const kont = await context7Kontingent();
  const pausiert = kont.pause_bis !== null && kont.pause_bis.getTime() > Date.now();
  if (pausiert || kont.stufe === 'nur_suche' || kont.stufe === 'aus') {
    const grund = pausiert ? `Pause bis ${kont.pause_bis!.toISOString()}` : `Stufe ${kont.stufe} (${kont.verbraucht}/${kont.budget})`;
    if (ruheGemeldet !== grund) {
      console.error(`[context7-auto] ruht: ${grund}`);
      ruheGemeldet = grund;
    }
    return;
  }
  ruheGemeldet = null;

  await sammleNeueBibliotheken();
  if (kont.stufe === 'voll') await sammleFaelligeChecks(k);
  if (warteschlange.size === 0) return;

  const reihenfolge = [...warteschlange].sort((a, b) => b[1].prio - a[1].prio);
  let bearbeitet = 0;
  for (const [schluessel, { name }] of reihenfolge) {
    if (bearbeitet >= k.maxJeTick) break;
    if (bearbeitet > 0) await sleep(k.pauseMs);
    let abbruch: Abbruch | null = null;
    try {
      abbruch = await bearbeite(k, schluessel, name);
    } catch (err) {
      // Darf nicht vorkommen (bearbeite faengt selbst) — Bibliothek trotzdem nicht endlos wiederholen
      console.error(`[context7-auto] ${name}: ${(err as Error).message}`);
    }
    if (abbruch) {
      // Kontingent/Pause: Eintrag bleibt in der Warteschlange, ein spaeterer Lauf macht weiter
      console.error(`[context7-auto] Lauf beendet (${abbruch === 'pause' ? 'Context7 meldet Kontingent erschoepft' : 'eigenes Kontingent lehnt ab'}), Warteschlange ${warteschlange.size}`);
      break;
    }
    warteschlange.delete(schluessel);
    bearbeitet++;
  }
}

/** Register aus dem vorhandenen Context7-Bestand befuellen — OHNE Abruf. */
async function uebernimmBestand(k: Konfig): Promise<void> {
  const erg = await getPool().query(
    `INSERT INTO context7_bibliotheken
            (framework, anzeige_name, status, abgerufen_am, chunks, letzter_check, naechster_check)
     SELECT lower(framework), min(framework), 'bestand', min(indexed_at), count(*)::int,
            NOW(), NOW() + make_interval(days => $1::int)
       FROM tech_docs
      WHERE source = 'context7'
      GROUP BY lower(framework)
     ON CONFLICT (framework) DO NOTHING`,
    [Math.round(k.checkTage)],
  );
  if ((erg.rowCount ?? 0) > 0) {
    console.error(`[context7-auto] ${erg.rowCount} Bibliotheken aus dem Bestand ins Register uebernommen (ohne Abruf)`);
  }
}

/**
 * Erkennung je Projekt, aber nur wo sich der Fingerabdruck (Manifeste + Zahl der Importe)
 * geaendert hat. Fehlende Bibliotheken -> Warteschlange (mit Prioritaet).
 */
async function sammleNeueBibliotheken(): Promise<void> {
  const pool = getPool();
  const projekte = (await pool.query<{ name: string }>(
    `SELECT name FROM projects GROUP BY name HAVING bool_or(enabled)`,
  )).rows.map((r) => r.name);
  if (projekte.length === 0) return;

  const manifestFp = await pool.query<{ project: string; fp: string }>(
    `SELECT project,
            md5(string_agg(file_path || ':' || COALESCE(content_hash, updated_at::text, ''), ',' ORDER BY file_path)) AS fp
       FROM code_files
      WHERE project = ANY($1::text[]) AND deleted_at IS NULL AND NOT ignored
        AND file_name = ANY($2::text[])
        AND file_path NOT LIKE '%node_modules/%'
      GROUP BY project`,
    [projekte, ERKENNUNGS_DATEINAMEN],
  );
  const importZahl = await pool.query<{ project: string; n: number }>(
    `SELECT project, count(*)::int AS n
       FROM code_symbols
      WHERE project = ANY($1::text[]) AND symbol_type = 'import'
      GROUP BY project`,
    [projekte],
  );
  const mf = new Map(manifestFp.rows.map((r) => [r.project, r.fp]));
  const iz = new Map(importZahl.rows.map((r) => [r.project, r.n]));

  // Je Bibliothek: Name, ob Framework, ob ein Manifest sie nennt, in wie vielen Projekten sie vorkommt
  const gewuenscht = new Map<string, { name: string; framework: boolean; manifest: boolean; projekte: number }>();
  for (const projekt of projekte) {
    const fp = `${mf.get(projekt) ?? '-'}|${iz.get(projekt) ?? 0}`;
    if (fingerabdruecke.get(projekt) === fp) continue;
    if (fp === '-|0') { fingerabdruecke.set(projekt, fp); continue; } // nichts indexiert
    try {
      const techs = await erkenneTechnologienAusPg(projekt);
      for (const t of techs) {
        // Sprachen/Tools nicht — Context7 liefert dafuer wenig Brauchbares, das Kontingent ist knapp.
        // confidence 'low' = Bibliothek nur als devDependency (Typen, Test-/Build-Zubehoer) -> nicht.
        if (t.type !== 'framework' && t.type !== 'library') continue;
        if (t.confidence === 'low') continue;
        const schluessel = t.name.toLowerCase();
        const bisher = gewuenscht.get(schluessel);
        gewuenscht.set(schluessel, {
          name: t.name,
          framework: (bisher?.framework ?? false) || t.type === 'framework',
          manifest: (bisher?.manifest ?? false) || t.source !== 'imports',
          projekte: (bisher?.projekte ?? 0) + 1,
        });
      }
      fingerabdruecke.set(projekt, fp);
    } catch (err) {
      console.error(`[context7-auto] Erkennung ${projekt} fehlgeschlagen: ${(err as Error).message}`);
    }
  }
  if (gewuenscht.size === 0) return;

  // 'nur_suche' zaehlt nicht als vorhanden: die Suche hat nur ~5 Snippets geholt, der Gesamtabruf fehlt
  const vorhanden = await pool.query<{ framework: string }>(
    `SELECT framework FROM context7_bibliotheken WHERE framework = ANY($1::text[]) AND status <> 'nur_suche'`,
    [[...gewuenscht.keys()]],
  );
  const bekannt = new Set(vorhanden.rows.map((r) => r.framework));
  let neu = 0;
  for (const [schluessel, w] of gewuenscht) {
    if (bekannt.has(schluessel)) continue;
    const prio = PRIO_NEU + (w.framework ? PRIO_FRAMEWORK : 0) + (w.manifest ? PRIO_MANIFEST : 0) + w.projekte;
    const vorher = warteschlange.get(schluessel);
    if (vorher) {
      vorher.prio = Math.max(vorher.prio, prio);
      continue;
    }
    warteschlange.set(schluessel, { name: w.name, prio });
    neu++;
  }
  if (neu > 0) console.error(`[context7-auto] ${neu} neue Bibliothek(en) vorgemerkt (Warteschlange ${warteschlange.size})`);
}

/** Register-Eintraege, deren Update-Check bzw. Wiederholung faellig ist (niedrigste Prioritaet). */
async function sammleFaelligeChecks(k: Konfig): Promise<void> {
  const r = await getPool().query<{ framework: string; anzeige_name: string | null }>(
    `SELECT framework, anzeige_name
       FROM context7_bibliotheken
      WHERE naechster_check IS NOT NULL AND naechster_check <= NOW()
      ORDER BY naechster_check
      LIMIT $1`,
    [k.maxJeTick],
  );
  for (const z of r.rows) {
    if (!warteschlange.has(z.framework)) warteschlange.set(z.framework, { name: z.anzeige_name ?? z.framework, prio: 0 });
  }
}

/**
 * Bearbeitet EINE Bibliothek: Suche (1 Aufruf), ggf. Docs (1 Aufruf), Register fortschreiben.
 * Fehler werden hier gefangen; Rueckgabe 'kontingent'/'pause' beendet den Lauf.
 */
async function bearbeite(k: Konfig, schluessel: string, name: string): Promise<Abbruch | null> {
  const pool = getPool();
  const zeile = (await pool.query<RegisterZeile>(
    `SELECT framework, anzeige_name, status, library_id, quelle_stand, abgerufen_am, naechster_check
       FROM context7_bibliotheken WHERE framework = $1`,
    [schluessel],
  )).rows[0];
  // Inzwischen erledigt (z. B. Such-Auto-Fetch hat sie geholt) -> nichts tun
  if (zeile?.naechster_check && zeile.naechster_check.getTime() > Date.now()) return null;

  const client = getContext7Client();
  // 'nur_suche' = bisher nur der kleine Such-Fetch -> wie neu behandeln (Gesamtabruf)
  const istNeu = !zeile || zeile.status === 'nicht_gefunden' || zeile.status === 'fehler' || zeile.status === 'nur_suche';
  const art: Context7Aufrufart = istNeu ? 'neu' : 'update';

  // ── Schritt 1: Bibliothek suchen (1 Aufruf) ──
  let treffer: Context7Bibliothek[];
  try {
    treffer = await client.sucheBibliotheken(name, art);
  } catch (err) {
    return await behandleFehler(k, schluessel, name, err);
  }
  // Namens-Rangfolge ist Pflicht (waehleBibliothek): exakt > Titel-Wort > nicht gefunden.
  // libs/search liefert auch Plugins und Namensvettern (flask-login fuer "Flask") — ohne
  // Rangfolge landeten fremde Docs unter falschem Namen im Cache.
  const wahl = client.waehleBibliothek(treffer, name, zeile?.library_id);
  const bib = wahl?.bib ?? null;

  // Bestand ohne library_id: beim ersten Check NUR die Zuordnung merken, und auch die nur bei
  // Stufe 'exakt'. Kein Abruf — der Bestand ist da; ein Update holt erst der naechste Check.
  if (zeile?.status === 'bestand' && !zeile.library_id) {
    if (wahl && wahl.stufe === 'exakt') {
      await schreibeMetadaten(schluessel, name, wahl.bib, null, k);
    } else {
      await pool.query(
        `UPDATE context7_bibliotheken
            SET letzter_check = NOW(), naechster_check = NOW() + make_interval(days => $2::int), letzter_fehler = $3
          WHERE framework = $1`,
        [schluessel, Math.round(k.checkTage), wahl ? `Zuordnung nicht eindeutig (nur Stufe ${wahl.stufe}: ${wahl.bib.id})` : 'kein passender Treffer bei Context7'],
      );
    }
    return null;
  }

  if (!bib) {
    await pool.query(
      `INSERT INTO context7_bibliotheken (framework, anzeige_name, status, letzter_check, naechster_check)
       VALUES ($1, $2, 'nicht_gefunden', NOW(), NOW() + make_interval(days => $3::int))
       ON CONFLICT (framework) DO UPDATE SET
         status = CASE WHEN context7_bibliotheken.status IN ('bestand', 'abgerufen')
                       THEN context7_bibliotheken.status ELSE 'nicht_gefunden' END,
         letzter_check = NOW(), naechster_check = EXCLUDED.naechster_check, letzter_fehler = NULL`,
      [schluessel, name, Math.round(k.checkTage)],
    );
    console.error(`[context7-auto] ${name}: bei Context7 kein passender Treffer (${treffer.length} Treffer, keiner exakt oder als Titel-Wort)`);
    return null;
  }

  const quelleStand = bib.lastUpdateDate ? new Date(bib.lastUpdateDate) : null;
  const eigenerStand = zeile?.quelle_stand ?? zeile?.abgerufen_am ?? null;
  const brauchtAbruf = istNeu || (quelleStand !== null && (eigenerStand === null || quelleStand > eigenerStand));

  if (!brauchtAbruf) {
    // Kein Update bei Context7: nur Metadaten + naechster Check
    await schreibeMetadaten(schluessel, name, bib, quelleStand, k);
    return null;
  }

  // ── Schritt 2: Docs holen (1 Aufruf) ──
  await sleep(k.pauseMs);
  const abfrage = k.gesamtTokens > 0 ? GESAMT_ABFRAGE : ALLGEMEINE_ABFRAGE(name);
  let docs: Context7Doc[];
  let tokensBenutzt: number | null = null;
  try {
    if (k.gesamtTokens > 0) {
      const gesamt = await holeGesamt(k, bib.id, schluessel, art);
      docs = gesamt.docs;
      tokensBenutzt = gesamt.tokens;
    } else {
      docs = await client.holeDocs(bib.id, schluessel, abfrage, art);
    }
  } catch (err) {
    if (err instanceof Context7Fehler && err.istBudget && zeile) {
      // Zuordnung behalten, naechster_check unveraendert -> ein spaeterer Lauf holt die Docs
      await pool.query(
        `UPDATE context7_bibliotheken SET library_id = $2, titel = $3 WHERE framework = $1`,
        [schluessel, bib.id, bib.title],
      );
    }
    return await behandleFehler(k, schluessel, name, err);
  }

  let gespeichert = 0;
  if (docs.length > 0) {
    const erg = await speichereContext7Chunks(
      schluessel,
      'latest',
      docs.map((d) => ({ section: d.title || name, content: d.content })),
    );
    gespeichert = erg.gespeichert;
    console.error(
      `[context7-auto] ${name} (${bib.id}): ${erg.gespeichert} neu, ${erg.duplikate} schon vorhanden${erg.fehlgeschlagen ? `, ${erg.fehlgeschlagen} fehlgeschlagen` : ''}${istNeu ? '' : ' (Update)'}`,
    );
  } else {
    console.error(`[context7-auto] ${name} (${bib.id}): keine verwertbaren Docs`);
  }

  await pool.query(
    `INSERT INTO context7_bibliotheken
            (framework, anzeige_name, status, library_id, titel, quelle_stand, versions,
             trust_score, benchmark_score, total_snippets, chunks, abfragen, gesamt_tokens,
             abgerufen_am, letzter_check, naechster_check)
     VALUES ($1, $2, 'abgerufen', $3, $4, $5, $6::text[], $7, $8, $9, $10::int, ARRAY[$11::text], $14::int,
             NOW(), NOW(), NOW() + make_interval(days => $12::int))
     ON CONFLICT (framework) DO UPDATE SET
       status = 'abgerufen',
       library_id = EXCLUDED.library_id, titel = EXCLUDED.titel, quelle_stand = EXCLUDED.quelle_stand,
       versions = EXCLUDED.versions, trust_score = EXCLUDED.trust_score,
       benchmark_score = EXCLUDED.benchmark_score, total_snippets = EXCLUDED.total_snippets,
       gesamt_tokens = COALESCE(EXCLUDED.gesamt_tokens, context7_bibliotheken.gesamt_tokens),
       chunks = context7_bibliotheken.chunks + EXCLUDED.chunks,
       abfragen = CASE WHEN $11 = ANY(context7_bibliotheken.abfragen)
                         OR cardinality(context7_bibliotheken.abfragen) >= $13::int
                       THEN context7_bibliotheken.abfragen
                       ELSE array_append(context7_bibliotheken.abfragen, $11::text) END,
       abgerufen_am = NOW(), letzter_check = NOW(),
       naechster_check = EXCLUDED.naechster_check, letzter_fehler = NULL`,
    [
      schluessel, name, bib.id, bib.title, quelleStand, bib.versions,
      bib.trustScore ?? null, bib.benchmarkScore ?? null, bib.totalSnippets ?? null, gespeichert,
      abfrage, Math.round(k.checkTage), MAX_ABFRAGEN_JE_BIBLIOTHEK, tokensBenutzt,
    ],
  );
  return null;
}

/**
 * Gesamtabruf mit dem groessten bekannten tokens-Wert (Env, gedeckelt durch das in PG gemerkte
 * Maximum). Lehnt Context7 den Wert mit 4xx ab (nicht Kontingent), genau EIN Wiederholversuch
 * mit dem genannten Maximum bzw. TOKENS_RUECKFALL; der funktionierende Wert wird gemerkt.
 * Der Wiederholversuch ist ein eigener Aufruf und zaehlt ebenfalls gegen das Kontingent.
 */
async function holeGesamt(
  k: Konfig,
  libraryId: string,
  schluessel: string,
  art: Context7Aufrufart,
): Promise<{ docs: Context7Doc[]; tokens: number }> {
  const client = getContext7Client();
  const gemerkt = (await getPool().query<{ tokens_max: number | null }>(
    `SELECT tokens_max FROM context7_automatik_stand WHERE id = 1`,
  )).rows[0]?.tokens_max ?? null;
  const tokens = gemerkt && gemerkt > 0 ? Math.min(gemerkt, k.gesamtTokens) : k.gesamtTokens;

  try {
    return { docs: await client.holeGesamtDocs(libraryId, schluessel, tokens, art), tokens };
  } catch (err) {
    const abgelehnt = err instanceof Context7Fehler && !err.istKontingent && !err.istBudget
      && err.status !== null && err.status >= 400 && err.status < 500;
    if (!abgelehnt) throw err;
    const genannt = maxAusMeldung((err as Error).message);
    const zweiter = genannt !== null && genannt < tokens ? genannt : Math.min(TOKENS_RUECKFALL, tokens - 1);
    if (zweiter <= 0 || zweiter >= tokens) throw err;

    console.error(`[context7-auto] tokens=${tokens} abgelehnt (${(err as Error).message}) — ein Versuch mit tokens=${zweiter}`);
    await sleep(k.pauseMs);
    const docs = await client.holeGesamtDocs(libraryId, schluessel, zweiter, art);
    await getPool().query(`UPDATE context7_automatik_stand SET tokens_max = $1::int WHERE id = 1`, [zweiter]);
    return { docs, tokens: zweiter };
  }
}

/** Liest ein von Context7 genanntes tokens-Maximum aus einer Fehlermeldung (z. B. "max 50000 tokens"). */
export function maxAusMeldung(meldung: string): number | null {
  const m = meldung.match(/(?:max(?:imum)?|limit|up to|at most|<=?)\D{0,30}?(\d[\d,._]{2,})/i);
  if (!m) return null;
  const wert = Number(m[1].replace(/[,._]/g, ''));
  return Number.isFinite(wert) && wert > 0 ? wert : null;
}

/** Update-Check ohne Abruf: Metadaten aktualisieren, Stand uebernehmen, naechsten Check planen. */
async function schreibeMetadaten(
  schluessel: string,
  name: string,
  bib: Context7Bibliothek,
  quelleStand: Date | null,
  k: Konfig,
): Promise<void> {
  // Unser Abruf ist juenger als die letzte Aenderung bei Context7 -> inhaltlich auf diesem Stand
  await getPool().query(
    `UPDATE context7_bibliotheken SET
       anzeige_name = COALESCE(anzeige_name, $2),
       library_id = $3, titel = $4, quelle_stand = COALESCE($5, quelle_stand), versions = $6::text[],
       trust_score = $7, benchmark_score = $8, total_snippets = $9,
       letzter_check = NOW(), naechster_check = NOW() + make_interval(days => $10::int), letzter_fehler = NULL
     WHERE framework = $1`,
    [
      schluessel, name, bib.id, bib.title, quelleStand, bib.versions,
      bib.trustScore ?? null, bib.benchmarkScore ?? null, bib.totalSnippets ?? null, Math.round(k.checkTage),
    ],
  );
}

/**
 * Fehler je Bibliothek: Kontingent (eigenes oder Context7-429) beendet den Lauf, Register bleibt
 * unveraendert; sonst nur loggen + spaeter erneut.
 */
async function behandleFehler(k: Konfig, schluessel: string, name: string, err: unknown): Promise<Abbruch | null> {
  const meldung = err instanceof Error ? err.message : String(err);
  if (err instanceof Context7Fehler && err.istKontingent) return 'pause'; // Pause setzt der Client
  if (err instanceof Context7Fehler && err.istBudget) return 'kontingent';
  console.error(`[context7-auto] ${name}: ${meldung} — neuer Versuch in ${k.fehlerPauseH} h`);
  await getPool().query(
    `INSERT INTO context7_bibliotheken (framework, anzeige_name, status, letzter_check, naechster_check, letzter_fehler)
     VALUES ($1, $2, 'fehler', NOW(), NOW() + make_interval(hours => $3::int), $4)
     ON CONFLICT (framework) DO UPDATE SET
       letzter_check = NOW(), naechster_check = EXCLUDED.naechster_check, letzter_fehler = EXCLUDED.letzter_fehler`,
    [schluessel, name, Math.round(k.fehlerPauseH), meldung.slice(0, 500)],
  );
  return null;
}
