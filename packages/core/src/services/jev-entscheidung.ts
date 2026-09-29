/**
 * Jev entscheidet Rueckfragen, wenn der User nicht da ist (P7-T28 / JEV-10, 29.09.2026).
 *
 * Skills (superpowers ...) und Synapse-Anweisungen fragen den User bei Entscheidungen (ja/nein,
 * Skala, Auswahl). Ist der User weg (Nacht, Loop), beantwortet Jev die ERLAUBTEN Rueckfragen.
 * Die Kette bleibt Agent -> Koordinator -> User; bei aktivem Schalter springt Jev fuer den User
 * (und, wenn der Koordinator gerade nicht erreichbar ist, fuer diesen) ein. Der Koordinator kann
 * jede Jev-Entscheidung ueberstimmen; beim 'bin wieder da' bekommt der User das Protokoll.
 *
 * SCHALTER: je Projekt (Tabelle jev_entscheidet), nur der Koordinator setzt ihn, auf Zuruf des
 * Users — kein automatisches Erkennen. Standard KEIN Ablauf; 'bis' ist freiwillig. Die Pruefung
 * 'nur Koordinator' ist Namenstreue (agent_id koordinator/coordinator), keine Identitaetspruefung.
 *
 * LEITPLANKEN (der Server, nicht die Ehrlichkeit des Agenten): erlaubt sind nur umkehrbare
 * Kategorien; verbotene und unbekannte werden abgelehnt. Schalter aus = KEIN Jev-Aufruf, keine
 * Kosten, keine Protokollzeile, Antwort 'User/Koordinator fragen'.
 *
 * ENTSCHEIDUNG: EIN Jev-Aufruf (OpenRouter /api/v1/systemone wie jev-empfehlung.ts). Confidence-Tor
 * 0.7: darunter keine Entscheidung. noul = Wahrscheinlichkeit fuer 'ja' (ja ab p >= Tor, nein ab
 * p <= 1-Tor, dazwischen unsicher); choice = Auswahl; score = Skala, intern als choice ueber die
 * Zahlenlabels gefragt (kein Verlass auf ein score-Format der API). Jede Antwort traegt die
 * Kennzeichnung 'entschieden von Jev (Confidence x), nicht vom User'.
 *
 * PROTOKOLL: Tabelle jev_entscheidungen (auch abgelehnte/unsichere Versuche bei aktivem Schalter).
 * Der Key (JEV_OPENROUTER_API_KEY) wird nie ausgegeben oder geloggt.
 */

import { getPool } from '../db/client.js';
import { JEV_STANDARD_URL, JEV_STANDARD_MODELL } from './jev-empfehlung.js';

export const ERLAUBTE_KATEGORIEN = ['variante', 'reihenfolge', 'umsetzungsweg', 'formulierung'] as const;
export const VERBOTENE_KATEGORIEN = ['loeschen', 'deploy', 'git', 'secrets', 'aussenwirkung', 'kosten', 'regeln'] as const;
/** Confidence-Tor fuer Entscheidungen (strenger als das 0.5 der Modellempfehlung: hier antwortet niemand nach) */
export const STANDARD_ENTSCHEIDUNG_TOR = 0.7;
/** Jev-Aufrufe je Stunde und Projekt, danach Ablehnung (Schutz gegen Schleifen) */
export const STANDARD_RATE_PRO_STUNDE = 30;
/** JEV-12: Runden je Kette; ab runde == Grenze nur noch letzte_runde, darueber max_runden (Env JEV_MAX_RUNDEN) */
export const STANDARD_MAX_RUNDEN = 4;
/** JEV-12: fester Schluessel der fuenften Option ("keine der vier passt gut genug") */
export const WEITERE_KEY = 'weitere';
const WEITERE_BESCHREIBUNG = 'none of the four fits well enough; better options exist that are not listed';
const MAX_VERWORFEN = 20;
const STANDARD_TIMEOUT_MS = 10_000;
const MAX_FRAGE = 500;
const MAX_KONTEXT = 1500;
const MAX_HINWEISE = 500;
const KOORDINATOR = /^(koordinator|coordinator)$/i;
const FRAGE_NEU = 'User/Koordinator fragen';
/** Verweis auf die Anleitung, die jede Eingabe-Ablehnung nennt */
const ANLEITUNG = 'Anleitung: guide(tool_name:jev), Abschnitt "Vorgehen Schritt fuer Schritt".';
/** Tipp bei unsicherem Ergebnis: Jev waehlt nur zwischen Optionen — die Formulierung entscheidet */
export const TIPP_UNSICHER =
  'Jev waehlt nur zwischen vorgegebenen Optionen. Optionen trennschaerfer beschreiben (WANN ist jede richtig?) ' +
  'oder Kontext ergaenzen, dann EINMAL erneut fragen; bleibt es unsicher, User/Koordinator fragen.';
/** Fragewoerter: eine offene W-Frage ist keine Aussage, die wahr oder falsch sein kann (typ noul) */
const W_FRAGE = /^\s*(was|wie|wann|wo|wohin|woher|warum|wieso|weshalb|wozu|womit|wodurch|welche[rsnm]?|wer|wem|wen|wessen|what|how|why|which|when|where|who)\b/i;

export type EntscheidungsTyp = 'noul' | 'choice' | 'score';

export interface AbwesenheitsStand {
  aktiv: boolean;
  seit?: Date | string | null;
  bis?: Date | string | null;
  gesetzt_von?: string | null;
  /** true = war an, ist aber per bis abgelaufen */
  abgelaufen?: boolean;
}

