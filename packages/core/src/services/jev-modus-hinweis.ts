/**
 * jev_modus — Zustandszeile bei Start/Refresh und konkreten Änderungen
 * (P7-T30 / JEV-11, 29.09.2026).
 *
 * WARUM IM CODE UND NICHT ALS PROJEKT-REGEL: Die Anweisung "bei Rueckfragen/Unstimmigkeiten
 * Superpowers nutzen, Entscheidungen ueber jev(entscheiden)" gilt in jedem Projekt, in dem der
 * Schalter an ist. Eine Regel (memory) gaehlte nur fuer das Projekt, in dem sie steht.
 *
 * P7-T40: holeJevSitzungsHinweis liefert den Satz beim Start/Refresh und bei Schalteränderung.
 * holeJevModusHinweis bleibt die reine Zustandsabfrage für bestehende Aufrufer.
 * Schalter AUS -> null; die ausführliche Anleitung steht weiterhin im Guide.
 *
 * Damit nicht jeder Tool-Call eine DB-Abfrage kostet, wird der Schalter je Prozess und Projekt kurz
 * gecacht (Standard 30 s, Env JEV_MODUS_CACHE_S; 0 = kein Cache). Ein DB-Fehler ergibt null und wird
 * NICHT gecacht — ein Hinweis darf den Tool-Aufruf nie brechen.
 */

import { leseAbwesenheit } from './jev-entscheidung.js';
import { jevEntscheidungsHinweiseAn } from './jev-schalter.js';
import { hinweisAktiv } from './agent-zuschnitt-kontext.js';

export const JEV_MODUS_ZEILE =
  'User abwesend — Rueckfragen/Unstimmigkeiten: Superpowers nutzen, Entscheidungen per jev(action:entscheiden) ' +
  '(nur erlaubte Kategorien, sonst warten). Wie: guide(tool_name:jev) Abschnitt Vorgehen.';

const STANDARD_CACHE_S = 30;

/** P7-T40: statischer Satz beim Onboarding; später nur bei konkreter Zustandsänderung. */
const agentModus = new Map<string, string | null>();
export async function holeJevSitzungsHinweis(project: string, agentId: string, onboarding = false): Promise<string | null> {
  // P22-T13 Paket C: abgeschaltet -> keine Abfrage, kein Zustandsvermerk (Wiedereinschalten liefert neu).
  if (!hinweisAktiv('jev_modus', agentId)) return null;
  const zeile = await holeJevModusHinweis(project);
  const key = JSON.stringify([project, agentId]);
  const bekannt = agentModus.has(key);
  const vorher = agentModus.get(key);
  agentModus.set(key, zeile);
  return onboarding || (bekannt && vorher !== zeile) ? zeile : null;
}


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
      // P15-T33 E0.5: der Jev-Schalter wirkt sofort (eigener kurzer Cache), nicht erst nach diesem Cache.
      return treffer.aktiv && (await jevEntscheidungsHinweiseAn(project)) ? JEV_MODUS_ZEILE : null;
    }
    const stand = await leseAbwesenheit(project);
    if (dauer > 0) cache.set(project, { bis: jetzt + dauer, aktiv: stand.aktiv });
    return stand.aktiv ? JEV_MODUS_ZEILE : null;
  } catch {
    return null;
  }
}
