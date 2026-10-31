/**
 * P22-T229 (User 31.10.2026, Screenshot Hauptagent > Arbeitsraum): Visum-Agenten bringen ihre Heimat-Projektsonne mit.
 * Reine Logik ohne DOM/React (testbar mit node --experimental-strip-types); die globale Uebersicht P22-T196 nutzt dieselben
 * Funktionen ("gilt fuer alles"), keine zweite Implementierung.
 *
 * Regeln:
 * - Standard bleibt EINE Projektsonne (das angezeigte Projekt). Erst ein Agent mit fremder Heimat (Visum bzw. Arbeitsfreigabe,
 *   P22-T44) bringt die Sonne seines Heimatprojekts mit; mehrere Heimaten = mehrere Sonnen.
 * - Effekte laufen zur Sonne des Projekts, auf das der Aufruf WIRKT (zielProjekt), nicht zur Heimat des Agenten.
 * - Die fremde Sonne bleibt, solange der Zugang gilt (visum_bis = wirksames Zugangsende inkl. Arbeitsfreigabe, P22-T232;
 *   Fristen admin ausweis_fristen). Ohne bekanntes Zugangsende gilt die letzte Aktivitaet + inaktiv_sekunden (bestehender Wert,
 *   User 31479: kein neues Zeitfenster). Danach blendet sie ueber fremd_sonne_ausblend_sekunden aus.
 * Daten: ereignisse[].heimat_projekt/ziel_projekt/zugang/visum_bis und visa[] aus GET /api/projects/:name/agentennetzwerk (P22-T232).
 * Schalter: Produkt-Schalter netzwerk_visum_sonnen (snapshot.visum_sonnen.aktiv), Standard AUS = bisheriges Verhalten.
 */
import type { NetzEreignis, NetzSnapshot } from '../../api/agentennetzwerk';

/** Projekt, auf das der Aufruf wirkt (P22-T232 ziel_projekt; aeltere Server: project). */
export const zielProjekt = (e: Pick<NetzEreignis, 'project' | 'ziel_projekt'>) => e.ziel_projekt || e.project;
/** Heimatprojekt der aufrufenden Identitaet (P22-T232), null = unbekannt. */
export const heimatProjekt = (e: Pick<NetzEreignis, 'heimat_projekt'>) => e.heimat_projekt || null;

export interface SonnenWerte { ausblendMs: number; inaktivMs: number }
export const SONNEN_STANDARD = { fremd_sonne_ausblend_sekunden: 8, inaktiv_sekunden: 120 } as const;
const zahl = (w: Record<string, number> | undefined, name: keyof typeof SONNEN_STANDARD) => {
 const v = w?.[name]; return typeof v === 'number' && Number.isFinite(v) ? v : SONNEN_STANDARD[name];
};
export const sonnenWerte = (w?: Record<string, number>): SonnenWerte => ({ ausblendMs: zahl(w, 'fremd_sonne_ausblend_sekunden') * 1000, inaktivMs: zahl(w, 'inaktiv_sekunden') * 1000 });

export type SonnenGrund = 'zugang_gueltig' | 'aktiv' | 'zugang_abgelaufen' | 'keine_aktivitaet';
export interface SonnenSicht { fade: number; grund: SonnenGrund; ende: number }
/**
 * Gemeinsame Sichtbarkeit einer Sonne (T229 fremde Sonnen, T196 Projekt-Sonnen): sichtbar bis 'ende', dann linear ausblenden.
 * ende = Zugangsende, falls bekannt, sonst letzte Aktivitaet + inaktivMs. fade 1 = voll, 0 = weg.
 */
export function sonnenSicht(letzte: number, zugangBis: number | null, jetzt: number, w: SonnenWerte): SonnenSicht {
 const ende = zugangBis !== null ? Math.max(zugangBis, letzte) : letzte + w.inaktivMs;
 if (jetzt < ende) return { fade: 1, grund: zugangBis !== null ? 'zugang_gueltig' : 'aktiv', ende };
 const fade = w.ausblendMs > 0 ? Math.max(0, Math.min(1, 1 - (jetzt - ende) / w.ausblendMs)) : 0;
 return { fade, grund: zugangBis !== null ? 'zugang_abgelaufen' : 'keine_aktivitaet', ende };
}
/** Fade zum Zeitpunkt jetzt (je Frame, damit das Ausblenden fliessend laeuft und nicht im Layout-Takt springt). */
export const sonnenFade = (s: Pick<FremdSonne, 'ende' | 'ausblendMs'>, jetzt: number) =>
 jetzt < s.ende ? 1 : s.ausblendMs > 0 ? Math.max(0, Math.min(1, 1 - (jetzt - s.ende) / s.ausblendMs)) : 0;

