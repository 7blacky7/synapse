/**
 * P22-T288 W6 (Analyse efbe02f1, OK Koordinator 08.11.2026): einmaliger, idempotenter Nachzug der API-Laufzeit-Zuege aus
 * api_agent_verlauf nach hauptagent_verlauf - fuer Zuege VOR dem Schalter api_verlauf_hauptverlauf (Befund: deepseek-umsetzer,
 * 808 Zeilen, nur in api_agent_verlauf). EINE Schreibstelle: importiereSitzungsEintraege (herkunft api). Kein Lese-Rueckfall im Fenster.
 *
 * ABBILD je Nachricht (sitzung, nr): eintraegeAusNachricht wie live (Antworttext, Denken, Werkzeug-Aufruf/-Ergebnis) plus die
 *   User-Textbloecke als eingabe (live schreibt die Eingabe getrennt als 'eingang:<ids>'). ref = 'nachzug:<sitzung>:<nr>:<block>'
 *   -> quelle_ref 'api:nachzug:...' (eigener Namensraum, ON CONFLICT DO NOTHING: beliebig oft wiederholbar, auch nach Abbruch).
 *   zeit = erstellt_am der Zeile in api_agent_verlauf.
 * LIVE-GRENZE: hat eine Sitzung schon Live-Zeilen ('api:<sitzung>:<nr>:<block>'), werden nur Nachrichten VOR der kleinsten Live-nr
 *   nachgezogen - nichts doppelt. Pruefung (claude-linde): die User-Text-Nachricht direkt vor der kleinsten Live-nr ist die Eingabe des
 *   ersten Live-Zugs; live steht sie schon als 'api:eingang:<ids>' (eintraegeAusNachricht schreibt User-Text nie) -> auch sie entfaellt.
 * SICHTZEILEN P22-T202: bei Schalter AUS schreibt der Lauf je Zug 'turn:<id>:eingabe' und 'turn:<id>:antwort' (Eingang + Gesamttext). Fuer
 *   diese Zuege zieht der Nachzug nur Denken und Werkzeugzeilen nach (Zaehler uebersprungen_sichtbar), sonst stuenden Eingabe und
 *   Antwort doppelt im Chat; deren Tokens bleiben wie sie sind (kein zweiter Messwert).
 * MAIN-CHAT: Zuege mit Eingang quelle 'main_chat' laufen in die Web-UI-Antwortzeile des Main (SSE-Verlauf, mainEvents) - sie stehen
 *   schon vollstaendig im Verlauf und werden ganz ausgelassen (ebenfalls Zaehler uebersprungen_sichtbar).
 * TOKENS: je Zug (api_agent_turns) traegt die letzte Antwort (art text) im Zeitfenster des Zugs die gemessenen Werte (input, output,
 *   kontext) - wie live setzeGemesseneTokens auf letzteTextRef.
 * admin(action:'verlauf_nachzug_api', ziel_identity_id, nachzug_ausfuehren?): Standard Vorschau (Zahlen je Sitzung), nachzug_ausfuehren:true
 *   schreibt. Rechte: User oder Koordinator des Projekts der Identitaet (pruefeProfilVerwalter). Schreiben nur bei api_verlauf_hauptverlauf
 *   EIN (funktion_aus sonst). Debug: Antwort mit Schalterstand, je Sitzung nachrichten/eintraege/vorhanden/neu/live_ab_nr, Summe.
 */
