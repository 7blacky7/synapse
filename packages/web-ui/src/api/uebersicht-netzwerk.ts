/**
 * P22-T196: Datenweg der Uebersicht als globales Agentennetzwerk.
 * - Snapshot: GET /api/projects/:p/agentennetzwerk?umfang=global (P22-T232, codex-rea4, thought 6733c4f7): Ereignisse aller fuer den
 *   Betrachter sichtbaren Projekte (ereignis_limit), agenten mit Heimat, projekt_aktivitaeten. Wirkt nur mit globalem Schalter
 *   agentennetzwerk UND netzwerk_datengrundlage; sonst leere Listen (daten_schalter zeigt den Grund).
 * - Produkt-Schalter uebersicht_netzwerk (Standard AUS, nur ausdruecklich): AUS = bisherige Uebersicht. Lesen/Setzen ueber denselben
 *   Dispatcher wie admin profil_schalter_status/_setzen (GET/PUT /api/projects/:p/agent-profile/schalter).
 */
import { apiFetch } from './auth';
import type { NetzSnapshot } from './agentennetzwerk';

export const UEBERSICHT_NETZWERK_FUNKTION = 'uebersicht_netzwerk';
export type GlobalesNetz = NetzSnapshot & {
 umfang?: 'global';
 projekt_aktivitaeten?: Array<{ project: string; letzte_aktivitaet: string | null; aufrufe: number }>;
 daten_schalter?: { aktiv: boolean; quelle: string; letzter_fehler?: string | null };
 /** P22-T239: Index-Groesse je aktivem Projekt (Trabanten, Nebel, Sterngroesse der Sonne), nur mit Einstellung sonnen_effekte. */
 index_projekte?: Array<{ project: string; dateien: number; chunks: number; stand: string }>;
 // P22-T239: plaene (offen + frisch committet) und plaene_ende (geaendert = Zeitpunkt der Statusaenderung, status_geaendert_am) tragen
 // im globalen Umfang das Feld project (NetzPlan.project): Rauten, Commit-Flug und Explosion an der Sonne des Projekts.
};
export interface UebersichtSchalter { funktion: string; aktiv: boolean; quelle: string; ebene: string | null; gesetzt_von?: string | null; letzter_fehler: string | null }

const basis = (project: string) => '/api/projects/' + encodeURIComponent(project || 'synapse');
async function json<T>(pfad: string, init?: RequestInit): Promise<T> {
 const r = await apiFetch(pfad, init), d = await r.json().catch(() => null);
 if (!r.ok || d?.success === false) { const e = d?.error; throw new Error(typeof e === 'string' ? e : e?.code || e?.message || 'HTTP ' + r.status); }
 return d as T;
}
export const ladeGlobalesNetzwerk = (project: string) => json<GlobalesNetz>(basis(project) + '/agentennetzwerk?umfang=global');
/** null = Funktion im Katalog unbekannt (aelterer Server) -> wie AUS. */
export async function leseUebersichtSchalter(project: string): Promise<UebersichtSchalter | null> {
 const d = await json<{ schalter?: UebersichtSchalter[] }>(basis(project) + '/agent-profile/schalter');
 return d.schalter?.find(s => s.funktion === UEBERSICHT_NETZWERK_FUNKTION) ?? null;
}
export async function setzeUebersichtSchalter(project: string, aktiv: boolean): Promise<UebersichtSchalter | null> {
 await json(basis(project) + '/agent-profile/schalter', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ profil_funktion: UEBERSICHT_NETZWERK_FUNKTION, ebene: 'global', aktiv, grund: 'Übersicht als globales Agentennetzwerk ' + (aktiv ? 'einschalten' : 'ausschalten') + ' (P22-T196, Web-UI)' }) });
 return leseUebersichtSchalter(project);
}
