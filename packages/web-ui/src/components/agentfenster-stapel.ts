import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './agentfenster-ueber-hud.css';

/**
 * P22-T280 (User 08.11.2026 ~14:40 / ~16:45): Hauptagent- und Koordinatorfenster lassen sich über das HUD legen.
 * EIN Mechanismus fuer alle Agentenfenster:
 *  - Stapel: gemeinsame Reihenfolge (unten -> oben); das zuletzt fokussierte bzw. geoeffnete Fenster liegt oben.
 *  - Ebene: Basis + Platz im Stapel. Ueber dem HUD (Schalter EIN) Band 1251..1290: ueber Seitenleiste, Koordinator-/Assistentenleiste
 *    (55/58), Channel-Fenster (350) und Inbox (1200); unter Lesefenstern (1300+, Lesefenster.tsx), Modell-Chip-Menue (1399) und
 *    Zitat-Menue (1400). Im Hauptbereich (Schalter AUS) bleibt das bisherige Band ab 52 (Altverhalten der Koordinatorfenster).
 *  - Ort: ueber dem HUD haengt das Fenster per Portal an .synapse-control (wie Lesefenster/Channel-Fenster: Theme-Variablen bleiben)
 *    und liegt fest im Viewport; sonst bleibt es, wo es war (in .control-main bzw. .agent-stage). Das HUD bleibt bedienbar, weil
 *    nur die Fenster selbst ueber ihm liegen, keine Flaeche dazwischen.
 * Produkt-Schalter web_ui_agentfenster (je Projekt/global, Standard AUS, nur ausdruecklich; SynapseWorkspace liest ihn).
 * DEBUG: data-agentfenster (hud|aus) und data-agentfenster-ebene am Fenster, data-agentfenster(-quelle|-fehler) an .synapse-control,
 * stapelDebug() bzw. window.__agentfensterStapel() im Browser.
 */
export const AGENTFENSTER_SCHALTER = 'web_ui_agentfenster';
export const AGENTFENSTER_EBENE_UEBER_HUD = 1250;
export const AGENTFENSTER_EBENE_HAUPTBEREICH = 52;
const MAX_FENSTER = 40;

let reihenfolge: readonly string[] = [];
const hoerer = new Set<() => void>();
const melde = (): void => { for (const h of hoerer) h(); };

/** Fenster nach vorne holen (Fokus, Oeffnen). Unbekannte IDs werden aufgenommen. */
export function holeNachVorne(id: string): void {
  if (reihenfolge[reihenfolge.length - 1] === id) return;
  reihenfolge = [...reihenfolge.filter((x) => x !== id), id].slice(-MAX_FENSTER);
  melde();
}

/** Geschlossenes bzw. eingeklapptes Fenster aus dem Stapel nehmen. */
export function entferneFenster(id: string): void {
  if (!reihenfolge.includes(id)) return;
  reihenfolge = reihenfolge.filter((x) => x !== id);
  melde();
}

/** z-index eines Fensters: Basis + Platz im Stapel; nie gesehene Fenster liegen ganz unten im Band. Rein. */
export function fensterEbene(liste: readonly string[], id: string, ueberHud: boolean): number {
  const i = liste.indexOf(id);
  return (ueberHud ? AGENTFENSTER_EBENE_UEBER_HUD : AGENTFENSTER_EBENE_HAUPTBEREICH) + (i < 0 ? 0 : i + 1);
}

const abonniere = (h: () => void): (() => void) => { hoerer.add(h); return () => { hoerer.delete(h); }; };
const lese = (): readonly string[] => reihenfolge;

/** Aktuelle Reihenfolge (unten -> oben); rendert neu, sobald ein Fenster nach vorne kommt. */
export function useAgentFensterStapel(): readonly string[] {
  return useSyncExternalStore(abonniere, lese, lese);
}

/**
 * P22-T289 Nachbesserung: EIN Fenster je Identitaet. Jedes offene Agentenfenster (AgentFenster: Koordinator-Dock, Channel, Agententeam)
 * meldet seine Identitaet; wer ein Fenster oeffnen will, fragt zuerst offenesFensterFuer und holt ein vorhandenes nach vorne.
 */
const identitaeten = new Map<string, string>();
export function meldeFensterIdentitaet(stapelId: string, identityId: string | null | undefined): () => void {
  if (!identityId) return () => undefined;
  identitaeten.set(identityId, stapelId);
  return () => { if (identitaeten.get(identityId) === stapelId) identitaeten.delete(identityId); };
}
export function offenesFensterFuer(identityId: string | null | undefined): string | null {
  return identityId ? identitaeten.get(identityId) ?? null : null;
}

export function stapelDebug(): { basis_ueber_hud: number; basis_hauptbereich: number; reihenfolge: string[]; identitaeten: Record<string, string> } {
  return { basis_ueber_hud: AGENTFENSTER_EBENE_UEBER_HUD, basis_hauptbereich: AGENTFENSTER_EBENE_HAUPTBEREICH, reihenfolge: [...reihenfolge],
    identitaeten: Object.fromEntries(identitaeten) };
}
if (typeof window !== 'undefined') (window as unknown as { __agentfensterStapel?: typeof stapelDebug }).__agentfensterStapel = stapelDebug;

/** Portal-Ziel wie bei den Lesefenstern: .synapse-control (Theme-Variablen, Schriften), sonst body. */
export function agentFensterZiel(): Element | null {
  return typeof document === 'undefined' ? null : document.querySelector('.synapse-control') ?? document.body;
}

/**
 * Linke obere Ecke des Hauptbereichs im Viewport. Fensterpositionen gelten im Hauptbereich (AUS) relativ zu ihm, ueber dem HUD
 * (EIN) relativ zum Viewport; beim Umschalten wird damit umgerechnet, damit das Fenster nicht springt.
 */
export function hauptbereichUrsprung(): { x: number; y: number } {
  const r = typeof document === 'undefined' ? null : document.querySelector('.control-main')?.getBoundingClientRect();
  return { x: Math.round(r?.left ?? 0), y: Math.round(r?.top ?? 0) };
}

/** Kinder ueber dem HUD per Portal an der Wurzel zeichnen, sonst an Ort und Stelle. */
export function AgentFensterOrt({ ueberHud, children }: { ueberHud: boolean; children: ReactNode }) {
  const ziel = ueberHud ? agentFensterZiel() : null;
  return ziel ? createPortal(children, ziel) : createElement(Fragment, null, children);
}