export interface EntscheidungsDeps {
  fetch?: typeof fetch;
}

function zahlAusEnv(name: string): number | undefined {
  const roh = process.env[name]?.trim();
  if (!roh) return undefined;
  const n = Number(roh);
  return Number.isFinite(n) ? n : undefined;
}

function kurz(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ohneKey(text: string, key: string): string {
  return key ? text.split(key).join('***') : text;
}

// ---------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------

/** Aktueller Stand des Schalters; ein abgelaufenes 'bis' zaehlt als aus. */
export async function leseAbwesenheit(project: string): Promise<AbwesenheitsStand> {
  const { rows } = await getPool().query(
    `SELECT aktiv, seit, bis, gesetzt_von FROM jev_entscheidet WHERE project = $1`,
    [project],
  );
  if (rows.length === 0) return { aktiv: false };
  const z = rows[0] as { aktiv: boolean; seit: Date | null; bis: Date | null; gesetzt_von: string | null };
  const abgelaufen = z.aktiv && z.bis !== null && z.bis !== undefined && new Date(z.bis).getTime() <= Date.now();
  return {
    aktiv: z.aktiv && !abgelaufen,
    seit: z.seit,
    bis: z.bis,
    gesetzt_von: z.gesetzt_von,
    ...(abgelaufen ? { abgelaufen: true } : {}),
  };
}

export interface AbwesenheitOptionen {
  modus?: string;
  agent_id?: string;
  /** ISO-Zeitpunkt in der Zukunft */
  bis?: string;
  /** Alternative zu bis: in N Stunden */
  stunden?: number;
}

/**
 * Schalter setzen (an/aus, nur Koordinator) oder anzeigen (status, jeder).
 * 'aus' liefert das Protokoll seit dem Einschalten mit — fuer 'bin wieder da'.
 */
export async function setzeAbwesenheit(
  project: string,
  opt: AbwesenheitOptionen = {},
): Promise<Record<string, unknown>> {
  const modus = typeof opt.modus === 'string' ? opt.modus.trim().toLowerCase() : '';
  if (!['an', 'aus', 'status'].includes(modus)) {
    return { success: false, message: `modus muss einer von: an, aus, status sein (bekommen: "${opt.modus ?? ''}").` };
  }
  try {
    if (modus === 'status') {
      return { success: true, schalter: await leseAbwesenheit(project), hinweis: hinweisText(await leseAbwesenheit(project)) };
    }
    const wer = typeof opt.agent_id === 'string' ? opt.agent_id.trim() : '';
    if (!KOORDINATOR.test(wer)) {
      return {
        success: false,
        message: 'Den Schalter setzt nur der Koordinator (agent_id koordinator/coordinator), auf Zuruf des Users. ' +
          'Das ist Namenstreue, keine Identitaetspruefung.',
      };
    }
    if (modus === 'an') {
      let bis: Date | null = null;
      if (opt.bis !== undefined && opt.bis !== null && String(opt.bis).trim() !== '') {
        bis = new Date(String(opt.bis));
      } else if (typeof opt.stunden === 'number' && Number.isFinite(opt.stunden)) {
        bis = new Date(Date.now() + opt.stunden * 3_600_000);
      }
      if (bis !== null && (Number.isNaN(bis.getTime()) || bis.getTime() <= Date.now())) {
        return { success: false, message: 'bis muss ein ISO-Zeitpunkt in der Zukunft sein (oder stunden > 0).' };
      }
      await getPool().query(
        `INSERT INTO jev_entscheidet (project, aktiv, seit, bis, gesetzt_von, updated_at)
         VALUES ($1, true, NOW(), $3, $2, NOW())
         ON CONFLICT (project) DO UPDATE SET
           aktiv = true,
           seit = CASE WHEN jev_entscheidet.aktiv THEN jev_entscheidet.seit ELSE NOW() END,
           bis = $3, gesetzt_von = $2, updated_at = NOW()`,
        [project, wer, bis],
      );
      const stand = await leseAbwesenheit(project);
      return { success: true, schalter: stand, hinweis: hinweisText(stand), message: 'User abwesend: Jev entscheidet erlaubte Rueckfragen.' };
    }
    // aus: Protokoll VOR dem Umschalten sichern (seit steht noch)
    const vorher = await leseAbwesenheit(project);
    const protokoll = await holeEntscheidungsProtokoll(project, { seit: vorher.seit ?? undefined });
    await getPool().query(
      `UPDATE jev_entscheidet SET aktiv = false, bis = NULL, gesetzt_von = $2, updated_at = NOW() WHERE project = $1`,
      [project, wer],
    );
    return {
      success: true,
      schalter: await leseAbwesenheit(project),
      protokoll: protokoll.eintraege ?? [],
      offene_fragen: protokoll.offene_fragen ?? [],
      ketten: protokoll.ketten ?? [],
      message: `User wieder da: Jev entscheidet nicht mehr. ${(protokoll.eintraege ?? []).length} Eintrag/Eintraege im Protokoll seit dem Einschalten.`,
    };
  } catch (err) {
    return { success: false, message: `Schalter nicht lesbar/schreibbar: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Hinweistext fuer plan(list), Onboarding und Antworten bei aktivem Schalter; sonst undefined */
export function hinweisText(stand: AbwesenheitsStand): string | undefined {
  if (!stand.aktiv) return undefined;
  return 'User abwesend — Jev entscheidet erlaubte Rueckfragen (jev(entscheiden), Kategorien: ' +
    `${ERLAUBTE_KATEGORIEN.join(', ')}); verbotene Kategorien (${VERBOTENE_KATEGORIEN.join(', ')}) warten weiter auf den User.`;
}

/**
 * Onboarding-Block: Hinweistext bei aktivem Schalter, sonst undefined.
 * Faellt die Abfrage aus (z. B. Tabelle noch nicht angelegt), gibt es KEINEN Hinweis statt
 * eines Fehlers — ein Zusatzhinweis darf das Onboarding nie gefaehrden.
 */
export async function baueAbwesenheitsHinweis(project: string): Promise<string | undefined> {
  try {
    return hinweisText(await leseAbwesenheit(project));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Entscheiden
// ---------------------------------------------------------------------------

export interface EntscheidungsAnfrage {
  agent_id?: string;
  frage?: string;
  typ?: string;
  kategorie?: string;
  /** choice: {key: Beschreibung}, genau 5 inkl. Schluessel 'weitere' (letzte_runde: 2..5 ohne weitere); score: {'1': Anker, ...}; noul: nicht noetig */
  optionen?: Record<string, string>;
  kontext?: string;
  task_id?: string;
  hinweise?: string;
  confidence_tor?: number;
  /** JEV-12: Runde der Kette (Start 1) */
  runde?: number | string;
  /** JEV-12: in frueheren Runden verworfene Optionen [{key, beschreibung}] */
  verworfen?: unknown;
  /** JEV-12: Abschluss — 'weitere' nicht erlaubt, 2..5 echte Optionen */
  letzte_runde?: boolean;
  /** JEV-12: Protokoll-Nummer der ersten Frage der Kette (ab Runde 2 Pflicht) */
  erste_id?: number | string;
  /** JEV-12: KOMPLETTER Blocker (keine andere passende Task) -> Einsprung Koordinator */
  blocker?: boolean;
  /** JEV-12: dem Agenten faellt keine plausible Option mehr ein -> offene Frage, kein Jev-Aufruf */
  keine_plausible_option?: boolean;
}

interface LogEintrag {
  agent: string;
  task_id: string | null;
  kategorie: string | null;
  frage: string;
  typ: string;
  optionen: unknown;
  wahl: unknown;
  confidence: number | null;
  entschieden: boolean;
  grund: string | null;
  jev_aufruf: boolean;
  runde: number;
  /** Protokoll-Nummer der ersten Frage der Kette; null = diese Zeile ist selbst die erste */
  erste_id: number | null;
  offen_fuer_user: boolean;
  blocker: boolean;
}

async function protokolliere(project: string, e: LogEintrag): Promise<number | null> {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO jev_entscheidungen
         (project, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, jev_aufruf,
          runde, erste_id, offen_fuer_user, blocker)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id, zeit`,
      [
        project, e.agent, e.task_id, e.kategorie, e.frage, e.typ,
        e.optionen === null || e.optionen === undefined ? null : JSON.stringify(e.optionen),
        e.wahl === null || e.wahl === undefined ? null : JSON.stringify(e.wahl),
        e.confidence, e.entschieden, e.grund, e.jev_aufruf,
        e.runde, e.erste_id, e.offen_fuer_user, e.blocker,
      ],
    );
    const id = rows.length > 0 ? Number((rows[0] as { id: number | string }).id) : null;
    // Erste Zeile einer Kette: sie ist ihre eigene erste Frage (Kette = erste_id)
    if (id !== null && e.erste_id === null) {
      await getPool().query(`UPDATE jev_entscheidungen SET erste_id = id WHERE id = $1 AND erste_id IS NULL`, [id]).catch(() => undefined);
    }
    return id;
  } catch {
    // Das Protokoll darf eine Antwort nie kippen — die Antwort sagt dann protokoll_id:null.
    return null;
  }
}