export interface FremdSonne {
 projekt: string; agenten: string[]; letzte: number; zugangBis: number | null; zugang: string | null;
 fade: number; grund: SonnenGrund; ende: number; ausblendMs: number;
 /** Aufrufe im Snapshot: gesamt bzw. davon im Heimatprojekt (Effekt zur Heimat-Sonne). */
 aufrufe: number; heimatAufrufe: number;
}
/** Gedaechtnis je angezeigtem Projekt (Komponente/Ansicht haelt es): eine Sonne blendet auch dann zu Ende aus, wenn ihre Daten schon aus dem Snapshot gefallen sind. */
export type SonnenGedaechtnis = Map<string, { letzte: number; zugangBis: number | null; zugang: string | null; agenten: Set<string>; aufrufe: number; heimatAufrufe: number }>;
export interface FremdSonnenStand {
 sonnen: FremdSonne[];
 /** Agenten-Schluessel (identity_id, agent) -> Heimatprojekt, nur fuer Heimaten mit sichtbarer Sonne. */
 heimat: Map<string, string>;
 /** Debug: Aufrufe, deren Zielprojekt weder das angezeigte Projekt noch eine sichtbare Sonne ist. */
 ohneSonne: number;
}

const zeitVon = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Fremde Sonnen eines Projekt-Snapshots. Main/Hauptagent ist keine Visum-Sonne (er liest ueberall nur, eigene Gruppe am Kern).
 * Mit gedaechtnis bleibt eine Sonne bis zum Ende ihres Ausblendens, auch wenn Ereignisse/Visa nicht mehr geliefert werden.
 */
export function fremdSonnen(s: NetzSnapshot, jetzt: number, gedaechtnis?: SonnenGedaechtnis): FremdSonnenStand {
 const w = sonnenWerte(s.werte), main = s.agenten.find(a => a.rolle === 'main');
 const istMain = (agent: string, id: string | null) => !!main && (agent === main.agent || (!!id && id === main.identity_id));
 const roh: SonnenGedaechtnis = new Map();
 const eintrag = (p: string) => { let z = roh.get(p); if (!z) { z = { letzte: 0, zugangBis: null, zugang: null, agenten: new Set(), aufrufe: 0, heimatAufrufe: 0 }; roh.set(p, z); } return z; };
 const zuordnung = new Map<string, string>();
 const ereignisse = [...new Map([...s.ereignisse, ...(s.channel_ereignisse ?? [])].map(e => [e.id, e])).values()];
 for (const e of ereignisse) {
  const h = heimatProjekt(e); if (!h || h === s.project || istMain(e.agent, e.identity_id)) continue;
  const z = eintrag(h), t = zeitVon(e.zeit) ?? 0, bis = zeitVon(e.visum_bis);
  z.letzte = Math.max(z.letzte, t); z.aufrufe++; if (zielProjekt(e) === h) z.heimatAufrufe++;
  if (bis !== null) z.zugangBis = Math.max(z.zugangBis ?? 0, bis);
  if (e.zugang) z.zugang = e.zugang;
  if (e.agent) { z.agenten.add(e.agent); zuordnung.set(e.agent, h); }
  if (e.identity_id) zuordnung.set(e.identity_id, h);
 }
 // P22-T232 visa[]: gueltige Zugaenge fremder Identitaeten im Projekt (auch ohne Aufruf im Ereignisfenster).
 for (const v of s.visa ?? []) {
  const h = v.heimat_projekt; if (!h || h === s.project || istMain(v.agent, v.identity_id)) continue;
  const bis = zeitVon(v.visum_bis); if (bis === null || bis <= jetzt) continue;
  const z = eintrag(h); z.zugangBis = Math.max(z.zugangBis ?? 0, bis); if (v.zugang) z.zugang = v.zugang;
  if (v.agent) { z.agenten.add(v.agent); zuordnung.set(v.agent, h); }
  if (v.identity_id) zuordnung.set(v.identity_id, h);
 }
 // Gedaechtnis: neue Daten uebernehmen, Altes behalten, bis es ausgeblendet ist.
 const stand: SonnenGedaechtnis = gedaechtnis ?? new Map();
 for (const [p, z] of roh) {
  const alt = stand.get(p);
  if (!alt) { stand.set(p, z); continue; }
  alt.letzte = Math.max(alt.letzte, z.letzte); alt.zugang = z.zugang ?? alt.zugang;
  // Ein neueres Zugangsende ersetzt das alte (verlaengertes Visum); ein frueheres nur, wenn es aus frischen Daten kommt (entzogen).
  if (z.zugangBis !== null) alt.zugangBis = z.zugangBis;
  for (const a of z.agenten) alt.agenten.add(a);
  alt.aufrufe = z.aufrufe; alt.heimatAufrufe = z.heimatAufrufe;
 }
 const sonnen: FremdSonne[] = [], heimat = new Map<string, string>();
 for (const [p, z] of [...stand].sort(([a], [b]) => a.localeCompare(b))) {
  const sicht = sonnenSicht(z.letzte, z.zugangBis, jetzt, w);
  if (sicht.fade <= 0) { stand.delete(p); continue; }
  sonnen.push({ projekt: p, agenten: [...z.agenten].sort(), letzte: z.letzte, zugangBis: z.zugangBis, zugang: z.zugang, ...sicht, ausblendMs: w.ausblendMs, aufrufe: z.aufrufe, heimatAufrufe: z.heimatAufrufe });
 }
 const sichtbar = new Set(sonnen.map(x => x.projekt));
 for (const [k, p] of zuordnung) if (sichtbar.has(p)) heimat.set(k, p);
 let ohneSonne = 0;
 for (const e of ereignisse) { const zp = zielProjekt(e); if (zp && zp !== s.project && !sichtbar.has(zp) && !istMain(e.agent, e.identity_id)) ohneSonne++; }
 return { sonnen, heimat, ohneSonne };
}

