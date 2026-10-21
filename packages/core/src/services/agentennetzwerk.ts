/**
 * P22-T93: ein Vertrag fuer Produkt-Freigabe, Einstellungen und sichere Netzwerk-Metadaten.
 * Kein Nachrichteninhalt/Argument/Resultat verlaesst diese Projektion.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { pflichtText, pruefeProfilVerwalter, ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import type { ToolCallRow } from './tool-call-log.js';

export const NETZWERK_FUNKTION = 'agentennetzwerk' as const;
export const NETZWERK_EINSTELLUNGEN = {
 aktivitaet_sekunden: { standard: 60, min: 10, max: 600 },
 inaktiv_sekunden: { standard: 120, min: 10, max: 3600 },
 sichtbare_agenten: { standard: 24, min: 8, max: 600 },
 sichtbare_channels: { standard: 8, min: 1, max: 24 },
 ereignis_limit: { standard: 300, min: 20, max: 2000 },
 animation_limit: { standard: 80, min: 8, max: 400 },
 animation_ms: { standard: 1800, min: 300, max: 6000 },
 bilder_pro_sekunde: { standard: 60, min: 60, max: 144 },
 frame_budget_ms: { standard: 8, min: 2, max: 20 },
 buendel_ms: { standard: 180, min: 50, max: 2000 },
 abgleich_sekunden: { standard: 15, min: 3, max: 120 },
} as const;
export type NetzwerkEinstellung = keyof typeof NETZWERK_EINSTELLUNGEN;
export type NetzwerkWerte = Record<NetzwerkEinstellung, number>;
export const NETZWERK_ADMIN_PARAMETER = {
 netzwerk_modus: { type: 'string', enum: ['status','einstellen'], description: 'agentennetzwerk: Diagnose oder persistente globale Einstellungen (User/Koordinator)' },
 netzwerk_werte: { type: 'object', additionalProperties: { type: 'number' }, description: 'agentennetzwerk einstellen: aktivitaet_sekunden, inaktiv_sekunden, sichtbare_agenten, sichtbare_channels, ereignis_limit, animation_limit, animation_ms, bilder_pro_sekunde, frame_budget_ms, buendel_ms, abgleich_sekunden' },
};
export async function leseNetzwerkKonfiguration(project: string) {
 const produkt = await leseProfilProduktSchalter(NETZWERK_FUNKTION, project);
 let schalter = { aktiv: produkt.aktiv, quelle: produkt.quelle as string, bis: null as string | null, letzter_fehler: produkt.letzter_fehler };
 const { internToolAktiv } = await import('./intern-tool.js');
 if (internToolAktiv()) {
  try {
   const r = await getPool().query("SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis>NOW()", [NETZWERK_FUNKTION]);
   if (r.rows[0]) schalter = { aktiv: r.rows[0].aktiv, quelle: 'intern', bis: r.rows[0].bis.toISOString(), letzter_fehler: null };
  } catch { schalter = { ...schalter, aktiv: false, letzter_fehler: 'intern_nicht_lesbar' }; }
 }
 const werte = {} as NetzwerkWerte;
 const einstellungen: Record<string, { wert: number; quelle: string; min: number; max: number }> = {};
 for (const [name, d] of Object.entries(NETZWERK_EINSTELLUNGEN)) {
  werte[name as NetzwerkEinstellung] = d.standard;
  einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max };
 }
 let letzter_fehler: string | null = null;
 try {
  const r = await getPool().query('SELECT name,wert FROM agentennetzwerk_einstellungen');
  for (const z of r.rows) {
   const d = NETZWERK_EINSTELLUNGEN[z.name as NetzwerkEinstellung];
   if (d && Number.isInteger(z.wert) && z.wert >= d.min && z.wert <= d.max) {
    werte[z.name as NetzwerkEinstellung] = z.wert;
    einstellungen[z.name] = { wert: z.wert, quelle: 'einstellung', min: d.min, max: d.max };
   }
  }
 } catch { letzter_fehler = 'einstellungen_nicht_lesbar'; }
 return { schalter, werte, einstellungen, letzter_fehler };
}
export async function fuehreNetzwerkAdminAus(args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
 try {
  if (!akteur) throw new ProfilVerwaltungFehler('recht_fehlt');
  const project = typeof args.project === 'string' ? args.project : null;
  const wer = await pruefeProfilVerwalter(akteur, project);
  if (!project) throw new ProfilVerwaltungFehler('project_fehlt');
  if (args.netzwerk_modus === 'einstellen') {
   const grund = pflichtText(args.grund, 'grund_fehlt');
   const werte = args.netzwerk_werte;
   if (!werte || typeof werte !== 'object' || Array.isArray(werte) || !Object.keys(werte).length) throw new ProfilVerwaltungFehler('einstellung_fehlt');
   const paare = Object.entries(werte);
   for (const [name, wert] of paare) {
    const d = NETZWERK_EINSTELLUNGEN[name as NetzwerkEinstellung];
    if (!d || typeof wert !== 'number' || !Number.isInteger(wert) || wert < d.min || wert > d.max) throw new ProfilVerwaltungFehler('einstellung_ungueltig', { name });
   }
   const c = await getPool().connect();
   try {
    await c.query('BEGIN');
    for (const [name, wert] of paare) await c.query(`INSERT INTO agentennetzwerk_einstellungen(name,wert,grund,gesetzt_von)
      VALUES($1,$2::jsonb,$3,$4) ON CONFLICT(name) DO UPDATE SET wert=EXCLUDED.wert,grund=EXCLUDED.grund,gesetzt_von=EXCLUDED.gesetzt_von,gesetzt_am=NOW()`,
      [name, JSON.stringify(wert), grund, wer.wer]);
    await c.query('COMMIT');
   } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } else if (args.netzwerk_modus !== undefined && args.netzwerk_modus !== 'status') throw new ProfilVerwaltungFehler('modus_ungueltig');
  return { success: true, action: 'agentennetzwerk', ...(await leseNetzwerkKonfiguration(project)) };
 } catch (e) { return { success: false, error: e instanceof ProfilVerwaltungFehler ? e.code : 'netzwerk_einstellungen_fehler' }; }
}
export function netzwerkText(value: unknown): string {
 return typeof value === 'string' ? value.replace(/sai_[a-z0-9]+/gi, '[Ausweis]').replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '';
}
/** Nur komplette TOP-LEVEL-Felder, auch bei am Ende abgeschnittener Audit-Vorschau.
 * Kein Regex auf Freitext: ein "recipient_id" im Nachrichteninhalt ist kein Empfaenger.
 */