function kennzeichnung(confidence: number): string {
  return `entschieden von Jev (Confidence ${confidence}), nicht vom User`;
}

/** Die Rundengrenze: ab runde == Grenze nur noch letzte_runde, darueber max_runden (Env JEV_MAX_RUNDEN) */
function maxRunden(): number {
  const n = zahlAusEnv('JEV_MAX_RUNDEN');
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : STANDARD_MAX_RUNDEN;
}

/** Schluss der Kette, Fall (a): KEIN Blocker — Notiz fuer den User im Protokoll, Task auf todo, andere Task */
const SCHRITT_OFFEN =
  'Notiz an den User ist im Protokoll. Diese Task auf todo zuruecksetzen (plan update_task) mit kurzer Notiz in der ' +
  'Beschreibung bzw. als Thought mit task_id, dann mit einer ANDEREN passenden Task weitermachen (plan passende_tasks / ' +
  'Koordinator-Zuweisung). Nicht warten.';
/** Schluss der Kette, Fall (b): KOMPLETTER Blocker — Einsprung ist der Koordinator */
const SCHRITT_BLOCKER =
  'KOMPLETTER Blocker: Einsprung ist der KOORDINATOR. Frage im Channel an den Koordinator stellen und ihn per cc-send ' +
  'wecken; er entscheidet oder sammelt es fuer den User, wenn der zurueck ist. Die Protokollzeile traegt blocker:true.';

function schrittWeiter(naechsteRunde: number, ersteId: number | null): string {
  return 'Jev waehlt "weitere": keine der vier Optionen passt gut genug. 4 neue Optionen erarbeiten (nicht aus verworfen; ' +
    `Superpowers brainstorming), dann erneut jev(entscheiden) mit runde ${naechsteRunde}, verworfen um die bisherigen 4 Optionen ` +
    `erweitert (Liste {key, beschreibung})${ersteId !== null ? ` und erste_id ${ersteId}` : ' und erste_id (protokoll_id dieser Antwort)'}. ` +
    'Faellt dir nichts Neues ein: letzte_runde:true mit den besten bisherigen Optionen. Erscheint keine Option plausibel: ' +
    'keine_plausible_option:true (blocker:true nur, wenn es keine andere passende Task gibt).';
}

