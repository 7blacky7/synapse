/**
 * P22-T13 Paket C (K16.4/K16.8): requestweiter Zuschnitt-Snapshot und Hinweisentscheidung.
 *
 * Leichtgewichtig (nur agent-bezug + hinweis-katalog), damit Produzenten VOR Suche/Claim fragen koennen,
 * ohne Importzyklus und ohne eigene DB-Abfrage. Der Snapshot entsteht EINMAL je Aufruf in
 * bereiteAgentToolAufrufVor (agent-zuschnitt.ts, eine PG-Lesung der aktuellen Profil-/Typrevision) und
 * haengt am AsyncLocalStorage-Kontext des Aufrufs (ueberlebt jeden args-Spread).
 *
 * Ohne Snapshot (Legacy, kein Token, Schalter w1b_antwortanpassung AUS) ist hinweisAktiv() immer true und
 * verursacht keinerlei Abfrage: exakt t109-Verhalten.
 */
import { performance } from 'node:perf_hooks';
import { aktuellerAgentAufruf, type AgentAufrufKontext } from './agent-bezug.js';
import { hinweisEintrag, katalogIdFuerClaimArt, standardFuerStufe, type HinweisStufe } from './hinweis-katalog.js';
import type { ToolZuschnitt } from './tool-gate.js';

export type ZuschnittStufe = HinweisStufe;

export interface ZuschnittLimitAnpassung {
  parameter: string;
  angefragt: number | null;
  wirksam: number;
  grenze: number | null;
  standard: number | null;
}

export interface ZuschnittSnapshot {
  identity_id: string;
  agent_id: string;
  project: string;
  /** '<identity>:<profil_revision>:<typ_id|->:<typ_revision>' - Diagnose/Auditbezug, keine Tokenwerte */
  revision: string;
  /** Schalter w1b_antwortanpassung fuer diesen Aufruf (Snapshot); false = nur Gate */
  anpassung: boolean;
  hinweise: Readonly<Record<string, boolean>>;
  stufe: ZuschnittStufe | null;
  limits: Readonly<Record<string, number>>;
  kontext_budget: number | null;
  herkunft: Readonly<Record<string, string>>;
  zuschnitt: ToolZuschnitt | null;
  zeiten: { start: number; revision_ms: number; erster_hinweis: number | null };
  /** Diagnose: welche optionalen Arten dieser Aufruf unterdrueckt bzw. auf den Pflichtanteil reduziert hat */
  entscheidungen: Record<string, 'aus' | 'pflichtanteil' | 'unklassifiziert'>;
  limit_anpassungen: ZuschnittLimitAnpassung[];
}

const snapshots = new WeakMap<AgentAufrufKontext, ZuschnittSnapshot>();

export function setzeZuschnittSnapshot(s: ZuschnittSnapshot): boolean {
  const k = aktuellerAgentAufruf();
  if (!k) return false;
  snapshots.set(k, s);
  return true;
}

export function aktuellerZuschnittSnapshot(): ZuschnittSnapshot | null {
  const k = aktuellerAgentAufruf();
  return k ? snapshots.get(k) ?? null : null;
}

const zaehler: Record<string, number> = {};
export function zaehle(art: string): void {
  zaehler[art] = (zaehler[art] ?? 0) + 1;
}

/**
 * Entscheidung VOR Suche/Claim eines optionalen Produzenten. agentId = Agent, fuer den der Produzent arbeitet:
 * nur fuer den bestaetigten Aufrufer selbst greift dessen Profil (fremde Empfaenger bleiben unberuehrt).
 * Unbekannte Schluessel werden nie unterdrueckt (Zaehler unklassifiziert).
 */
export function hinweisAktiv(schluessel: string, agentId?: string | null): boolean {
  const s = aktuellerZuschnittSnapshot();
  if (!s || !s.anpassung) return true;
  if (agentId !== undefined && agentId !== null && agentId !== s.agent_id) return true;
  if (s.zeiten.erster_hinweis === null) s.zeiten.erster_hinweis = performance.now();
  const e = hinweisEintrag(schluessel);
  if (!e) {
    s.entscheidungen[schluessel] = 'unklassifiziert';
    zaehle('unklassifiziert');
    return true;
  }
  if (e.klasse === 'pflicht') return true;
  const ausdruecklich = s.hinweise[schluessel] ?? (schluessel !== e.schluessel ? s.hinweise[e.schluessel] : undefined);
  const an = typeof ausdruecklich === 'boolean' ? ausdruecklich : standardFuerStufe(e, s.stufe);
  if (!an) s.entscheidungen[schluessel] = e.pflichtanteile?.length ? 'pflichtanteil' : 'aus';
  return an;
}

/** claimHinweis-Arten ueber ihre Katalog-ID; unbekannte Arten werden nie unterdrueckt. */
export function claimArtAktiv(art: string, agentId?: string | null): boolean {
  return hinweisAktiv(katalogIdFuerClaimArt(art) ?? art, agentId);
}

export interface ZuschnittMessung {
  tool: string;
  action: string | null;
  /** Lesen der aktuellen Profil-/Typrevision (eine PG-Abfrage) */
  revision_ms: number;
  /** ab der ersten optionalen Hinweisentscheidung bis zur Projektion (null = keine optionale Arbeit) */
  hinweise_ms: number | null;
  /** ab Snapshot bis Projektion (enthaelt die Fachaktion) */
  gesamt_ms: number;
  ueber_budget: boolean;
  zeit: string;
}
const messungen: ZuschnittMessung[] = [];

/** Vorhandenes Hinweisbudget (SYNAPSE_HINWEIS_BUDGET_MS, Standard 30 ms) - nur gemessen, keine neue harte Grenze. */
export function hinweisBudgetMs(): number {
  const v = Number(process.env.SYNAPSE_HINWEIS_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

export function merkeZuschnittMessung(m: ZuschnittMessung): void {
  messungen.push(m);
  if (messungen.length > 200) messungen.shift();
  zaehle('projektionen');
  if (m.ueber_budget) zaehle('ueber_budget');
}

/** Diagnose (intern/Tests): Zaehler und die letzten 200 Messungen dieses Prozesses. */
export function holeZuschnittMetriken(): { zaehler: Record<string, number>; letzte: ZuschnittMessung[]; budget_ms: number } {
  return { zaehler: { ...zaehler }, letzte: [...messungen], budget_ms: hinweisBudgetMs() };
}

export function _zuschnittMetrikenZuruecksetzen(): void {
  for (const k of Object.keys(zaehler)) delete zaehler[k];
  messungen.length = 0;
}
