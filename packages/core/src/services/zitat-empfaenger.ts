/**
 * P22-T170 (User-Entscheidungen 841d6a84, 91640c12, 1417a73b, 82b61246): Zitat aus einem Lesefenster OHNE Chat-/Channel-Herkunft
 * (Artefakte, Top-Artefakte, sonstige Stellen). Der User waehlt sichtbar per Checkbox die Empfaenger; das ist kein Rundversand.
 *   listeZitatEmpfaenger(project): aktive Identitaeten des Projekts (inkl. Koordinator) und der Main (Rolle main, Projekt
 *     synapse-hauptagent). Reihenfolge: Main, Koordinator, dann nach Name.
 *   sendeZitatAnEmpfaenger({project, empfaenger, text, zitate}, sende): je gewaehltem Empfaenger GENAU EINE Inbox-Zeile mit
 *     demselben Inhalt (Text + Block [Synapse-Zitate], Bauer chat-zitate.ts). Nur Empfaenger aus listeZitatEmpfaenger; Dubletten
 *     zaehlen einmal. Die REST-Route reicht den Inbox-Weg herein (identitaetsadressiert wie agent-chat).
 * SCHALTER: chat_zitate im Projekt des Lesefensters (Standard AUS) -> 409 funktion_aus. Grenzen wie die Zitat-Anhaenge.
 * DEBUG: Antwort mit schalter (Quelle), herkunft 'ohne', empfaenger je Ziel {inbox_id, fehler}; console.debug('[zitat-empfaenger]').
 */
import { getPool } from '../db/client.js';
import { leseChatZitateSchalter, pruefeChatZitateAnfrage, textMitZitaten, type ChatZitateSchalter, type ZitatDebug } from './chat-zitate.js';
import type { UserEntscheidungZiel } from './user-entscheidung.js';

export const ZITAT_EMPFAENGER_MAX = 50;
const INHALT_MAX = 20_000;

export interface ZitatEmpfaenger { identity_id: string; agent_id: string; name: string; rolle: string; project: string }
export type ZitatEmpfaengerFehler = { ok: false; status: number; code: string; message: string; schalter?: ChatZitateSchalter; details?: Record<string, unknown> };
export type ZitatEmpfaengerSende = (ziel: UserEntscheidungZiel, text: string) => Promise<{ id: number }>;

const projektAus = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

async function leseEmpfaenger(project: string): Promise<ZitatEmpfaenger[]> {
  // Main: Rolle main (eigenes Projekt synapse-hauptagent); Koordinator und alle anderen aktiven Identitaeten des Projekts.
  const r = await getPool().query<ZitatEmpfaenger>(
    `SELECT id::text AS identity_id, agent_id, coalesce(nullif(name, ''), agent_id) AS name, rolle, project FROM agent_identitaeten
      WHERE status = 'aktiv' AND (project = $1 OR rolle = 'main')
      ORDER BY CASE rolle WHEN 'main' THEN 0 WHEN 'koordinator' THEN 1 ELSE 2 END, lower(coalesce(nullif(name, ''), agent_id)), id
      LIMIT 500`, [project]);
  return r.rows;
}

/** Empfaengerliste fuer die Checkbox-Auswahl. Schalter AUS -> aktiv false, leer. */
export async function listeZitatEmpfaenger(project: unknown): Promise<{ ok: true; aktiv: boolean; schalter: ChatZitateSchalter; empfaenger: ZitatEmpfaenger[] } | ZitatEmpfaengerFehler> {
  const p = projektAus(project);
  if (!p || p.length > 120) return { ok: false, status: 400, code: 'project_fehlt', message: 'project angeben' };
  const schalter = await leseChatZitateSchalter(p);
  if (!schalter.aktiv) return { ok: true, aktiv: false, schalter, empfaenger: [] };
  return { ok: true, aktiv: true, schalter, empfaenger: await leseEmpfaenger(p) };
}