function normalisiere(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

/** verworfen kann als Array oder als JSON-String ankommen (Connector-Quirk). undefined = ungueltig. */
function leseVerworfen(roh: unknown): Array<{ key: string; beschreibung: string }> | undefined {
  if (roh === undefined || roh === null || roh === '') return [];
  let liste: unknown = roh;
  if (typeof roh === 'string') {
    try { liste = JSON.parse(roh); } catch { return undefined; }
  }
  if (!Array.isArray(liste)) return undefined;
  const aus: Array<{ key: string; beschreibung: string }> = [];
  for (const e of liste) {
    if (!e || typeof e !== 'object') return undefined;
    const { key, beschreibung } = e as { key?: unknown; beschreibung?: unknown };
    if (typeof key !== 'string' || !key.trim()) return undefined;
    aus.push({ key: key.trim(), beschreibung: kurz(beschreibung, 200) });
  }
  return aus.slice(0, MAX_VERWORFEN);
}

/**
 * Beantwortet eine erlaubte Rueckfrage per Jev — nur bei aktivem Schalter.
 * success:true + entschieden:false heisst: kein Fehler, aber der Agent fragt weiter den
 * User/Koordinator (oder geht in die naechste Runde, weiter:true). success:false ist ein Fehler
 * bei Jev oder in der Eingabe.
 *
 * JEV-12 (P7-T31): choice hat IMMER 5 Optionen — 4 echte + 'weitere' (Beschreibung setzt der Server).
 * Waehlt Jev 'weitere', erarbeitet der Agent 4 neue Optionen (verworfen = die bisherigen) und fragt mit
 * runde+1 erneut. Am Ende der Kette (letzte Runde unsicher, Rundengrenze, keine plausible Option) wird
 * die Frage als OFFENE FRAGE fuer den User protokolliert — kein Warten (Fall a) bzw. Einsprung des
 * Koordinators (Fall b, blocker:true).
 */
export async function entscheideRueckfrage(
  project: string,
  anfrage: EntscheidungsAnfrage = {},
  deps: EntscheidungsDeps = {},
): Promise<Record<string, unknown>> {
  const fehler = (message: string) => ({ success: false, entschieden: false, message });
  /** Eingabefehler mit Verweis auf die Anleitung (kein nacktes 'geht nicht') */
  const eingabeFehler = (message: string) => ({
    success: false,
    entschieden: false,
    message: `${message} ${ANLEITUNG}`,
    anleitung: 'guide(tool_name:jev) Abschnitt Vorgehen Schritt fuer Schritt',
  });

  // --- Eingabe (billig, ohne Protokoll) -----------------------------------
  const agent = typeof anfrage.agent_id === 'string' ? anfrage.agent_id.trim() : '';
  if (!agent) return fehler('agent_id ist Pflicht (wer fragt).');
  const frage = kurz(anfrage.frage, MAX_FRAGE);
  if (!frage) return fehler('frage ist Pflicht.');
  const typ = typeof anfrage.typ === 'string' ? anfrage.typ.trim().toLowerCase() : '';
  if (typ !== 'noul' && typ !== 'choice' && typ !== 'score') {
    return fehler('typ muss noul (ja/nein), choice (Auswahl) oder score (Skala) sein.');
  }
  const kategorie = typeof anfrage.kategorie === 'string' ? anfrage.kategorie.trim().toLowerCase() : '';
  if (!kategorie) {
    return fehler(`kategorie ist Pflicht. Erlaubt: ${ERLAUBTE_KATEGORIEN.join(', ')}.`);
  }
  if (typ === 'noul' && W_FRAGE.test(frage)) {
    return eingabeFehler(
      'typ noul braucht eine AUSSAGE, die wahr oder falsch sein kann (z. B. "Die Aenderung bricht keine alten Aufrufe."), ' +
      'keine offene W-Frage. Offene Frage? Erst 4 sich ausschliessende Optionen erarbeiten und typ choice mit optionen {key: Beschreibung} nutzen.',
    );
  }

  // --- Runden-Angaben (JEV-12) -------------------------------------------------
  const letzteRunde = anfrage.letzte_runde === true;
  const blocker = anfrage.blocker === true;
  const keinePlausible = anfrage.keine_plausible_option === true;
  let runde = 1;
  if (anfrage.runde !== undefined && anfrage.runde !== null && anfrage.runde !== '') {
    const n = Number(anfrage.runde);
    if (!Number.isInteger(n) || n < 1) {
      return eingabeFehler(`runde muss eine ganze Zahl >= 1 sein (bekommen: "${String(anfrage.runde)}"); Runde 1 ist die erste Frage einer Kette.`);
    }
    runde = n;
  }
  let ersteId: number | null = null;
  if (anfrage.erste_id !== undefined && anfrage.erste_id !== null && anfrage.erste_id !== '') {
    const n = Number(anfrage.erste_id);
    if (!Number.isInteger(n) || n <= 0) return eingabeFehler(`erste_id muss eine Protokoll-Nummer sein (bekommen: "${String(anfrage.erste_id)}").`);
    ersteId = n;
  }
  if (runde > 1 && ersteId === null) {
    return eingabeFehler(
      `Ab Runde 2 ist erste_id Pflicht: die protokoll_id (bzw. erste_id) der Antwort auf die erste Frage dieser Kette — ` +
      'so haengt das Protokoll die Runden zusammen.',
    );
  }
  const verworfen = leseVerworfen(anfrage.verworfen);
  if (verworfen === undefined) {
    return eingabeFehler('verworfen muss eine Liste [{key, beschreibung}] der in frueheren Runden verworfenen Optionen sein.');
  }

  // --- Optionen ------------------------------------------------------------------------
  let criteria: Record<string, string> | undefined;
  if (!keinePlausible && (typ === 'choice' || typ === 'score')) {
    const roh = anfrage.optionen && typeof anfrage.optionen === 'object' ? anfrage.optionen : undefined;
    if (typ === 'choice') {
      const keys = roh ? Object.keys(roh) : [];
      if (keys.length < 2 || keys.length > 10) {
        return eingabeFehler(
          `choice braucht optionen {key: Beschreibung}: 4 echte Optionen plus "${WEITERE_KEY}" (bekommen: ${keys.length}). Eine offene Frage ohne Optionen kann Jev nicht beantworten — ` +
          'Jev waehlt nur zwischen vorgegebenen Optionen. Erarbeite konkrete, sich ausschliessende Optionen (z. B. mit Superpowers brainstorming) und beschreibe je Option, WANN sie richtig ist.',
        );
      }
      // 1. Beschreibungen der echten Optionen (weitere setzt der Server)
      const echte = keys.filter((k) => k !== WEITERE_KEY);
      const zuKurz = echte.filter((k) => {
        const b = typeof roh![k] === 'string' ? (roh![k] as string).replace(/\s+/g, ' ').trim() : '';
        return b.length < 12 || b.split(' ').length < 2 || b.toLowerCase() === k.trim().toLowerCase();
      });
      if (zuKurz.length > 0) {
        return eingabeFehler(
          `Beschreibung fehlt oder ist zu knapp bei ${zuKurz.map((k) => `"${k}"`).join(', ')}: mindestens ein kurzer Satz, der sagt, WANN die Option richtig ist (Bedingung/Kriterium), ` +
          'nicht nur ihr Name. Jev bewertet die Beschreibungen gegen den kontext.',
        );
      }
      // 2. Aufbau: 4 echte + weitere (Standard) bzw. 2..5 echte ohne weitere (letzte Runde)
      if (letzteRunde) {
        if (keys.includes(WEITERE_KEY)) {
          return eingabeFehler(`In der letzten Runde (letzte_runde:true) ist "${WEITERE_KEY}" nicht erlaubt: waehle aus den 2 bis 5 besten bisherigen Optionen.`);
        }
        if (echte.length < 2 || echte.length > 5) {
          return eingabeFehler(`letzte_runde braucht 2 bis 5 echte Optionen (bekommen: ${echte.length}).`);
        }
      } else if (keys.length !== 5 || !keys.includes(WEITERE_KEY)) {
        return eingabeFehler(
          `choice braucht IMMER genau 5 Optionen: 4 echte plus der Schluessel "${WEITERE_KEY}" ("keine der vier passt gut genug") ` +
          `(bekommen: ${keys.length}${keys.includes(WEITERE_KEY) ? '' : `, ohne "${WEITERE_KEY}"`}). Die Beschreibung von "${WEITERE_KEY}" setzt der Server. ` +
          'Abschluss ohne "weitere": letzte_runde:true mit 2 bis 5 echten Optionen.',
        );
      }
      // 3. Die Grenzrunde ist die letzte
      if (!letzteRunde && runde === maxRunden()) {
        return eingabeFehler(`Runde ${runde} ist die Grenzrunde (max. ${maxRunden()} Runden): jetzt nur noch mit letzte_runde:true fragen (2 bis 5 echte Optionen, ohne "${WEITERE_KEY}").`);
      }
      // 4. Verworfenes darf nicht wiederkommen
      if (verworfen.length > 0) {
        const alteKeys = new Set(verworfen.map((v) => v.key.toLowerCase()));
        const alteTexte = new Set(verworfen.map((v) => normalisiere(v.beschreibung)).filter(Boolean));
        const wieder = echte.filter((k) => alteKeys.has(k.toLowerCase()) || alteTexte.has(normalisiere(roh![k])));
        if (wieder.length > 0) {
          return eingabeFehler(`Diese Optionen wurden in frueheren Runden schon verworfen: ${wieder.map((k) => `"${k}"`).join(', ')}. Erarbeite NEUE Optionen mit anderen Schluesseln und anderem Inhalt.`);
        }
      }
      criteria = Object.fromEntries(echte.map((k) => [k, kurz(roh![k], 300) || k]));
      if (!letzteRunde) criteria[WEITERE_KEY] = WEITERE_BESCHREIBUNG;
    } else if (roh && Object.keys(roh).length > 0) {
      const keys = Object.keys(roh);
      if (keys.length < 2 || keys.length > 10 || !keys.every((k) => /^\d+$/.test(k))) {
        return fehler('score: optionen nur als Zahlenlabels {"1": Anker, ...} (2 bis 10 Stufen) oder weglassen (Standard 1..5).');
      }
      criteria = Object.fromEntries(keys.map((k) => [k, kurz(roh[k], 300) || k]));
    } else {
      criteria = { '1': 'lowest / strongly no', '2': 'low', '3': 'medium', '4': 'high', '5': 'highest / strongly yes' };
    }
  }
  const task_id = typeof anfrage.task_id === 'string' && anfrage.task_id.trim() ? anfrage.task_id.trim() : null;
  const basis = { agent, task_id, kategorie, frage, typ, optionen: criteria ?? null, runde, erste_id: ersteId, offen_fuer_user: false, blocker: false };

  try {
    // --- Schalter: aus = nichts kostet etwas, nichts wird protokolliert -------
    const stand = await leseAbwesenheit(project);
    if (!stand.aktiv) {
      return {
        success: true,
        entschieden: false,
        grund: 'schalter_aus',
        message: `User da (Schalter aus) — ${FRAGE_NEU}. Jev entscheidet nur bei aktivem Schalter.`,
        schalter: stand,
      };
    }
    const schalter = { aktiv: true, seit: stand.seit, gesetzt_von: stand.gesetzt_von };
    const abgelehnt = async (grund: string, message: string, jev_aufruf = false, confidence: number | null = null, wahl: unknown = null) => {
      const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence, entschieden: false, grund, jev_aufruf });
      return { success: true, entschieden: false, grund, message: `${message} ${FRAGE_NEU}.`, protokoll_id, schalter, ...(confidence !== null ? { confidence } : {}) };
    };
    /** Ende der Kette: OFFENE FRAGE fuer den User (a) bzw. Einsprung des Koordinators (b, blocker:true) */
    const offeneFrage = async (grund: string, message: string, jev_aufruf: boolean, confidence: number | null = null, wahl: unknown = null) => {
      const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence, entschieden: false, grund, jev_aufruf, offen_fuer_user: true, blocker });
      return {
        success: true,
        entschieden: false,
        grund,
        message: `${message} Die Frage steht als OFFENE FRAGE fuer den User im Protokoll${blocker ? ' (Blocker: Koordinator einbeziehen)' : ''}.`,
        offen_fuer_user: true,
        blocker,
        naechster_schritt: blocker ? SCHRITT_BLOCKER : SCHRITT_OFFEN,
        runde,
        protokoll_id,
        erste_id: ersteId ?? protokoll_id,
        schalter,
        ...(confidence !== null ? { confidence } : {}),
      };
    };

    // --- Leitplanken ------------------------------------------------------------
    if ((VERBOTENE_KATEGORIEN as readonly string[]).includes(kategorie)) {
      return abgelehnt('kategorie_verboten', `Kategorie "${kategorie}" gehoert dem User, Jev entscheidet sie nie (verboten: ${VERBOTENE_KATEGORIEN.join(', ')}).`);
    }
    if (!(ERLAUBTE_KATEGORIEN as readonly string[]).includes(kategorie)) {
      return abgelehnt('kategorie_unbekannt', `Unbekannte Kategorie "${kategorie}". Erlaubt: ${ERLAUBTE_KATEGORIEN.join(', ')}.`);
    }

    // --- Kette (JEV-12) ---------------------------------------------------------------
    if (ersteId !== null && runde > 1) {
      const { rows: vorhanden } = await getPool().query(
        `SELECT id FROM jev_entscheidungen WHERE project = $1 AND id = $2`,
        [project, ersteId],
      );
      if (vorhanden.length === 0) {
        return eingabeFehler(`erste_id ${ersteId} gibt es im Protokoll dieses Projekts nicht — nimm die protokoll_id der Antwort auf die erste Frage der Kette.`);
      }
    }
    if (keinePlausible) {
      return offeneFrage('keine_plausible_option', 'Dem Agenten faellt keine plausible Option (mehr) ein.', false);
    }
    if (typ === 'choice' && runde > maxRunden()) {
      return offeneFrage('max_runden', `Rundengrenze erreicht (${maxRunden()} Runden, runde ${runde}) — kein weiterer Jev-Aufruf.`, false);
    }

    // --- Ratenbremse ---------------------------------------------------------------
    const limit = zahlAusEnv('JEV_ENTSCHEIDUNG_RATE') ?? STANDARD_RATE_PRO_STUNDE;
    const { rows: zaehl } = await getPool().query(
      `SELECT count(*)::int AS n FROM jev_entscheidungen WHERE project = $1 AND jev_aufruf = true AND zeit > NOW() - INTERVAL '1 hour'`,
      [project],
    );
    const n = zaehl.length > 0 ? Number((zaehl[0] as { n: number }).n) : 0;
    if (n >= limit) {
      return abgelehnt('rate_limit', `Ratenbremse: ${n} Jev-Entscheidungsaufrufe in der letzten Stunde (Grenze ${limit}).`);
    }

    // --- Jev -----------------------------------------------------------------------------
    const key = process.env.JEV_OPENROUTER_API_KEY?.trim() ?? '';
    if (!key) {
      return abgelehnt('kein_key', 'Jev nicht konfiguriert (JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses).');
    }
    const url = process.env.JEV_API_URL?.trim() || JEV_STANDARD_URL;
    const modell = process.env.JEV_MODELL?.trim() || JEV_STANDARD_MODELL;
    const timeoutMs = zahlAusEnv('JEV_TIMEOUT_MS') ?? STANDARD_TIMEOUT_MS;
    const torRoh = typeof anfrage.confidence_tor === 'number' ? anfrage.confidence_tor : zahlAusEnv('JEV_ENTSCHEIDUNG_TOR');
    const tor = torRoh !== undefined && torRoh >= 0 && torRoh <= 1 ? torRoh : STANDARD_ENTSCHEIDUNG_TOR;
    const hinweise = kurz(anfrage.hinweise, MAX_HINWEISE);
    const hinweisSuffix = hinweise ? ' Take the notes in state.hinweise into account.' : '';
    const verworfenSuffix = verworfen.length > 0
      ? ' The options listed in state.verworfen were already rejected in earlier rounds; do not prefer them.'
      : '';
    const weitereSuffix = typ === 'choice' && !letzteRunde
      ? ` The option "${WEITERE_KEY}" means none of the other options fits well enough; choose it only when that is truly the case.`
      : '';

    const state: Record<string, unknown> = {
      project,
      kategorie,
      frage,
      kontext: kurz(anfrage.kontext, MAX_KONTEXT),
      ...(hinweise ? { hinweise } : {}),
      ...(typ === 'choice' ? { runde } : {}),
      ...(verworfen.length > 0 ? { verworfen } : {}),
    };
    const grundText =
      'The user is away. Decide the question in state.frage using state.kontext. ' +
      'It is a reversible decision of the category in state.kategorie; when the options are close, prefer the one that is easiest to undo.' +
      hinweisSuffix + verworfenSuffix + weitereSuffix;
    const question: Record<string, unknown> =
      typ === 'noul'
        ? { type: 'noul', instructions: `${grundText} Give the probability that the answer is yes.` }
        : { type: 'choice', instructions: grundText, criteria };

    const f = deps.fetch ?? fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let antwort: Response;
    try {
      antwort = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: modell, state, questions: { entscheidung: question } }),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = ctrl.signal.aborted
        ? `Jev-Timeout nach ${timeoutMs} ms.`
        : ohneKey(`Jev nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`, key);
      const protokoll_id = await protokolliere(project, { ...basis, wahl: null, confidence: null, entschieden: false, grund: 'jev_fehler', jev_aufruf: true });
      return { success: false, entschieden: false, grund: 'jev_fehler', message: `${msg} ${FRAGE_NEU}.`, protokoll_id, schalter };
    } finally {
      clearTimeout(timer);
    }
    if (!antwort.ok) {
      const text = await antwort.text().catch(() => '');
      const protokoll_id = await protokolliere(project, { ...basis, wahl: null, confidence: null, entschieden: false, grund: 'jev_fehler', jev_aufruf: true });
      return {
        success: false, entschieden: false, grund: 'jev_fehler', protokoll_id, schalter,
        message: `${ohneKey(`Jev-Fehler HTTP ${antwort.status}: ${kurz(text, 300)}`, key)} ${FRAGE_NEU}.`,
      };
    }
    const daten = (await antwort.json()) as { answers?: Record<string, { choice?: string; confidence?: number; noul?: number }> };
    const a = daten.answers?.entscheidung;

    if (typ === 'noul') {
      const p = typeof a?.noul === 'number' && a.noul >= 0 && a.noul <= 1 ? a.noul : null;
      if (p === null) return abgelehnt('ungueltige_antwort', 'Jev lieferte keine gueltige Wahrscheinlichkeit.', true);
      const confidence = Math.round(Math.max(p, 1 - p) * 1000) / 1000;
      if (p >= tor || p <= 1 - tor) {
        const wahl = p >= tor ? 'ja' : 'nein';
        const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence, entschieden: true, grund: null, jev_aufruf: true });
        return { success: true, entschieden: true, wahl, confidence, tor, kennzeichnung: kennzeichnung(confidence), protokoll_id, schalter };
      }
      return { ...(await abgelehnt('unsicher', `Jev ist unsicher (p=${p}, Tor ${tor}).`, true, confidence)), tor, tipp: TIPP_UNSICHER };
    }

    const gewaehlt = typeof a?.choice === 'string' ? a.choice : '';
    const conf = typeof a?.confidence === 'number' ? a.confidence : null;
    if (!gewaehlt || !criteria || !(gewaehlt in criteria) || conf === null) {
      return abgelehnt('ungueltige_antwort', 'Jev lieferte keine gueltige Wahl.', true);
    }
    const wahl: string | number = typ === 'score' ? Number(gewaehlt) : gewaehlt;
    if (conf >= tor) {
      if (typ === 'choice' && gewaehlt === WEITERE_KEY) {
        // Keine Entscheidung: die naechste Runde mit 4 neuen Optionen
        const protokoll_id = await protokolliere(project, { ...basis, wahl: WEITERE_KEY, confidence: conf, entschieden: false, grund: 'weitere', jev_aufruf: true });
        const kette = ersteId ?? protokoll_id;
        return {
          success: true, entschieden: false, weiter: true, runde, gewaehlt: WEITERE_KEY, confidence: conf, tor,
          naechster_schritt: schrittWeiter(runde + 1, kette), protokoll_id, erste_id: kette, schalter,
        };
      }
      const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence: conf, entschieden: true, grund: null, jev_aufruf: true });
      return {
        success: true, entschieden: true, wahl, wahl_beschreibung: criteria[gewaehlt], confidence: conf, tor,
        kennzeichnung: kennzeichnung(conf), protokoll_id, schalter,
        ...(typ === 'choice' ? { runde, erste_id: ersteId ?? protokoll_id } : {}),
      };
    }
    if (typ === 'choice' && letzteRunde) {
      // Letzte Runde ohne 'weitere' bleibt unsicher: offene Frage fuer den User
      return { ...(await offeneFrage('unsicher', `Jev ist auch in der letzten Runde unsicher (Confidence ${conf}, Tor ${tor}).`, true, conf, wahl)), tor, tipp: TIPP_UNSICHER };
    }
    return { ...(await abgelehnt('unsicher', `Jev ist unsicher (Confidence ${conf}, Tor ${tor}).`, true, conf, wahl)), tor, tipp: TIPP_UNSICHER };
  } catch (err) {
    return fehler(ohneKey(`Entscheidung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, process.env.JEV_OPENROUTER_API_KEY?.trim() ?? ''));
  }
}


// ---------------------------------------------------------------------------
// Protokoll + ueberstimmen
// ---------------------------------------------------------------------------

export interface ProtokollKette {
  /** Protokoll-Nummer der ersten Frage der Kette */
  erste_id: number;
  frage: unknown;
  task_id: unknown;
  runden: number;
  offen_fuer_user: boolean;
  blocker: boolean;
  eintraege: Array<Record<string, unknown>>;
}

/** Gruppiert Protokollzeilen zu Ketten (erste_id, sonst die eigene id), Runden aufsteigend, Ketten nach erster Frage */
function baueKetten(eintraege: Array<Record<string, unknown>>): ProtokollKette[] {
  const map = new Map<number, Array<Record<string, unknown>>>();
  for (const e of eintraege) {
    const k = Number(e.erste_id ?? e.id);
    const liste = map.get(k) ?? [];
    liste.push(e);
    map.set(k, liste);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([erste_id, zeilen]) => {
      const sortiert = [...zeilen].sort((a, b) => Number(a.runde ?? 1) - Number(b.runde ?? 1) || Number(a.id) - Number(b.id));
      const erste = sortiert[0];
      return {
        erste_id,
        frage: erste.frage,
        task_id: erste.task_id ?? sortiert.find((z) => z.task_id)?.task_id ?? null,
        runden: sortiert.length,
        offen_fuer_user: sortiert.some((z) => z.offen_fuer_user === true),
        blocker: sortiert.some((z) => z.blocker === true),
        eintraege: sortiert,
      };
    });
}

export interface ProtokollOptionen {
  /** Standard: Beginn des Schalters (sonst die letzten 24 h) */
  seit?: Date | string;
  nur_entschieden?: boolean;
  limit?: number;
}

export async function holeEntscheidungsProtokoll(
  project: string,
  opt: ProtokollOptionen = {},
): Promise<{
  success: boolean;
  message?: string;
  seit?: Date | string;
  anzahl?: number;
  eintraege?: Array<Record<string, unknown>>;
  /** JEV-12: zusammenhaengende Ketten (nach erster Frage sortiert, Runden aufsteigend) */
  ketten?: ProtokollKette[];
  /** JEV-12: Ketten, die als OFFENE FRAGE fuer den User enden — beim 'bin wieder da' oben */
  offene_fragen?: ProtokollKette[];
}> {
  try {
    let seit: Date | string | undefined = opt.seit;
    if (!seit) {
      const stand = await leseAbwesenheit(project);
      seit = stand.seit ?? new Date(Date.now() - 24 * 3_600_000);
    }
    const limit = Math.min(Math.max(Math.floor(opt.limit ?? 50), 1), 200);
    const { rows } = await getPool().query(
      `SELECT id, zeit, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, runde, erste_id, offen_fuer_user, blocker, ueberstimmt_von, ueberstimmt_wahl, ueberstimmt_notiz
         FROM jev_entscheidungen
        WHERE project = $1 AND zeit >= $2${opt.nur_entschieden ? ' AND entschieden = true' : ''}
        ORDER BY zeit DESC, id DESC LIMIT $3`,
      [project, seit, limit],
    );
    const eintraege = rows as Array<Record<string, unknown>>;
    const ketten = baueKetten(eintraege);
    return { success: true, seit, anzahl: rows.length, eintraege, ketten, offene_fragen: ketten.filter((k) => k.offen_fuer_user) };
  } catch (err) {
    return { success: false, message: `Protokoll nicht lesbar: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface UeberstimmenOptionen {
  id?: number | string;
  wahl?: unknown;
  notiz?: string;
  agent_id?: string;
}

/** Nur der Koordinator: markiert eine Jev-Entscheidung als ueberstimmt. Korrekturen als Memory schreibt er selbst. */
export async function ueberstimmeEntscheidung(
  project: string,
  opt: UeberstimmenOptionen = {},
): Promise<Record<string, unknown>> {
  const wer = typeof opt.agent_id === 'string' ? opt.agent_id.trim() : '';
  if (!KOORDINATOR.test(wer)) {
    return { success: false, message: 'Ueberstimmen darf nur der Koordinator (agent_id koordinator/coordinator).' };
  }
  const id = Number(opt.id);
  if (!Number.isInteger(id) || id <= 0) return { success: false, message: 'id (Protokoll-Nummer) ist Pflicht.' };
  if (opt.wahl === undefined || opt.wahl === null || opt.wahl === '') return { success: false, message: 'wahl (die richtige Entscheidung) ist Pflicht.' };
  try {
    const { rows } = await getPool().query(
      `UPDATE jev_entscheidungen SET ueberstimmt_von = $3, ueberstimmt_wahl = $4::jsonb, ueberstimmt_notiz = $5, ueberstimmt_am = NOW()
        WHERE project = $1 AND id = $2 RETURNING id`,
      [project, id, wer, JSON.stringify(opt.wahl), kurz(opt.notiz, 500) || null],
    );
    if (rows.length === 0) return { success: false, message: `Kein Protokolleintrag ${id} in Projekt ${project}.` };
    return { success: true, id, message: `Eintrag ${id} als ueberstimmt markiert. Korrektur ggf. als jev-erkenntnis-Memory festhalten.` };
  } catch (err) {
    return { success: false, message: `Ueberstimmen fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
}
