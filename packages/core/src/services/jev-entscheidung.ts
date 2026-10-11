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
 *
 * P15 E1 ENTSCHEIDUNGS-TOPF (Konzept 6591b268, User e7b013c2, E0 bfbf7968; Modul entscheidungstopf.ts):
 *   Bei aktiver Jev-Funktion 'entscheidungstopf' laeuft VOR der Optionswahl ein Praezedenz-Schritt: Kandidaten
 *   per Embedding (Top 6), EIN Jev-Aufruf mit praezedenz (choice + 'keine', Tor 0,8 JEV_ENTSCHEIDUNGSTOPF_TOR) und
 *   irreversibel (noul, S2b, Schwelle 0,3 JEV_IRREVERSIBEL_SCHWELLE). Mit Praezedenz bekommt die Optionswahl
 *   state.praezedenz; BEIDE Tore muessen halten. Ohne Praezedenz waehlt Jev laut User trotzdem (Option
 *   entscheidung_ohne_praezedenz, Standard an), markiert als ohne_praezedenz und bei der Durchsicht zuerst.
 *   SICHERHEIT: S1 Kategorien (+ live_db, schema), S2 Text-Scan (immer), S2b (im Topf-Schritt), S3 autonome
 *   Entscheidungen werden nie Topf-Eintrag. Topf nicht lesbar -> alter Weg (JEV-10).
 *   DURCHSICHT: durchsichtEntscheidung (ok | korrigieren -> neuer Topf-Eintrag herkunft korrektur).
 *   ABWESEND: project '*' = User fuer alle Projekte weg.
 */

import { getPool } from '../db/client.js';
import { rufeJev } from './jev-client.js';
import { jevWirksam, type JevWirkung } from './jev-schalter.js';
import { leseJevOptionen, type JevSprache } from './jev-optionen.js';
import {
  holeTopfKandidaten, scanneSicherheitText, topfKriterium, topfPraezedenzState, zaehleTopf, schreibeTopfEintrag,
  legeEntscheidungAb, bereiteEntscheidungAuf, listeEntscheidungstopf, IRREVERSIBEL_FRAGE, STANDARD_TOPF_TOR,
  STANDARD_IRREVERSIBEL_SCHWELLE, TOPF_STATUS, type TopfEintrag, type TopfEmbedFn,
} from './entscheidungstopf.js';

export const ERLAUBTE_KATEGORIEN = ['variante', 'reihenfolge', 'umsetzungsweg', 'formulierung'] as const;
export const VERBOTENE_KATEGORIEN = ['loeschen', 'deploy', 'git', 'secrets', 'aussenwirkung', 'kosten', 'regeln', 'live_db', 'schema'] as const;
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
const MAX_FRAGE = 500;
const MAX_KONTEXT = 1500;
const MAX_HINWEISE = 500;
const KOORDINATOR = /^(koordinator|coordinator)$/i;
/** P15 E1: Durchsicht und Topf-Pflege duerfen Koordinator und User (Namenstreue) */
const DARF_DURCHSICHT = /^(koordinator|coordinator|user)$/i;
const FRAGE_NEU = 'User/Koordinator fragen';
/** P15 E1: Anweisung fuer die Praezedenz-Wahl (Wortlaut wie E0 gemessen) */
const INSTR_PRAEZEDENZ = 'An agent asks the question in state.frage (context in state.kontext, options in state.optionen) while the user is away. ' +
  'Choose the earlier decision of the user that governs this question, i.e. whose "applies when" condition clearly matches this situation. ' +
  'Choose "keine" unless one earlier decision clearly applies.';
const PRAEZEDENZ_SUFFIX = ' state.praezedenz is an earlier decision of the user on a similar question; decide as the user decided there.';
const PRAEZEDENZ_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
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
  /** P15-T33 E0.5: Jev ist fuer das Projekt abgeschaltet (Schalter/Budget) - der gespeicherte Schalter wirkt dann nicht */
  jev_aus?: string;
  /** P15 E1: der Schalter kommt aus project '*' (User fuer alle Projekte abwesend) */
  alle_projekte?: boolean;
}