import { getPool } from '../db/client.js';
import type { Nachricht } from './api-agent-schleife.js';
import { importiereSitzungsEintraege, leseApiVerlaufHauptverlaufSchalter, type SitzungsEintragEingabe } from './hauptagent-verlauf.js';
import { ProfilVerwaltungFehler, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { W1bAkteur, AusweisAkteur } from './agent-profil-vertrag.js';

type VerlaufsBlock = { typ?: string; text?: string; id?: string; name?: string; eingabe?: unknown; aufruf_id?: string; inhalt?: unknown; fehler?: unknown };

/**
 * P22-T286/N1 (aus rest-api api-agent-lauf.ts hierher verlegt, P22-T288: eine Stelle fuer live und Nachzug): Eintraege EINER Nachricht
 * fuer hauptagent_verlauf. ref = '<sitzung>:<nr>:<blockindex>' (stabil und kollisionsfrei, auch bei Zwischentexten und mehreren
 * Anbieteraufrufen). Die EINGABE des Turns schreibt der Aufrufer getrennt mit 'eingang:<ids>'. Rein.
 */
export function eintraegeAusNachricht(sitzung: string, nr: number, n: Nachricht, modell: string | null): SitzungsEintragEingabe[] {
  const bloecke = (Array.isArray(n.inhalt) ? n.inhalt : []) as unknown as VerlaufsBlock[];
  const out: SitzungsEintragEingabe[] = [];
  bloecke.forEach((b, i) => {
    const ref = sitzung + ':' + nr + ':' + i;
    if (b.typ === 'text' && typeof b.text === 'string' && b.text) {
      if (n.rolle !== 'assistant') return;
      out.push({ ref, art: 'text', inhalt: b.text, modell });
    } else if (b.typ === 'denken') {
      out.push({ ref, art: 'denken', inhalt: String(b.text ?? ''), modell });
    } else if (b.typ === 'werkzeug_aufruf') {
      out.push({ ref, art: 'werkzeug_aufruf', name: b.name ?? null, werkzeug_id: b.id ?? null, inhalt: b.eingabe ?? null, modell });
    } else if (b.typ === 'werkzeug_ergebnis') {
      out.push({ ref, art: 'werkzeug_ergebnis', werkzeug_id: b.aufruf_id ?? null, inhalt: b.inhalt ?? null, fehler: b.fehler === true, modell });
    }
  });
  return out;
}

/** Nachzug-Eintraege einer Nachricht: wie live plus User-Textbloecke als eingabe, ref-Praefix 'nachzug:', zeit gesetzt. Rein. */
export function nachzugEintraegeAusNachricht(sitzung: string, nr: number, n: Nachricht, modell: string | null, zeit: string | null): SitzungsEintragEingabe[] {
  const basis = 'nachzug:' + sitzung;
  const out = eintraegeAusNachricht(basis, nr, n, modell);
  if (n.rolle === 'user') {
    ((Array.isArray(n.inhalt) ? n.inhalt : []) as unknown as VerlaufsBlock[]).forEach((b, i) => {
      if (b.typ === 'text' && typeof b.text === 'string' && b.text) out.push({ ref: basis + ':' + nr + ':' + i, art: 'eingabe', inhalt: b.text, modell });
    });
  }
  const block = (r: string): number => Number(r.slice(r.lastIndexOf(':') + 1));
  return out.sort((a, b) => block(a.ref) - block(b.ref)).map((e) => ({ ...e, zeit }));
}

export interface ApiNachzugSitzung {
  sitzung: string; nachrichten: number; eintraege: number; vorhanden: number; neu: number;
  /** kleinste nr mit Live-Zeilen (ab hier nichts nachziehen), null = keine Live-Zeilen. */
  live_ab_nr: number | null; uebersprungen_live: number; zuege_mit_tokens: number; von: string | null; bis: string | null;
  /** Pruefung: Eintraege, die schon im Verlauf stehen (P22-T202-Sichtzeilen turn:<id>:* bzw. Main-Chat-Zug), nicht nachgezogen. */
  uebersprungen_sichtbar: number;
}
export interface ApiNachzugErmittlung {
  identity_id: string; runtime: string | null; gekappt: boolean; sitzungen: ApiNachzugSitzung[];
  eintraege: SitzungsEintragEingabe[]; neu: SitzungsEintragEingabe[];
}
const NACHZUG_ZEILEN_MAX = 20_000;
const STAPEL = 200;

/** Lesend: was der Nachzug schreiben wuerde (je Sitzung), schon vorhandene refs, Live-Grenze, Tokens je Zug. */
export async function ermittleApiVerlaufNachzug(identity_id: string): Promise<ApiNachzugErmittlung> {
  const pool = getPool();
  const lauf = (await pool.query<{ modell: string | null; anbieter: string | null }>(
    'SELECT modell, anbieter FROM api_agent_laeufe WHERE identity_id = $1 LIMIT 1', [identity_id])).rows[0] ?? null;
  const zeilen = (await pool.query<{ sitzung: string; nr: number; inhalt: Nachricht; erstellt_am: Date }>(
    `SELECT sitzung::text AS sitzung, nr, inhalt, erstellt_am FROM api_agent_verlauf
      WHERE identity_id = $1 AND art = 'nachricht' ORDER BY erstellt_am, sitzung, nr LIMIT $2`, [identity_id, NACHZUG_ZEILEN_MAX + 1])).rows;
  const gekappt = zeilen.length > NACHZUG_ZEILEN_MAX;
  if (gekappt) zeilen.length = NACHZUG_ZEILEN_MAX;
  const liveAb = new Map((await pool.query<{ sitzung: string; ab: number }>(
    `SELECT split_part(quelle_ref, ':', 2) AS sitzung, MIN(split_part(quelle_ref, ':', 3)::int) AS ab FROM hauptagent_verlauf
      WHERE identity_id = $1 AND quelle_ref ~ '^api:[0-9a-f-]{36}:[0-9]+:' GROUP BY 1`, [identity_id])).rows.map((r) => [r.sitzung, Number(r.ab)]));
  const vorhanden = new Set((await pool.query<{ quelle_ref: string }>(
    "SELECT quelle_ref FROM hauptagent_verlauf WHERE identity_id = $1 AND quelle_ref LIKE 'api:nachzug:%'", [identity_id])).rows.map((r) => r.quelle_ref));
  // Pruefung: Zuege mit P22-T202-Sichtzeilen 'api:turn:<id>:eingabe|antwort'.
  const sichtbareZuege = new Set((await pool.query<{ id: string }>(
    "SELECT DISTINCT split_part(quelle_ref, ':', 3) AS id FROM hauptagent_verlauf WHERE identity_id = $1 AND quelle_ref LIKE 'api:turn:%'", [identity_id])).rows.map((r) => r.id));
  // Pruefung: Main-Chat-Zuege stehen als Web-UI-Antwortzeile im Verlauf -> ganz auslassen.
  const mainChatZuege = new Set((await pool.query<{ id: string }>(
    "SELECT DISTINCT turn_id::text AS id FROM api_agent_eingang WHERE identity_id = $1 AND quelle = 'main_chat' AND turn_id IS NOT NULL", [identity_id])).rows.map((r) => r.id));
  const zuege = (await pool.query<{ id: string; sitzung: string; modell: string | null; von: Date; bis: Date | null; input_tokens: number | null; output_tokens: number | null; kontext_tokens: number | null }>(
    `SELECT id::text AS id, sitzung::text AS sitzung, modell, gestartet_am AS von, beendet_am AS bis, input_tokens, output_tokens, kontext_tokens
       FROM api_agent_turns WHERE identity_id = $1 ORDER BY gestartet_am`, [identity_id])).rows;
  const zugFuer = (sitzung: string, t: number) => zuege.find((z) => z.sitzung === sitzung && z.von.getTime() <= t && (!z.bis || t <= z.bis.getTime()));

  const je = new Map<string, ApiNachzugSitzung>();
  const eintraege: SitzungsEintragEingabe[] = [];
  const letzteAntwortJeZug = new Map<object, { e: SitzungsEintragEingabe; t: number }>();
  for (const z of zeilen) {
    const s = je.get(z.sitzung) ?? { sitzung: z.sitzung, nachrichten: 0, eintraege: 0, vorhanden: 0, neu: 0, live_ab_nr: liveAb.get(z.sitzung) ?? null,
      uebersprungen_live: 0, zuege_mit_tokens: 0, von: null, bis: null, uebersprungen_sichtbar: 0 };
    je.set(z.sitzung, s);
    // Pruefung: Eingabe des ersten Live-Zugs (User-Text direkt vor der kleinsten Live-nr, ohne Werkzeugergebnis) steht live als eingang:<ids>.
    const bl = (Array.isArray(z.inhalt?.inhalt) ? z.inhalt.inhalt : []) as unknown as VerlaufsBlock[];
    const eingabeLiveZug = s.live_ab_nr !== null && z.nr === s.live_ab_nr - 1 && z.inhalt?.rolle === 'user' && !bl.some((b) => b.typ === 'werkzeug_ergebnis');
    if (s.live_ab_nr !== null && (z.nr >= s.live_ab_nr || eingabeLiveZug)) { s.uebersprungen_live += 1; continue; }
    const t = z.erstellt_am.getTime();
    const zug = zugFuer(z.sitzung, t);
    const alle = nachzugEintraegeAusNachricht(z.sitzung, z.nr, z.inhalt, zug?.modell ?? lauf?.modell ?? null, z.erstellt_am.toISOString());
    const es = zug && mainChatZuege.has(zug.id) ? []
      : zug && sichtbareZuege.has(zug.id) ? alle.filter((e) => e.art !== 'eingabe' && e.art !== 'text') : alle;
    s.uebersprungen_sichtbar += alle.length - es.length;
    s.nachrichten += 1;
    s.eintraege += es.length;
    s.von = s.von ?? z.erstellt_am.toISOString();
    s.bis = z.erstellt_am.toISOString();
    for (const e of es) {
      eintraege.push(e);
      if (vorhanden.has('api:' + e.ref)) s.vorhanden += 1; else s.neu += 1;
      if (zug && e.art === 'text') {
        const alt = letzteAntwortJeZug.get(zug);
        if (!alt || t >= alt.t) letzteAntwortJeZug.set(zug, { e, t });
      }
    }
  }
  for (const [zug, { e }] of letzteAntwortJeZug) {
    const z = zug as (typeof zuege)[number];
    if ((z.input_tokens ?? 0) + (z.output_tokens ?? 0) <= 0) continue;
    e.tokens_gemessen = { input: z.input_tokens ?? 0, output: z.output_tokens ?? 0, ...(z.kontext_tokens ? { kontext: z.kontext_tokens } : {}) };
    const s = je.get(z.sitzung);
    if (s) s.zuege_mit_tokens += 1;
  }
  return { identity_id, runtime: lauf?.anbieter ?? null, gekappt, sitzungen: [...je.values()], eintraege,
    neu: eintraege.filter((e) => !vorhanden.has('api:' + e.ref)) };
}

/** Schreibt die neuen Eintraege ueber die eine Schreibstelle (Stapel je 200); bricht bei einem grund der Schreibstelle ab. */
export async function schreibeApiVerlaufNachzug(erm: ApiNachzugErmittlung): Promise<{ aufgenommen: number; uebersprungen: number; grund: string | null }> {
  let aufgenommen = 0;
  let uebersprungen = 0;
  for (let i = 0; i < erm.neu.length; i += STAPEL) {
    const r = await importiereSitzungsEintraege(erm.identity_id, erm.neu.slice(i, i + STAPEL), { runtime: erm.runtime, herkunft: 'api' });
    aufgenommen += r.aufgenommen;
    uebersprungen += r.uebersprungen;
    if (r.grund) return { aufgenommen, uebersprungen, grund: r.grund };
  }
  return { aufgenommen, uebersprungen, grund: null };
}

// ---------------------------------------------------------------------------------------------
// admin(action:'verlauf_nachzug_api')
// ---------------------------------------------------------------------------------------------
export const API_VERLAUF_NACHZUG_ADMIN_ACTIONS = ['verlauf_nachzug_api'] as const;
export const API_VERLAUF_NACHZUG_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  nachzug_ausfuehren: { type: 'boolean', description: 'verlauf_nachzug_api: true = API-Zuege (api_agent_verlauf) der Identitaet ziel_identity_id nach hauptagent_verlauf schreiben (idempotent, nur bei api_verlauf_hauptverlauf EIN); Standard false = Vorschau mit Zahlen je Sitzung' },
};
export function istApiVerlaufNachzugAdminAction(action: string): boolean {
  return (API_VERLAUF_NACHZUG_ADMIN_ACTIONS as readonly string[]).includes(action);
}

export async function fuehreApiVerlaufNachzugAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) throw new ProfilVerwaltungFehler('recht_fehlt');
    const id = typeof args.ziel_identity_id === 'string' && args.ziel_identity_id.trim() ? args.ziel_identity_id.trim() : null;
    if (!id) throw new ProfilVerwaltungFehler('ziel_identity_id_fehlt');
    const ident = (await getPool().query<{ project: string; agent_id: string; status: string }>(
      'SELECT project, agent_id, status FROM agent_identitaeten WHERE id = $1', [id])).rows[0];
    if (!ident) throw new ProfilVerwaltungFehler('identitaet_unbekannt');
    const projektArg = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    if (projektArg && projektArg !== ident.project) throw new ProfilVerwaltungFehler('projekt_passt_nicht', { project: ident.project });
    await pruefeProfilVerwalter(akteur as AusweisAkteur, ident.project);
    const schalter = await leseApiVerlaufHauptverlaufSchalter(ident.project);
    const erm = await ermittleApiVerlaufNachzug(id);
    const summe = erm.sitzungen.reduce((a, s) => ({ nachrichten: a.nachrichten + s.nachrichten, eintraege: a.eintraege + s.eintraege,
      vorhanden: a.vorhanden + s.vorhanden, neu: a.neu + s.neu, uebersprungen_live: a.uebersprungen_live + s.uebersprungen_live,
      zuege_mit_tokens: a.zuege_mit_tokens + s.zuege_mit_tokens, uebersprungen_sichtbar: a.uebersprungen_sichtbar + s.uebersprungen_sichtbar }),
    { nachrichten: 0, eintraege: 0, vorhanden: 0, neu: 0, uebersprungen_live: 0, zuege_mit_tokens: 0, uebersprungen_sichtbar: 0 });
    const basis = { success: true, action, identity_id: id, agent_id: ident.agent_id, project: ident.project, identitaet_status: ident.status,
      runtime: erm.runtime, schalter: { api_verlauf_hauptverlauf: schalter }, gekappt: erm.gekappt, sitzungen: erm.sitzungen, summe };
    if (args.nachzug_ausfuehren !== true) {
      return { ...basis, modus: 'vorschau', hinweis: (schalter.aktiv ? 'nachzug_ausfuehren:true schreibt die ' + summe.neu + ' neuen Eintraege'
        : 'Schalter api_verlauf_hauptverlauf ist AUS: nachzug_ausfuehren wird abgewiesen') + ' (idempotent, quelle_ref api:nachzug:...; Live-Zeilen bleiben unberuehrt).' };
    }
    if (!schalter.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { schalter: 'api_verlauf_hauptverlauf', quelle: schalter.quelle, letzter_fehler: schalter.letzter_fehler });
    const r = await schreibeApiVerlaufNachzug(erm);
    return { ...basis, modus: 'ausgefuehrt', ...r };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'verlauf_nachzug_fehler', message: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