/** Zitat(e) an jeden gewaehlten Empfaenger (je Empfaenger eine Inbox-Zeile, gleicher Block). */
export async function sendeZitatAnEmpfaenger(
  eingabe: { project?: unknown; empfaenger?: unknown; text?: unknown; zitate?: unknown },
  sende: ZitatEmpfaengerSende,
): Promise<{ ok: true; herkunft: 'ohne'; schalter: ChatZitateSchalter; zitate: ZitatDebug & { block_zeichen: number };
  empfaenger: Array<{ identity_id: string; agent_id: string; rolle: string; inbox_id: number | null; fehler: string | null }> } | ZitatEmpfaengerFehler> {
  const p = projektAus(eingabe.project);
  if (!p || p.length > 120) return { ok: false, status: 400, code: 'project_fehlt', message: 'project angeben' };
  const schalter = await leseChatZitateSchalter(p);
  if (!schalter.aktiv) return { ok: false, status: 409, code: 'funktion_aus', message: 'Zitat-Anhänge sind aus (chat_zitate)', schalter };
  const roh = Array.isArray(eingabe.empfaenger) ? eingabe.empfaenger : [];
  const ids = [...new Set(roh.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
  if (!ids.length) return { ok: false, status: 400, code: 'empfaenger_fehlt', message: 'Mindestens einen Empfänger wählen', schalter };
  if (ids.length > ZITAT_EMPFAENGER_MAX) return { ok: false, status: 400, code: 'zu_viele_empfaenger', message: 'Höchstens ' + ZITAT_EMPFAENGER_MAX + ' Empfänger', schalter };
  if (!Array.isArray(eingabe.zitate) || !eingabe.zitate.length) return { ok: false, status: 400, code: 'zitate_fehlen', message: 'Kein Zitat angegeben', schalter };
  const z = await pruefeChatZitateAnfrage(eingabe.zitate, p);
  if (!z.ok) return { ok: false, status: z.status, code: z.code, message: z.message, schalter, ...(z.details ? { details: z.details } : {}) };
  const text = typeof eingabe.text === 'string' ? eingabe.text.trim() : '';
  const inhalt = textMitZitaten(text, z.zitate);
  if (inhalt.length > INHALT_MAX) return { ok: false, status: 400, code: 'text_zu_lang', message: 'Nachricht mit Zitaten länger als ' + INHALT_MAX + ' Zeichen', schalter };
  const erlaubt = new Map((await leseEmpfaenger(p)).map((e) => [e.identity_id, e]));
  const unbekannt = ids.filter((id) => !erlaubt.has(id));
  if (unbekannt.length) return { ok: false, status: 404, code: 'empfaenger_unbekannt', message: 'Unbekannte oder inaktive Empfänger', schalter, details: { unbekannt } };
  const ergebnis: Array<{ identity_id: string; agent_id: string; rolle: string; inbox_id: number | null; fehler: string | null }> = [];
  for (const id of ids) {
    const e = erlaubt.get(id)!;
    try {
      const g = await sende({ art: 'identity', identity_id: e.identity_id, agent_id: e.agent_id, project: e.project }, inhalt);
      ergebnis.push({ identity_id: e.identity_id, agent_id: e.agent_id, rolle: e.rolle, inbox_id: g.id, fehler: null });
    } catch (error) {
      ergebnis.push({ identity_id: e.identity_id, agent_id: e.agent_id, rolle: e.rolle, inbox_id: null, fehler: error instanceof Error ? error.message : String(error) });
    }
  }
  const debug = { ...(z.debug ?? { anzahl: z.zitate.length, gekuerzt: [], schalter_quelle: schalter.quelle }), block_zeichen: inhalt.length - text.length };
  console.debug('[zitat-empfaenger]', { project: p, herkunft: 'ohne', empfaenger: ergebnis.map((x) => x.agent_id + (x.fehler ? ' (fehler)' : '')), zitate: debug.anzahl });
  return { ok: true, herkunft: 'ohne', schalter, zitate: debug, empfaenger: ergebnis };
}
