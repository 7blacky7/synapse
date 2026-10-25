/**
 * P22-T93: ein Vertrag fuer Produkt-Freigabe, Einstellungen und sichere Netzwerk-Metadaten.
 * Kein Nachrichteninhalt/Argument/Resultat verlaesst diese Projektion.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { pflichtText, pruefeProfilVerwalter, ProfilVerwaltungFehler } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import type { ToolCallRow } from './tool-call-log.js';
import { netzwerkErgebnis, type NetzErgebnisArt, type NetzErgebnisRoh } from './agentennetzwerk-ergebnis.js';

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
 // P22-T104: abgeschlossene Plaene nur kurz zeigen (User: 30 s viel zu lang); committet (gruen) und auto-committet (blau) getrennt.
 plan_nachleuchten_sekunden: { standard: 3, min: 1, max: 300 },
 plan_nachleuchten_auto_sekunden: { standard: 3, min: 1, max: 300 },
 plan_mindestanzeige_sekunden: { standard: 3, min: 1, max: 30 },
 // P22-T149: Datei-Trabanten, Chunk-Nebel und Sterngroesse aus dem Index (1 an, 0 = Rueckfall auf die feste Darstellung).
 orbit_nebel: { standard: 1, min: 0, max: 1 },
 // P22-T148: Artefakte und Nachrichten an den User als eigene Animation am Urheber (1 an, 0 = nur Feed-Eintrag).
 an_user_animation: { standard: 1, min: 0, max: 1 },
 // P22-T153 (User 25.10.2026): bisher fest codierte Darstellungszahlen, live ohne Deploy. Standard = Code-Stand vom 25.10.2026.
 // Nur Ganzzahlen: Kommawerte in Milli-Einheiten, die Einheit steht im Namen (_promille, _mrad, _mrad_s = Kreisfrequenz in
 // Milliradiant je Sekunde, Periode = 6283 / Wert Sekunden). Wirkung beim naechsten Snapshot bzw. Abgleich.
 // Index-Ebenen (Web-UI netzwerk/index-ebenen.ts): Stern 100 % ab stern_voll_dateien, je Trabant/Nebelpunkt so viele Dateien/Chunks.
 stern_voll_dateien: { standard: 10000, min: 100, max: 1000000 },
 stern_min_promille: { standard: 80, min: 10, max: 1000 },
 // P22-T162 (User 25.10.2026): Projektsonne waechst bis stern_voll_dateien auf stern_max_promille (1000 = bisherige Groesse, bis 200 %).
 stern_max_promille: { standard: 1000, min: 1000, max: 2000 },
 dateien_je_trabant: { standard: 100, min: 1, max: 100000 },
 trabanten_einzeln: { standard: 300, min: 0, max: 2000 },
 chunks_je_nebelpunkt: { standard: 100, min: 1, max: 100000 },
 nebel_max: { standard: 10000, min: 0, max: 20000 },
 // Nebel-Treiben, -Drehen und -Pulsieren (Amplitude in Promille des Nebelradius bzw. mrad, Tempo in mrad/s).
 nebel_treiben_x_promille: { standard: 25, min: 0, max: 200 },
 nebel_treiben_y_promille: { standard: 20, min: 0, max: 200 },
 nebel_treiben_x_mrad_s: { standard: 45, min: 0, max: 2000 },
 nebel_treiben_y_mrad_s: { standard: 37, min: 0, max: 2000 },
 nebel_drehung_mrad: { standard: 50, min: 0, max: 1000 },
 nebel_drehung_mrad_s: { standard: 21, min: 0, max: 2000 },
 nebel_puls_promille: { standard: 120, min: 0, max: 500 },
 nebel_puls_mrad_s: { standard: 500, min: 0, max: 5000 },
 nebel_schimmer_mrad_s: { standard: 800, min: 0, max: 5000 },
 // Index-Reaktion (P22-T152): Glanz neuer Punkte, Verglimmen, Impulsring, Buendelungsfenster, Kappen.
 glanz_ms: { standard: 4300, min: 500, max: 30000 },
 glanz_anstieg_ms: { standard: 300, min: 0, max: 5000 },
 glanz_abkling_ms: { standard: 1300, min: 100, max: 20000 },
 verglimmen_ms: { standard: 1500, min: 100, max: 20000 },
 impuls_ms: { standard: 2200, min: 300, max: 20000 },
 impuls_abstand_ms: { standard: 1200, min: 0, max: 20000 },
 impulse_max: { standard: 2, min: 1, max: 8 },
 glanz_max: { standard: 400, min: 0, max: 2000 },
 trabanten_impuls_reichweite: { standard: 40, min: 0, max: 400 },
 // Ablaeufe: Commit-Flug, Explosion, Kernwelle, Aufflackern der Trabanten, Bahnen, Sternenstaub.
 commit_flug_ms: { standard: 1600, min: 300, max: 10000 },
 explosion_ms: { standard: 1900, min: 300, max: 10000 },
 kernwelle_ms: { standard: 1700, min: 300, max: 10000 },
 orbit_flare_ms: { standard: 800, min: 100, max: 5000 },
 trabanten_bahnen_max: { standard: 8, min: 1, max: 16 },
 deko_sterne: { standard: 420, min: 0, max: 2000 },
 // Server: Index-Cache je Projekt (P22-T152 adaptiv: Zaehlung unter index_billig_ms -> index_cache_schnell_ms, sonst index_cache_ms).
 index_cache_ms: { standard: 30000, min: 1000, max: 600000 },
 index_cache_schnell_ms: { standard: 10000, min: 1000, max: 600000 },
 index_billig_ms: { standard: 100, min: 1, max: 10000 },
 // P22-T156: Ergebnis-Effekte auf der halben Strecke Agent -> Projekt (1 an; 0 = jede Fehlerart mit dem bisherigen roten Fehlerimpuls).
 fehler_effekte: { standard: 1, min: 0, max: 1 },
 fehler_effekt_ms: { standard: 1400, min: 300, max: 6000 },
 // Haltezeit eines wartenden Aufrufs (Rueckfrage); die Bestaetigung ist aus tool_calls nicht zuordenbar (R5).
 wartet_halte_ms: { standard: 8000, min: 1000, max: 60000 },
} as const;
export type NetzwerkEinstellung = keyof typeof NETZWERK_EINSTELLUNGEN;
export type NetzwerkWerte = Record<NetzwerkEinstellung, number>;
/** P22-T153: Einheit aus dem Namen (fuer status und das Formular der Web-UI); leer = Anzahl bzw. Schalter. */
export function netzwerkEinheit(name: string): string {
 if (name.endsWith('_mrad_s')) return 'mrad/s (Periode = 6283 / Wert s)';
 if (name.endsWith('_mrad')) return 'mrad';
 if (name.endsWith('_promille')) return 'Promille';
 if (name.endsWith('_ms')) return 'ms';
 if (name.endsWith('_sekunden')) return 's';
 return '';
}
export const NETZWERK_ADMIN_PARAMETER = {
 netzwerk_modus: { type: 'string', enum: ['status','einstellen'], description: 'agentennetzwerk: Diagnose oder persistente globale Einstellungen (User/Koordinator)' },
 // P22-T153: keine Namensliste mehr (ueber 40 Namen); status nennt Namen, Grenzen, Einheit und Quelle, Gruppen im Fall-Skill.
 netzwerk_werte: { type: 'object', additionalProperties: { type: 'number' }, description: 'agentennetzwerk einstellen: {name: Ganzzahl}; Namen, min/max, Einheit und Quelle liefert netzwerk_modus status (Fall-Skill fall-admin-agentennetzwerk)' },
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
 const einstellungen: Record<string, { wert: number; quelle: string; min: number; max: number; einheit?: string }> = {};
 const einheit = (name: string) => { const e = netzwerkEinheit(name); return e ? { einheit: e } : {}; };
 for (const [name, d] of Object.entries(NETZWERK_EINSTELLUNGEN)) {
  werte[name as NetzwerkEinstellung] = d.standard;
  einstellungen[name] = { wert: d.standard, quelle: 'standard', min: d.min, max: d.max, ...einheit(name) };
 }
 let letzter_fehler: string | null = null;
 try {
  const r = await getPool().query('SELECT name,wert FROM agentennetzwerk_einstellungen');
  for (const z of r.rows) {
   const d = NETZWERK_EINSTELLUNGEN[z.name as NetzwerkEinstellung];
   if (d && Number.isInteger(z.wert) && z.wert >= d.min && z.wert <= d.max) {
    werte[z.name as NetzwerkEinstellung] = z.wert;
    einstellungen[z.name] = { wert: z.wert, quelle: 'einstellung', min: d.min, max: d.max, ...einheit(z.name) };
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
 /** P22-T148: Artefakt bzw. Nachricht an den User; Urheber = agent/identity_id. 'user'/'system' stehen nie in empfaenger. */
 art?: 'an_user' | 'artefakt';
 /** P22-T156: serverseitig abgeleitete Ergebnisart (ok allein sagt nichts: success:false steht oft mit ok=true im Audit). */
 ergebnis_art: NetzErgebnisArt;
 /** P22-T156: normalisierter Fehlercode ([a-z0-9_], max. 40), null bei erfolg/leer. Nie Rohtext. */
 fehler_code: string | null;
}
/** P22-T156: Aufruf gilt als erfolgreich (Art erfolg/leer). */
export const netzwerkErfolg = (e: Pick<NetzwerkEreignis, 'ergebnis_art'>) => e.ergebnis_art === 'erfolg' || e.ergebnis_art === 'leer';
/** P22-T148: keine Agenten, werden nie zu Netzwerk-Knoten. */
export const NETZWERK_KEIN_AGENT: readonly string[] = ['user', 'system'];
/**
 * P22-T155: agent nur aus agent_id (nie aus source 'cloud'/'stdio'); Zeilen ohne agent_id und identity_id filtert die Projektion
 * (rest-api ladeAgentennetzwerk) vorher heraus und zaehlt sie als ohne_absender.
 */
export function netzwerkEreignis(row: ToolCallRow & Omit<Partial<NetzErgebnisRoh>, 'ok'>): NetzwerkEreignis {
 const args = netzwerkArgumente(row.args_preview);
 const tool = netzwerkText(row.tool_name.split('__').pop());
 const action = netzwerkText(row.action);
 const sendet = ['send','inbox_send','post'].includes(action);
 const liest = ['get','feed','inbox_check','mark_read'].includes(action);
 const roh = tool === 'chat' && sendet ? args.recipient_id ?? args.to_agent : undefined;
 const genannt = (Array.isArray(roh) ? roh : [roh]).filter((x): x is string => typeof x === 'string').map(netzwerkText);
 // P22-T148: 'user' und 'system' sind keine Agenten; eine Nachricht an den User wird eine eigene Art am Urheber, nie ein Knoten.
 const empfaenger = genannt.filter(x => !NETZWERK_KEIN_AGENT.includes(x.toLowerCase()));
 const art = tool === 'artefakt' && action === 'zeigen' ? 'artefakt' as const : genannt.some(x => x.toLowerCase() === 'user') ? 'an_user' as const : null;
 const channel = tool === 'channel' ? netzwerkText(args.channel_name ?? args.name) || null : null;
 return { id: String(row.id), zeit: new Date(row.ts).toISOString(), project: netzwerkText(row.project), agent: netzwerkText(row.agent_id || ''),
  identity_id: row.identity_id ?? null, lauf_id: row.lauf_id ?? null, tool, action, ok: row.ok,
  empfaenger, channel, interaktion: sendet ? 'senden' : liest ? 'lesen' : 'aufruf', quelle: 'tool_calls',
  routing: empfaenger.length || channel || art ? 'vorhanden' : 'nicht_erfasst', ...(art ? { art } : {}), ...netzwerkErgebnis(row) };
}