/**
 * Schalter AUS: Aufrufe der Visum-Agenten in ihrem Heimatprojekt (von P22-T232 zusaetzlich geliefert) bleiben unsichtbar,
 * damit AUS genau das bisherige Verhalten zeigt (nur Aufrufe im angezeigten Projekt).
 */
export function ohneHeimatAufrufe(s: NetzSnapshot): NetzSnapshot {
 const fremd = (e: NetzEreignis) => { const h = heimatProjekt(e); return !!h && h !== s.project && zielProjekt(e) !== s.project; };
 if (!s.ereignisse.some(fremd) && !(s.channel_ereignisse ?? []).some(fremd)) return s;
 return { ...s, ereignisse: s.ereignisse.filter(e => !fremd(e)), ...(s.channel_ereignisse ? { channel_ereignisse: s.channel_ereignisse.filter(e => !fremd(e)) } : {}) };
}

/** Lichtfarbe einer fremden Sonne, fest je Projektname (mehrere Sonnen unterscheidbar, keine Zufallsfarbe). */
const SONNEN_FARBEN = ['#fcd34d', '#93c5fd', '#f9a8d4', '#86efac', '#c4b5fd', '#fdba74', '#67e8f9'];
export function sonnenFarbe(projekt: string) { let h = 0; for (let i = 0; i < projekt.length; i++) h = (h * 31 + projekt.charCodeAt(i)) >>> 0; return SONNEN_FARBEN[h % SONNEN_FARBEN.length]; }

/** Debugtext je Sonne (Erklaerungen an, data-fremd-sonnen). */
export function sonnenDebug(f: FremdSonne, jetzt: number) {
 const uhr = (t: number | null) => t === null ? '–' : new Date(t).toLocaleTimeString('de-DE');
 return f.projekt + ' (' + f.agenten.length + ' Agent' + (f.agenten.length === 1 ? '' : 'en') + ', ' + f.grund + (f.zugang ? ', ' + f.zugang : '')
  + ', bis ' + uhr(f.ende) + (jetzt >= f.ende ? ', blendet aus ' + Math.round(sonnenFade(f, jetzt) * 100) + ' %' : '') + ', ' + f.heimatAufrufe + '/' + f.aufrufe + ' Aufrufe daheim)';
}