export interface EntscheidungsDeps {
  fetch?: typeof fetch;
  /** P15 E1: Embedding fuer die Topf-Kandidaten (Test: Mock) */
  embed?: TopfEmbedFn;
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
  type Zeile = { aktiv: boolean; seit: Date | null; bis: Date | null; gesetzt_von: string | null };
  const lies = async (p: string): Promise<Zeile | undefined> => {
    const { rows } = await getPool().query(`SELECT aktiv, seit, bis, gesetzt_von FROM jev_entscheidet WHERE project = $1`, [p]);
    return rows[0] as Zeile | undefined;
  };
  const istAn = (x: Zeile | undefined): boolean =>
    !!x && x.aktiv && !(x.bis !== null && x.bis !== undefined && new Date(x.bis).getTime() <= Date.now());
  const eigen = await lies(project);
  // P15 E1: project '*' = User fuer ALLE Projekte abwesend; wirkt zusaetzlich zum eigenen Schalter.
  let alle: Zeile | undefined;
  if (project !== '*' && !istAn(eigen)) {
    try { alle = await lies('*'); } catch { alle = undefined; }
  }
  const z = istAn(eigen) ? eigen : istAn(alle) ? alle : eigen;
  if (!z) return { aktiv: false };
  const abgelaufen = z.aktiv && z.bis !== null && z.bis !== undefined && new Date(z.bis).getTime() <= Date.now();
  // P15-T33 E0.5: ist Jev (tool/entscheidung) fuer das Projekt aus, entscheidet Jev nicht - alle
  // Hinweise, die an aktiv haengen (jev_modus, jev_hinweis, jev_entscheidet), verschwinden damit.
  let jevAus: JevWirkung | undefined;
  if (z.aktiv && !abgelaufen) {
    for (const f of ['tool', 'entscheidung'] as const) {
      const w = await jevWirksam(project, f);
      if (!w.an) { jevAus = w; break; }
    }
  }
  return {
    aktiv: z.aktiv && !abgelaufen && !jevAus,
    seit: z.seit,
    bis: z.bis,
    gesetzt_von: z.gesetzt_von,
    ...(abgelaufen ? { abgelaufen: true } : {}),
    ...(jevAus ? { jev_aus: jevAus.text ?? 'Jev ist abgeschaltet.' } : {}),
    ...(z === alle && z !== eigen ? { alle_projekte: true } : {}),
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
    // P15 E1: '*' aus = User ist fuer alle Projekte wieder da (alle Schalter aus)
    await getPool().query(
      `UPDATE jev_entscheidet SET aktiv = false, bis = NULL, gesetzt_von = $2, updated_at = NOW() WHERE project = $1 OR ($1 = '*' AND aktiv)`,
      [project, wer],
    );
    return {
      success: true,
      schalter: await leseAbwesenheit(project),
      protokoll: protokoll.eintraege ?? [],
      offene_fragen: protokoll.offene_fragen ?? [],
      durchsicht_offen: protokoll.durchsicht_offen ?? [],
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
    const stand = await leseAbwesenheit(project);
    if (stand.aktiv) return hinweisText(stand);
    // P15-T33 E0.5: eine Budget-Pause meldet sich im Onboarding (statt still zu verschwinden); ein
    // ausdruecklich abgeschalteter Jev (global/Projekt) bleibt dagegen ganz ohne Hinweis.
    const w = await jevWirksam(project, 'entscheidung');
    if (!w.an && w.ebene === 'budget') return w.text;
    return undefined;
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
  /** P15 E1: gewaehlte Praezedenz aus dem Topf (beide Tore gehalten) */
  praezedenz_id?: string | null;
  praezedenz_confidence?: number | null;
  /** P15 E1: Jev hat ohne Praezedenz entschieden (Durchsicht zuerst) */
  ohne_praezedenz?: boolean;
  /** P15 E1 S2b: Jevs Wahrscheinlichkeit fuer eine irreversible/externe Aktion */
  irreversibel_p?: number | null;
}

async function protokolliere(project: string, e: LogEintrag): Promise<number | null> {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO jev_entscheidungen
         (project, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, jev_aufruf,
          runde, erste_id, offen_fuer_user, blocker, praezedenz_id, praezedenz_confidence, ohne_praezedenz, irreversibel_p)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id, zeit`,
      [
        project, e.agent, e.task_id, e.kategorie, e.frage, e.typ,
        e.optionen === null || e.optionen === undefined ? null : JSON.stringify(e.optionen),
        e.wahl === null || e.wahl === undefined ? null : JSON.stringify(e.wahl),
        e.confidence, e.entschieden, e.grund, e.jev_aufruf,
        e.runde, e.erste_id, e.offen_fuer_user, e.blocker,
        e.praezedenz_id ?? null, e.praezedenz_confidence ?? null, e.ohne_praezedenz === true, e.irreversibel_p ?? null,
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
  const basis: Omit<LogEintrag, 'wahl' | 'confidence' | 'entschieden' | 'grund' | 'jev_aufruf'> = {
    agent, task_id, kategorie, frage, typ, optionen: criteria ?? null, runde, erste_id: ersteId, offen_fuer_user: false, blocker: false,
  };

  try {
    // --- P15-T33 E0.5: Jev abgeschaltet (Schalter/Budget) = kein Aufruf, kein Protokoll --------
    const jevW = await jevWirksam(project, 'entscheidung');
    if (!jevW.an) {
      return { success: true, entschieden: false, grund: 'jev_aus', message: `${jevW.text ?? 'Jev ist abgeschaltet.'} ${FRAGE_NEU}.`, jev_aus: jevW };
    }
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

    // --- P15 E1 S2: Text-Scan (die Kategorie ist nur Selbstauskunft des Agenten) ---------------
    const echteOptionen = criteria ? Object.entries(criteria).filter(([k]) => k !== WEITERE_KEY).map(([, t]) => t) : [];
    const treffer = scanneSicherheitText(frage, anfrage.kontext, anfrage.hinweise, ...echteOptionen);
    if (treffer.length > 0) {
      return {
        ...(await abgelehnt('sicherheit_text', `Text-Scan: ${treffer.join(', ')}. Solche Entscheidungen (Deploy, Push, Loeschen, Live-DB, Schema, Secrets, Kosten, Aussenwirkung, Regeln) trifft Jev nie autonom.`)),
        treffer,
      };
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
    if (!process.env.JEV_OPENROUTER_API_KEY?.trim()) {
      return abgelehnt('kein_key', 'Jev nicht konfiguriert (JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses).');
    }
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

    // --- P15 E1: Praezedenz-Schritt (Entscheidungs-Topf) -----------------------------------
    let praez: { eintrag: TopfEintrag; confidence: number; sprache: JevSprache } | null = null;
    let ohnePraezedenz = false;
    if ((await jevWirksam(project, 'entscheidungstopf')).an) {
      let kand: Awaited<ReturnType<typeof holeTopfKandidaten>> | null = null;
      try {
        kand = await holeTopfKandidaten(`${frage}\n${kurz(anfrage.kontext, MAX_KONTEXT)}`, { erlaubte: ERLAUBTE_KATEGORIEN }, { embed: deps.embed });
      } catch {
        kand = null; // Topf nicht lesbar (z. B. Tabelle fehlt): alter Weg wie JEV-10
      }
      if (kand) {
        const jevOpt = await leseJevOptionen();
        const sprache = jevOpt.jev_sprache_wirksam;
        const fragen: Record<string, unknown> = { irreversibel: { type: 'noul', instructions: IRREVERSIBEL_FRAGE } };
        if (kand.kandidaten.length > 0) {
          const pk: Record<string, string> = {};
          kand.kandidaten.forEach((k, i) => { pk[PRAEZEDENZ_KEYS[i]] = topfKriterium(k.eintrag, sprache) || `earlier decision ${i + 1}`; });
          pk.keine = 'None of the listed earlier decisions governs this question.';
          fragen.praezedenz = { type: 'choice', instructions: INSTR_PRAEZEDENZ, criteria: pk };
        }
        const st1 = {
          kategorie, frage, kontext: kurz(anfrage.kontext, MAX_KONTEXT),
          optionen: criteria ? Object.fromEntries(Object.entries(criteria).filter(([k]) => k !== WEITERE_KEY)) : null,
        };
        const j1 = await rufeJev({ funktion: 'entscheidungstopf', project, agent_id: agent, state: st1, questions: fragen }, { fetch: deps.fetch });
        if (!j1.ok) {
          if (j1.grund === 'aus' || j1.grund === 'budget') {
            return { success: true, entschieden: false, grund: 'jev_aus', message: `${j1.message} ${FRAGE_NEU}.`, jev_aus: j1.wirkung, schalter };
          }
          if (j1.grund === 'kein_key') return abgelehnt('kein_key', 'Jev nicht konfiguriert (JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses).');
          const protokoll_id = await protokolliere(project, { ...basis, wahl: null, confidence: null, entschieden: false, grund: 'jev_fehler', jev_aufruf: true });
          return { success: false, entschieden: false, grund: 'jev_fehler', message: `${j1.message} ${FRAGE_NEU}.`, protokoll_id, schalter };
        }
        const ant = (j1.daten as { answers?: Record<string, { choice?: unknown; confidence?: unknown; noul?: unknown }> }).answers ?? {};
        const pIrr = typeof ant.irreversibel?.noul === 'number' && ant.irreversibel.noul >= 0 && ant.irreversibel.noul <= 1 ? ant.irreversibel.noul : null;
        basis.irreversibel_p = pIrr;
        const schwelleRoh = zahlAusEnv('JEV_IRREVERSIBEL_SCHWELLE');
        const schwelle = schwelleRoh !== undefined && schwelleRoh > 0 && schwelleRoh <= 1 ? schwelleRoh : STANDARD_IRREVERSIBEL_SCHWELLE;
        if (pIrr === null) {
          return abgelehnt('sicherheit_unklar', 'Jev lieferte keine gueltige Einschaetzung, ob die Antwort eine irreversible oder externe Aktion ausloest - ohne sie entscheidet Jev nicht.', true);
        }
        if (pIrr >= schwelle) {
          return {
            ...(await abgelehnt('sicherheit_irreversibel', `Jev haelt eine irreversible oder externe Aktion fuer moeglich (p=${pIrr}, Schwelle ${schwelle}) - das entscheidet nie Jev.`, true)),
            irreversibel_p: pIrr,
          };
        }
        const pa = ant.praezedenz;
        const pc = typeof pa?.confidence === 'number' ? pa.confidence : null;
        const idx = typeof pa?.choice === 'string' ? PRAEZEDENZ_KEYS.indexOf(pa.choice) : -1;
        const topfTorRoh = zahlAusEnv('JEV_ENTSCHEIDUNGSTOPF_TOR');
        const topfTor = topfTorRoh !== undefined && topfTorRoh >= 0 && topfTorRoh <= 1 ? topfTorRoh : STANDARD_TOPF_TOR;
        if (idx >= 0 && idx < kand.kandidaten.length && pc !== null && pc >= topfTor) {
          praez = { eintrag: kand.kandidaten[idx].eintrag, confidence: pc, sprache };
          basis.praezedenz_id = praez.eintrag.id;
          basis.praezedenz_confidence = pc;
        } else if (!jevOpt.entscheidung_ohne_praezedenz) {
          return offeneFrage(
            'keine_praezedenz',
            `Keine passende User-Entscheidung im Topf (${kand.kandidaten.length} Kandidaten, Praezedenz-Tor ${topfTor}) und die Jev-Option entscheidung_ohne_praezedenz ist aus.`,
            true, pc,
          );
        } else {
          ohnePraezedenz = true;
          basis.ohne_praezedenz = true;
        }
      }
    }
    const praezedenzName = praez ? (praez.eintrag.kennung ?? praez.eintrag.id.slice(0, 8)) : '';
    const kennz = (c: number): string => praez
      ? `${kennzeichnung(c)}; wie User-Entscheidung ${praezedenzName} (Praezedenz-Confidence ${praez.confidence})`
      : ohnePraezedenz ? `${kennzeichnung(c)}; OHNE Praezedenz aus dem Topf (bei der Durchsicht zuerst)` : kennzeichnung(c);
    const topfFelder = async (): Promise<Record<string, unknown>> => {
      if (praez) {
        await zaehleTopf(praez.eintrag.id, 'gewaehlt_n');
        return {
          praezedenz: {
            id: praez.eintrag.id, kennung: praez.eintrag.kennung, confidence: praez.confidence,
            entscheidung: praez.eintrag.aufbereitet_de?.entscheidung ?? praez.eintrag.aufbereitet_en?.decision ?? null,
          },
        };
      }
      return ohnePraezedenz ? { ohne_praezedenz: true, hinweis_durchsicht: 'Ohne Praezedenz entschieden: erscheint bei jev(durchsicht) zuerst.' } : {};
    };

    const state: Record<string, unknown> = {
      project,
      kategorie,
      frage,
      kontext: kurz(anfrage.kontext, MAX_KONTEXT),
      ...(hinweise ? { hinweise } : {}),
      ...(typ === 'choice' ? { runde } : {}),
      ...(verworfen.length > 0 ? { verworfen } : {}),
      ...(praez ? { praezedenz: topfPraezedenzState(praez.eintrag, praez.sprache) } : {}),
    };
    const grundText =
      'The user is away. Decide the question in state.frage using state.kontext. ' +
      'It is a reversible decision of the category in state.kategorie; when the options are close, prefer the one that is easiest to undo.' +
      hinweisSuffix + verworfenSuffix + weitereSuffix + (praez ? PRAEZEDENZ_SUFFIX : '');
    const question: Record<string, unknown> =
      typ === 'noul'
        ? { type: 'noul', instructions: `${grundText} Give the probability that the answer is yes.` }
        : { type: 'choice', instructions: grundText, criteria };

    // P15-T33 E0.5: einziger Jev-Aufruf ueber den gemeinsamen Client (Schalter, Budget, Kosten).
    const jr = await rufeJev({ funktion: 'entscheidung', project, agent_id: agent, state, questions: { entscheidung: question } }, { fetch: deps.fetch });
    if (!jr.ok) {
      if (jr.grund === 'aus' || jr.grund === 'budget') {
        return { success: true, entschieden: false, grund: 'jev_aus', message: `${jr.message} ${FRAGE_NEU}.`, jev_aus: jr.wirkung, schalter };
      }
      if (jr.grund === 'kein_key') {
        return abgelehnt('kein_key', 'Jev nicht konfiguriert (JEV_OPENROUTER_API_KEY fehlt in der Umgebung dieses Prozesses).');
      }
      const msg = jr.grund === 'timeout' ? `${jr.message}.` : jr.message;
      const protokoll_id = await protokolliere(project, { ...basis, wahl: null, confidence: null, entschieden: false, grund: 'jev_fehler', jev_aufruf: true });
      return { success: false, entschieden: false, grund: 'jev_fehler', message: `${msg} ${FRAGE_NEU}.`, protokoll_id, schalter };
    }
    const daten = jr.daten as { answers?: Record<string, { choice?: string; confidence?: number; noul?: number }> };
    const a = daten.answers?.entscheidung;

    if (typ === 'noul') {
      const p = typeof a?.noul === 'number' && a.noul >= 0 && a.noul <= 1 ? a.noul : null;
      if (p === null) return abgelehnt('ungueltige_antwort', 'Jev lieferte keine gueltige Wahrscheinlichkeit.', true);
      const confidence = Math.round(Math.max(p, 1 - p) * 1000) / 1000;
      if (p >= tor || p <= 1 - tor) {
        const wahl = p >= tor ? 'ja' : 'nein';
        const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence, entschieden: true, grund: null, jev_aufruf: true });
        return { success: true, entschieden: true, wahl, confidence, tor, kennzeichnung: kennz(confidence), protokoll_id, schalter, ...(await topfFelder()) };
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
        kennzeichnung: kennz(conf), protokoll_id, schalter,
        ...(typ === 'choice' ? { runde, erste_id: ersteId ?? protokoll_id } : {}),
        ...(await topfFelder()),
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
  /** P15 E1: autonome Entscheidungen ohne Durchsicht; ohne Praezedenz zuerst */
  durchsicht_offen?: Array<Record<string, unknown>>;
}> {
  try {
    let seit: Date | string | undefined = opt.seit;
    if (!seit) {
      const stand = await leseAbwesenheit(project);
      seit = stand.seit ?? new Date(Date.now() - 24 * 3_600_000);
    }
    const limit = Math.min(Math.max(Math.floor(opt.limit ?? 50), 1), 200);
    // P15 E1: project '*' = alle Projekte; Spalten fuer Praezedenz und Durchsicht
    const { rows } = await getPool().query(
      `SELECT id, zeit, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, runde, erste_id, offen_fuer_user, blocker, ueberstimmt_von, ueberstimmt_wahl, ueberstimmt_notiz,
              project, praezedenz_id, praezedenz_confidence, ohne_praezedenz, irreversibel_p, durchsicht, durchsicht_am, durchsicht_von
         FROM jev_entscheidungen
        WHERE ($1 = '*' OR project = $1) AND zeit >= $2${opt.nur_entschieden ? ' AND entschieden = true' : ''}
        ORDER BY zeit DESC, id DESC LIMIT $3`,
      [project, seit, limit],
    );
    const eintraege = rows as Array<Record<string, unknown>>;
    const ketten = baueKetten(eintraege);
    const durchsicht_offen = eintraege
      .filter((e) => e.entschieden === true && !e.durchsicht)
      .sort((a, b) => Number(b.ohne_praezedenz === true) - Number(a.ohne_praezedenz === true) || Number(b.id) - Number(a.id));
    return { success: true, seit, anzahl: rows.length, eintraege, ketten, offene_fragen: ketten.filter((k) => k.offen_fuer_user), durchsicht_offen };
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

// ---------------------------------------------------------------------------
// P15 E1: Durchsicht + Topf-Actions am Tool jev
// ---------------------------------------------------------------------------

export interface DurchsichtOptionen {
  agent_id?: string;
  /** Protokoll-Nummer; ohne id und urteil: Liste der offenen Durchsicht */
  id?: number | string;
  urteil?: string;
  wahl?: unknown;
  /** Wortlaut des Users zur Korrektur (landet als antwort_wortlaut im neuen Topf-Eintrag) */
  wortlaut?: string;
  notiz?: string;
  /** optionale Aufbereitung der Korrektur (dann direkt aktiv) */
  aufbereitet?: unknown;
  seit?: string;
  limit?: number;
}

/**
 * jev(durchsicht): ohne urteil die autonomen Entscheidungen ohne Durchsicht (ohne Praezedenz zuerst, Standard
 * letzte 30 Tage); mit urteil ok | korrigieren (nur Koordinator/User). ok -> bestaetigt (+ bestaetigt_n der
 * Praezedenz); korrigieren -> ueberstimmt + neuer Topf-Eintrag herkunft korrektur (+ korrigiert_n).
 */
export async function durchsichtEntscheidung(project: string, o: DurchsichtOptionen = {}): Promise<Record<string, unknown>> {
  const urteil = typeof o.urteil === 'string' ? o.urteil.trim().toLowerCase() : '';
  if (!urteil) {
    const seit = o.seit ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const p = await holeEntscheidungsProtokoll(project, { seit, nur_entschieden: true, limit: o.limit ?? 200 });
    if (!p.success) return p as Record<string, unknown>;
    return {
      success: true, seit, anzahl: (p.durchsicht_offen ?? []).length, durchsicht_offen: p.durchsicht_offen ?? [],
      hinweis: 'Urteil je Eintrag: jev(action:"durchsicht", id, urteil:"ok") oder urteil:"korrigieren" mit wahl (+ wortlaut des Users). Nur Koordinator/User.',
    };
  }
  const wer = typeof o.agent_id === 'string' ? o.agent_id.trim() : '';
  if (!DARF_DURCHSICHT.test(wer)) {
    return { success: false, error: 'nur_koordinator', message: `Die Durchsicht urteilt nur der Koordinator oder der User (agent_id koordinator|coordinator|user), bekommen: "${wer}".` };
  }
  if (urteil !== 'ok' && urteil !== 'korrigieren') return { success: false, error: 'urteil_ungueltig', message: 'urteil: ok | korrigieren.' };
  const id = Number(o.id);
  if (!Number.isInteger(id) || id <= 0) return { success: false, error: 'id_fehlt', message: 'id (Protokoll-Nummer) ist Pflicht.' };
  try {
    const { rows } = await getPool().query(
      `SELECT id, project, kategorie, frage, optionen, entschieden, praezedenz_id FROM jev_entscheidungen WHERE id = $1 AND ($2 = '*' OR project = $2)`,
      [id, project],
    );
    const z = rows[0] as { id: number; project: string; kategorie: string | null; frage: string; optionen: unknown; entschieden: boolean; praezedenz_id: string | null } | undefined;
    if (!z) return { success: false, error: 'nicht_gefunden', message: `Kein Protokolleintrag ${id} in Projekt ${project}.` };
    if (!z.entschieden) return { success: false, error: 'nicht_entschieden', message: `Eintrag ${id} ist keine Entscheidung (nichts durchzusehen).` };
    if (urteil === 'ok') {
      await getPool().query(`UPDATE jev_entscheidungen SET durchsicht = 'bestaetigt', durchsicht_am = NOW(), durchsicht_von = $2 WHERE id = $1`, [id, wer]);
      await zaehleTopf(z.praezedenz_id, 'bestaetigt_n');
      return { success: true, id, durchsicht: 'bestaetigt', message: `Eintrag ${id} bestaetigt.` };
    }
    if (o.wahl === undefined || o.wahl === null || o.wahl === '') return { success: false, error: 'wahl_fehlt', message: 'korrigieren braucht wahl (die richtige Entscheidung).' };
    const notiz = kurz(o.notiz, 500) || null;
    await getPool().query(
      `UPDATE jev_entscheidungen SET durchsicht = 'korrigiert', durchsicht_am = NOW(), durchsicht_von = $2,
         ueberstimmt_von = $2, ueberstimmt_wahl = $3::jsonb, ueberstimmt_notiz = $4, ueberstimmt_am = NOW() WHERE id = $1`,
      [id, wer, JSON.stringify(o.wahl), notiz],
    );
    await zaehleTopf(z.praezedenz_id, 'korrigiert_n');
    const wahlText = typeof o.wahl === 'string' ? o.wahl : JSON.stringify(o.wahl);
    const neu = await schreibeTopfEintrag(
      {
        frage_de: z.frage, optionen: z.optionen, gewaehlte_option: wahlText, kategorie: z.kategorie ?? 'variante', herkunft_projekt: z.project,
        antwort_wortlaut: kurz(o.wortlaut, 4000) || `Korrektur des Users: richtig ist "${wahlText}"${notiz ? ` (${notiz})` : ''}.`,
        kontext: notiz ?? undefined, aufbereitet: o.aufbereitet,
      },
      { herkunft: 'korrektur', quelle_ref: `jev_entscheidungen:${id}`, erfasst_von: wer },
    );
    return {
      success: true, id, durchsicht: 'korrigiert', neuer_eintrag: neu,
      message: `Eintrag ${id} korrigiert; die Korrektur steht als neuer Topf-Eintrag (${String(neu.status ?? '?')}). ` +
        'Folgen der falschen Entscheidung zuruecknehmen ueber files history/restore (Regel regel-rueckbau-ueber-files-restore).',
    };
  } catch (err) {
    return { success: false, error: 'fehler', message: `Durchsicht fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const JEV_TOPF_ACTIONS = ['entscheidung_ablegen', 'entscheidung_aufbereiten', 'topf', 'durchsicht'] as const;

export function istJevTopfAction(action: string | undefined): boolean {
  return typeof action === 'string' && (JEV_TOPF_ACTIONS as readonly string[]).includes(action);
}

/** Beschreibungssatz fuer das Tool jev (REST und stdio). */
export const JEV_TOPF_BESCHREIBUNG =
  ' ENTSCHEIDUNGS-TOPF (global, Vorlagen ueber alle Projekte): bei aktiver Jev-Funktion entscheidungstopf sucht entscheiden zuerst eine fruehere User-Entscheidung als Praezedenz (Tor 0.8) und waehlt dann die Option in ihrem Sinn (Tor 0.7, beide muessen halten); ohne Praezedenz waehlt Jev trotzdem (markiert ohne_praezedenz, Durchsicht zuerst). ' +
  'Nie autonom: verbotene Kategorien (auch live_db, schema), Text-Scan-Treffer, von Jev als irreversibel eingeschaetzte Aktionen. ' +
  'entscheidung_ablegen (nur Koordinator/User: frage_de|frage_en, antwort_wortlaut, kategorie, optionen, gewaehlte_option, aufbereitet {de:{entscheidung,begruendung,gilt_wenn}, en:{decision,reason,applies_when}}, themen; ohne Aufbereitung in den gepflegten Sprachen roh), ' +
  'entscheidung_aufbereiten (eintrag_id; roh -> aktiv, oder status stillgelegt|ersetzt), topf (Liste: status, kategorie, herkunft, eintrag_id), ' +
  'durchsicht (ohne urteil: offene autonome Entscheidungen, ohne Praezedenz zuerst; urteil ok|korrigieren mit id, wahl, wortlaut - die Korrektur wird neuer Topf-Eintrag). ' +
  'thoughts mit Tags entscheidung+user landen automatisch als roh-Eintrag. abwesend mit project "*" = alle Projekte.';

/** Zusaetzliche Parameter am Tool jev (Schema-Properties, REST und stdio identisch). */
export const JEV_TOPF_PARAMETER: Record<string, Record<string, unknown>> = {
  eintrag_id: { type: 'string', description: 'entscheidung_aufbereiten/topf: Topf-Eintrag (UUID oder kennung, z. B. ent-001)' },
  frage_de: { type: 'string', description: 'entscheidung_ablegen/aufbereiten: die Rueckfrage an den User (deutsch)' },
  frage_en: { type: 'string', description: 'entscheidung_ablegen/aufbereiten: die Rueckfrage an den User (englisch)' },
  antwort_wortlaut: { type: 'string', description: 'entscheidung_ablegen: die Antwort des Users im Original (unveraendert)' },
  gewaehlte_option: { type: 'string', description: 'entscheidung_ablegen/aufbereiten: Schluessel der vom User gewaehlten Option' },
  aufbereitet: { type: 'object', description: 'entscheidung_ablegen/aufbereiten: {de:{entscheidung, begruendung, gilt_wenn}, en:{decision, reason, applies_when}} - gilt_wenn/applies_when ist das Kriterium fuer Jev ("Richtig, wenn ..."); Pflicht in allen gepflegten Sprachen fuer aktiv' },
  themen: { type: 'array', items: { type: 'string' }, description: 'entscheidung_ablegen/aufbereiten: Themen-Schlagworte' },
  kandidat: { type: 'boolean', description: 'entscheidung_ablegen/aufbereiten: false = nur gespeichert, nie Praezedenz (Standard true; verbotene Kategorien sind es nie)' },
  status: { type: 'string', enum: [...TOPF_STATUS], description: 'entscheidung_aufbereiten: Zielstatus (Standard aktiv); topf: Filter' },
  status_grund: { type: 'string', description: 'entscheidung_aufbereiten: Grund fuer stillgelegt/ersetzt' },
  ersetzt_durch: { type: 'string', description: 'entscheidung_aufbereiten (status ersetzt): ID des neuen Eintrags' },
  herkunft: { type: 'string', description: 'topf: Filter herkunft (tool, thought, seed, korrektur)' },
  urteil: { type: 'string', enum: ['ok', 'korrigieren'], description: 'durchsicht: ok = bestaetigt, korrigieren = falsch (dann wahl + wortlaut); ohne urteil = Liste' },
  wortlaut: { type: 'string', description: 'durchsicht korrigieren: Wortlaut des Users zur Korrektur' },
};

/** Dispatcher fuer die Topf-Actions (REST und stdio). Wirft nie. */
export async function fuehreJevTopfActionAus(project: string, action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const agent = typeof args.agent_id === 'string' ? args.agent_id : undefined;
  try {
    switch (action) {
      case 'entscheidung_ablegen':
        return await legeEntscheidungAb({ ...args, herkunft_projekt: args.herkunft_projekt ?? (project === '*' ? undefined : project) }, agent);
      case 'entscheidung_aufbereiten':
        return await bereiteEntscheidungAuf(args, agent);
      case 'topf':
        return await listeEntscheidungstopf(args);
      case 'durchsicht':
        return await durchsichtEntscheidung(project, {
          agent_id: agent, id: args.id as number | string | undefined, urteil: typeof args.urteil === 'string' ? args.urteil : undefined,
          wahl: args.wahl, wortlaut: typeof args.wortlaut === 'string' ? args.wortlaut : undefined, notiz: typeof args.notiz === 'string' ? args.notiz : undefined,
          aufbereitet: args.aufbereitet, seit: typeof args.seit === 'string' ? args.seit : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      default:
        return { success: false, error: 'unbekannte_action', message: `Unbekannte Topf-Action "${action}". Erlaubt: ${JEV_TOPF_ACTIONS.join(', ')}.` };
    }
  } catch (err) {
    return { success: false, error: 'fehler', message: err instanceof Error ? err.message : String(err) };
  }
}