export function netzwerkArgumente(raw: string | null): Record<string, unknown> {
 if (!raw?.startsWith('{')) return {};
 try { return JSON.parse(raw); } catch { /* nur abgeschlossenen Praefix lesen */ }
 let tiefe = 0, string = false, escape = false, ende = 0;
 for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (string) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') string = false; continue; }
  if (c === '"') string = true;
  else if (c === '{' || c === '[') tiefe++;
  else if (c === '}' || c === ']') tiefe--;
  else if (c === ',' && tiefe === 1) ende = i;
 }
 try { return ende ? JSON.parse(raw.slice(0, ende) + '}') : {}; } catch { return {}; }
}
export interface NetzwerkEreignis {
 id: string; zeit: string; project: string; agent: string; identity_id: string | null; lauf_id: string | null;
 tool: string; action: string; ok: boolean; empfaenger: string[]; channel: string | null;
 interaktion: 'senden' | 'lesen' | 'aufruf'; quelle: 'tool_calls'; routing: 'vorhanden' | 'nicht_erfasst';
}
export function netzwerkEreignis(row: ToolCallRow): NetzwerkEreignis {
 const args = netzwerkArgumente(row.args_preview);
 const tool = netzwerkText(row.tool_name.split('__').pop());
 const action = netzwerkText(row.action);
 const sendet = ['send','inbox_send','post'].includes(action);
 const liest = ['get','feed','inbox_check','mark_read'].includes(action);
 const roh = tool === 'chat' && sendet ? args.recipient_id ?? args.to_agent : undefined;
 const empfaenger = (Array.isArray(roh) ? roh : [roh]).filter((x): x is string => typeof x === 'string').map(netzwerkText);
 const channel = tool === 'channel' ? netzwerkText(args.channel_name ?? args.name) || null : null;
 return { id: String(row.id), zeit: new Date(row.ts).toISOString(), project: netzwerkText(row.project), agent: netzwerkText(row.agent_id || row.source || 'unbekannt'),
  identity_id: row.identity_id ?? null, lauf_id: row.lauf_id ?? null, tool, action, ok: row.ok,
  empfaenger, channel, interaktion: sendet ? 'senden' : liest ? 'lesen' : 'aufruf', quelle: 'tool_calls',
  routing: empfaenger.length || channel ? 'vorhanden' : 'nicht_erfasst' };
}
