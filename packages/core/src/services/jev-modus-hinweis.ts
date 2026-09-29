/**
 * jev_modus — eine kurze Zeile an jeder Tool-Antwort, solange der jev-Schalter des Projekts AN ist
 * (P7-T30 / JEV-11, 29.09.2026).
 *
 * WARUM IM CODE UND NICHT ALS PROJEKT-REGEL: Die Anweisung "bei Rueckfragen/Unstimmigkeiten
 * Superpowers nutzen, Entscheidungen ueber jev(entscheiden)" gilt in jedem Projekt, in dem der
 * Schalter an ist. Eine Regel (memory) gaehlte nur fuer das Projekt, in dem sie steht.
 *
 * VEREINFACHUNG (User): KEIN Volltext, keine Drosselung, keine Merker je Agent. Jede Antwort bekommt
 * dieselbe kurze Zeile; der ausfuehrliche Text (Superpowers, erlaubte/verbotene Kategorien, Tor 0.7)
 * steht im guide-Eintrag jev, dorthin verweist die Zeile. Schalter AUS -> null (kein Feld, kein Text).
 *
 * Damit nicht jeder Tool-Call eine DB-Abfrage kostet, wird der Schalter je Prozess und Projekt kurz
 * gecacht (Standard 30 s, Env JEV_MODUS_CACHE_S; 0 = kein Cache). Ein DB-Fehler ergibt null und wird
 * NICHT gecacht — ein Hinweis darf den Tool-Aufruf nie brechen.
 */

import { leseAbwesenheit } from './jev-entscheidung.js';

export const JEV_MODUS_ZEILE =
  'User abwesend — Rueckfragen/Unstimmigkeiten: Superpowers nutzen, Entscheidungen per jev(action:entscheiden) ' +
  '(nur erlaubte Kategorien, sonst warten). Wie: guide(tool_name:jev) Abschnitt Vorgehen.';

const STANDARD_CACHE_S = 30;

const cache = new Map<string, { bis: number; aktiv: boolean }>();

function cacheDauerMs(): number {
  const roh = process.env.JEV_MODUS_CACHE_S?.trim();
  if (!roh) return STANDARD_CACHE_S * 1000;
  const n = Number(roh);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : STANDARD_CACHE_S * 1000;
}

/** Nur fuer Tests: Cache leeren */
export function leereJevModusCache(): void {
  cache.clear();
}

/** Die Zeile bei aktivem Schalter, sonst null. Wirft nie. */
export async function holeJevModusHinweis(project: string, jetzt: number = Date.now()): Promise<string | null> {
  try {
    const dauer = cacheDauerMs();
    const treffer = cache.get(project);
    if (dauer > 0 && treffer && jetzt < treffer.bis) {
      return treffer.aktiv ? JEV_MODUS_ZEILE : null;
    }
    const stand = await leseAbwesenheit(project);
    if (dauer > 0) cache.set(project, { bis: jetzt + dauer, aktiv: stand.aktiv });
    return stand.aktiv ? JEV_MODUS_ZEILE : null;
  } catch {
    return null;
  }
}
