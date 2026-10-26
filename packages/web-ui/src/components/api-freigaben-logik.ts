/**
 * P22-T180 (Folge aus P22-T179, thought 42fe86c8): Anzeige-Logik "Freigaben je Agent" in Einstellungen > API-Agenten
 * (ApiFreigabenFeld.tsx), ohne React, damit Tests sie direkt pruefen.
 * Daten: GET /api/main-agent/api/freigaben?kandidaten=1 (core apiAgentenStand): Freigaben mit Verbrauch/Rest im Zeitraum des globalen
 *   Budgets, Schalter api_agenten je Projekt, waehlbare Agenten (aktive subagent|koordinator ausserhalb des Main-Bereichs).
 * Setzen/Entziehen nur durch den User mit Grund (PUT/DELETE derselben Route). Kostenpflichtig nie automatisch: ohne Klick keine Freigabe,
 *   Heartbeat Standard AUS (jeder Weckruf kostet).
 */

export interface ApiFreigabeZeile {
  identity_id: string; project: string; agent_id: string; rolle: string; aktiv: boolean; modelle: string[];
  grenze_usd: number | null; heartbeat: boolean; grund: string; user_auftrag: string | null; gesetzt_von: 'user' | 'main'; gesetzt_am: string;
  verbraucht_usd: number; rest_usd: number | null; api_agenten_aktiv?: boolean;
}
export interface ApiFreigabeKandidat { identity_id: string; project: string; agent_id: string; rolle: string; freigabe: boolean; api_agenten_aktiv: boolean }
export interface ApiSchalterJeProjekt { aktiv: boolean; quelle: string; letzter_fehler: string | null }
export interface ApiFreigabenStand {
  /** Schalter api_agenten global (ohne project-Filter) bzw. des abgefragten Projekts. */
  schalter?: ApiSchalterJeProjekt;
  freigaben: ApiFreigabeZeile[];
  kandidaten?: ApiFreigabeKandidat[];
  schalter_je_projekt?: Record<string, ApiSchalterJeProjekt>;
  budget_beginn: string | null;
}
export interface ApiFreigabeFormular { identity_id: string; modelle: string[]; grenze: string; heartbeat: boolean; aktiv: boolean }

const ROLLE_TEXT: Record<string, string> = { subagent: 'Arbeitsagent', koordinator: 'Koordinator' };
export const rolleText = (rolle: string): string => ROLLE_TEXT[rolle] ?? rolle;

const usd = (n: number): string => n.toFixed(4) + ' USD';
const zeit = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE'); };

/** Eine Zeile je Freigabe: Modelle, eigene Grenze, Verbrauch, Rest, Heartbeat, wer/wann. */
export function freigabeZeile(f: ApiFreigabeZeile): string {
  return (f.aktiv ? 'aktiv' : 'pausiert') + ' · Modelle ' + (f.modelle.join(', ') || '–')
    + ' · Grenze ' + (f.grenze_usd === null ? 'nur globales Budget' : usd(f.grenze_usd))
    + ' · verbraucht ' + usd(f.verbraucht_usd) + (f.rest_usd === null ? '' : ' · Rest ' + usd(f.rest_usd))
    + ' · Heartbeat ' + (f.heartbeat ? 'EIN' : 'AUS')
    + ' · gesetzt von ' + (f.gesetzt_von === 'main' ? 'Main (User-Auftrag)' : 'User') + ' am ' + zeit(f.gesetzt_am);
}

export function kandidatLabel(k: ApiFreigabeKandidat): string {
  return k.project + ' · ' + k.agent_id + ' (' + rolleText(k.rolle) + ')' + (k.freigabe ? ' · hat Freigabe' : '');
}

/** Schalter api_agenten im Projekt des Agenten; AUS -> der Server lehnt die Freigabe ab (funktion_aus). */
export function schalterText(project: string, s: ApiSchalterJeProjekt | undefined): { aktiv: boolean; text: string } {
  if (!s) return { aktiv: false, text: 'Schalter api_agenten im Projekt ' + project + ': unbekannt.' };
  return s.aktiv
    ? { aktiv: true, text: 'Schalter api_agenten im Projekt ' + project + ': EIN (' + s.quelle + ').' }
    : { aktiv: false, text: 'Schalter api_agenten im Projekt ' + project + ': AUS (' + s.quelle + '). Eine Freigabe wird dann abgelehnt; einschalten: '
      + 'admin profil_schalter_setzen ebene projekt funktion api_agenten (nur ausdruecklich).' + (s.letzter_fehler ? ' Fehler: ' + s.letzter_fehler : '') };
}

/** Grenze: leer = nur globales Budget (null), sonst Zahl > 0; sonst ungueltig. */
export function grenzeWert(text: string): number | null | 'ungueltig' {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : 'ungueltig';
}

/** Formular pruefen; Body fuer PUT /api/main-agent/api/freigaben (ohne grund, den haengt das Panel an). */
export function freigabeKoerper(f: ApiFreigabeFormular): { ok: true; koerper: Record<string, unknown> } | { ok: false; grund: string } {
  if (!f.identity_id) return { ok: false, grund: 'Agent waehlen.' };
  if (!f.modelle.length) return { ok: false, grund: 'Mindestens ein Modell waehlen.' };
  const g = grenzeWert(f.grenze);
  if (g === 'ungueltig') return { ok: false, grund: 'Grenze muss leer oder eine Zahl > 0 sein.' };
  return { ok: true, koerper: { identity_id: f.identity_id, modelle: [...f.modelle], grenze_usd: g, heartbeat: f.heartbeat, aktiv: f.aktiv } };
}

/** Formular aus einer vorhandenen Freigabe (Bearbeiten) bzw. leer mit Vorschlag Haiku (wenn waehlbar). */
export function formularAus(f: ApiFreigabeZeile | null, modelle: readonly string[]): ApiFreigabeFormular {
  if (f) return { identity_id: f.identity_id, modelle: [...f.modelle], grenze: f.grenze_usd === null ? '' : String(f.grenze_usd), heartbeat: f.heartbeat, aktiv: f.aktiv };
  return { identity_id: '', modelle: modelle.includes('api-haiku') ? ['api-haiku'] : [], grenze: '', heartbeat: false, aktiv: true };
}
