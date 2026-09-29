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
const STANDARD_TIMEOUT_MS = 10_000;
const MAX_FRAGE = 500;
const MAX_KONTEXT = 1500;
const MAX_HINWEISE = 500;
const KOORDINATOR = /^(koordinator|coordinator)$/i;
const FRAGE_NEU = 'User/Koordinator fragen';

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
  /** choice: {key: Beschreibung} (2..10); score: {'1': Anker, ...}; noul: nicht noetig */
  optionen?: Record<string, string>;
  kontext?: string;
  task_id?: string;
  hinweise?: string;
  confidence_tor?: number;
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
}

async function protokolliere(project: string, e: LogEintrag): Promise<number | null> {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO jev_entscheidungen
         (project, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, jev_aufruf)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
       RETURNING id, zeit`,
      [
        project, e.agent, e.task_id, e.kategorie, e.frage, e.typ,
        e.optionen === null || e.optionen === undefined ? null : JSON.stringify(e.optionen),
        e.wahl === null || e.wahl === undefined ? null : JSON.stringify(e.wahl),
        e.confidence, e.entschieden, e.grund, e.jev_aufruf,
      ],
    );
    return rows.length > 0 ? Number((rows[0] as { id: number | string }).id) : null;
  } catch {
    // Das Protokoll darf eine Antwort nie kippen — die Antwort sagt dann protokoll_id:null.
    return null;
  }
}

function kennzeichnung(confidence: number): string {
  return `entschieden von Jev (Confidence ${confidence}), nicht vom User`;
}

/**
 * Beantwortet eine erlaubte Rueckfrage per Jev — nur bei aktivem Schalter.
 * success:true + entschieden:false heisst: kein Fehler, aber der Agent fragt weiter den
 * User/Koordinator. success:false ist ein Fehler bei Jev oder in der Eingabe.
 */
export async function entscheideRueckfrage(
  project: string,
  anfrage: EntscheidungsAnfrage = {},
  deps: EntscheidungsDeps = {},
): Promise<Record<string, unknown>> {
  const fehler = (message: string) => ({ success: false, entschieden: false, message });

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
  let criteria: Record<string, string> | undefined;
  if (typ === 'choice' || typ === 'score') {
    const roh = anfrage.optionen && typeof anfrage.optionen === 'object' ? anfrage.optionen : undefined;
    if (typ === 'choice') {
      const keys = roh ? Object.keys(roh) : [];
      if (keys.length < 2 || keys.length > 10) return fehler('choice braucht 2 bis 10 optionen {key: Beschreibung}.');
      criteria = Object.fromEntries(keys.map((k) => [k, kurz(roh![k], 300) || k]));
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
  const basis = { agent, task_id, kategorie, frage, typ, optionen: criteria ?? null };

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

    // --- Leitplanken ------------------------------------------------------------
    if ((VERBOTENE_KATEGORIEN as readonly string[]).includes(kategorie)) {
      return abgelehnt('kategorie_verboten', `Kategorie "${kategorie}" gehoert dem User, Jev entscheidet sie nie (verboten: ${VERBOTENE_KATEGORIEN.join(', ')}).`);
    }
    if (!(ERLAUBTE_KATEGORIEN as readonly string[]).includes(kategorie)) {
      return abgelehnt('kategorie_unbekannt', `Unbekannte Kategorie "${kategorie}". Erlaubt: ${ERLAUBTE_KATEGORIEN.join(', ')}.`);
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

    const state: Record<string, unknown> = {
      project,
      kategorie,
      frage,
      kontext: kurz(anfrage.kontext, MAX_KONTEXT),
      ...(hinweise ? { hinweise } : {}),
    };
    const grundText =
      'The user is away. Decide the question in state.frage using state.kontext. ' +
      'It is a reversible decision of the category in state.kategorie; when the options are close, prefer the one that is easiest to undo.' +
      hinweisSuffix;
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
      return { ...(await abgelehnt('unsicher', `Jev ist unsicher (p=${p}, Tor ${tor}).`, true, confidence)), tor };
    }

    const gewaehlt = typeof a?.choice === 'string' ? a.choice : '';
    const conf = typeof a?.confidence === 'number' ? a.confidence : null;
    if (!gewaehlt || !criteria || !(gewaehlt in criteria) || conf === null) {
      return abgelehnt('ungueltige_antwort', 'Jev lieferte keine gueltige Wahl.', true);
    }
    const wahl: string | number = typ === 'score' ? Number(gewaehlt) : gewaehlt;
    if (conf >= tor) {
      const protokoll_id = await protokolliere(project, { ...basis, wahl, confidence: conf, entschieden: true, grund: null, jev_aufruf: true });
      return {
        success: true, entschieden: true, wahl, wahl_beschreibung: criteria[gewaehlt], confidence: conf, tor,
        kennzeichnung: kennzeichnung(conf), protokoll_id, schalter,
      };
    }
    return { ...(await abgelehnt('unsicher', `Jev ist unsicher (Confidence ${conf}, Tor ${tor}).`, true, conf, wahl)), tor };
  } catch (err) {
    return fehler(ohneKey(`Entscheidung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, process.env.JEV_OPENROUTER_API_KEY?.trim() ?? ''));
  }
}

// ---------------------------------------------------------------------------
// Protokoll + ueberstimmen
// ---------------------------------------------------------------------------

export interface ProtokollOptionen {
  /** Standard: Beginn des Schalters (sonst die letzten 24 h) */
  seit?: Date | string;
  nur_entschieden?: boolean;
  limit?: number;
}

export async function holeEntscheidungsProtokoll(
  project: string,
  opt: ProtokollOptionen = {},
): Promise<{ success: boolean; message?: string; seit?: Date | string; anzahl?: number; eintraege?: Array<Record<string, unknown>> }> {
  try {
    let seit: Date | string | undefined = opt.seit;
    if (!seit) {
      const stand = await leseAbwesenheit(project);
      seit = stand.seit ?? new Date(Date.now() - 24 * 3_600_000);
    }
    const limit = Math.min(Math.max(Math.floor(opt.limit ?? 50), 1), 200);
    const { rows } = await getPool().query(
      `SELECT id, zeit, agent, task_id, kategorie, frage, typ, optionen, wahl, confidence, entschieden, grund, ueberstimmt_von, ueberstimmt_wahl, ueberstimmt_notiz
         FROM jev_entscheidungen
        WHERE project = $1 AND zeit >= $2${opt.nur_entschieden ? ' AND entschieden = true' : ''}
        ORDER BY zeit DESC, id DESC LIMIT $3`,
      [project, seit, limit],
    );
    return { success: true, seit, anzahl: rows.length, eintraege: rows as Array<Record<string, unknown>> };
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
