/**
 * P22-T201 (Entwurf 07f41a1e A/B, Freigabe T1-T3, Handoff a03ddfd7): Puffer des Schattenstands je Plan und Datei fuer
 * Co-Edit ohne Gate (Schalter coedit_ohne_gate EIN). Prozesslokal, nie persistiert. Die Korrektheit haengt nie am
 * Puffer, nur die Dauer: ohne passenden Eintrag baut der Aufrufer (file-batch.ts) den Schatten wie vorher neu auf.
 *
 * SCHLUESSEL: plan_id + Datei + Basisinhalt (String-Gleichheit, kein Hash noetig) + Kette = Op-Schluessel der auf diese
 *   Datei angewendeten Ops in Plan-Reihenfolge. holePuffer liefert den laengsten Eintrag derselben Basis, dessen Kette ein
 *   Praefix der gesuchten ist (gleich lang = Treffer, kuerzer = Verlaengerung um die fehlenden Ops).
 * GRENZEN: Gesamtgroesse in Bytes (Einstellung schatten_puffer_mb, 0 = aus/Notaus) und hoechstens EINTRAEGE_JE_DATEI
 *   Eintraege je Plan und Datei; der am laengsten nicht genutzte faellt zuerst heraus (LRU).
 * DEBUG: Zaehler je Plan (treffer | verlaengert | neuaufbau | aus) mit Dauer und letztem Fall (plan_status ansicht
 *   befunde, Feld schatten_puffer) sowie gesamt (schattenPufferStatus ohne plan_id).
 * Wirft nie. Importiert nichts (kein Zyklus mit file-batch.ts).
 */

export type SchattenPufferArt = 'treffer' | 'verlaengert' | 'neuaufbau' | 'aus';

interface Eintrag {
  plan_id: string;
  datei: string;
  basis: string;
  kette: string[];
  stand: unknown;
  bytes: number;
  zuletzt: number;
}

export interface SchattenPufferZaehler {
  treffer: number;
  verlaengert: number;
  neuaufbau: number;
  aus: number;
  /** Summe der Dauer aller Puffer-Zugriffe in ms (inklusive Anwenden fehlender Ops). */
  ms: number;
  letzte?: { art: SchattenPufferArt; ops: number; angewendet: number; ms: number; grund?: string; am: string };
}

/** Hoechstens so viele Ketten je Plan und Datei (aktuelle Kette, Vorgaenger, eine Abzweigung). */
export const EINTRAEGE_JE_DATEI = 3;

const eintraege = new Map<string, Eintrag[]>();
const zaehler = new Map<string, SchattenPufferZaehler>();
const gesamt: SchattenPufferZaehler = { treffer: 0, verlaengert: 0, neuaufbau: 0, aus: 0, ms: 0 };
let summeBytes = 0;
let uhr = 0;

function schluessel(planId: string, datei: string): string {
  return planId + '\u0000' + datei;
}

function istPraefix(kurz: string[], lang: string[]): boolean {
  if (kurz.length > lang.length) return false;
  for (let i = 0; i < kurz.length; i++) if (kurz[i] !== lang[i]) return false;
  return true;
}

function entferne(k: string, e: Eintrag): void {
  const liste = eintraege.get(k);
  if (!liste) return;
  const rest = liste.filter((x) => x !== e);
  if (rest.length === liste.length) return;
  summeBytes -= e.bytes;
  if (rest.length > 0) eintraege.set(k, rest); else eintraege.delete(k);
}

/**
 * Laengster Eintrag gleicher Basis, dessen Kette ein Praefix von kette ist; laenge = Anzahl schon angewendeter Ops.
 * Der Stand gehoert dem Puffer: der Aufrufer darf ihn nicht veraendern.
 */
export function holePuffer<S>(planId: string, datei: string, basis: string, kette: string[]): { stand: S; laenge: number } | null {
  const liste = eintraege.get(schluessel(planId, datei));
  if (!liste) return null;
  let bester: Eintrag | null = null;
  for (const e of liste) {
    if (e.basis !== basis || !istPraefix(e.kette, kette)) continue;
    if (!bester || e.kette.length > bester.kette.length) bester = e;
  }
  if (!bester) return null;
  bester.zuletzt = ++uhr;
  return { stand: bester.stand as S, laenge: bester.kette.length };
}

/** Legt den Stand nach kette ab (ersetzt einen Eintrag mit gleicher Basis und Kette) und haelt die Grenzen ein. */
export function legePufferAb<S>(planId: string, datei: string, basis: string, kette: string[], stand: S, bytes: number, grenzeBytes: number): void {
  if (!(grenzeBytes > 0) || bytes > grenzeBytes) return;
  const k = schluessel(planId, datei);
  const liste = eintraege.get(k) ?? [];
  // Gleiche Basis teilen statt je Eintrag eine eigene Kopie desselben Inhalts halten.
  const geteilt = liste.find((e) => e.basis === basis)?.basis ?? basis;
  for (const e of [...liste]) if (e.basis === geteilt && e.kette.length === kette.length && istPraefix(e.kette, kette)) entferne(k, e);
  const neu: Eintrag = { plan_id: planId, datei, basis: geteilt, kette: [...kette], stand, bytes, zuletzt: ++uhr };
  eintraege.set(k, [...(eintraege.get(k) ?? []), neu]);
  summeBytes += bytes;
  let eigene = eintraege.get(k) ?? [];
  while (eigene.length > EINTRAEGE_JE_DATEI) {
    entferne(k, eigene.reduce((a, b) => (b.zuletzt < a.zuletzt ? b : a)));
    eigene = eintraege.get(k) ?? [];
  }
  while (summeBytes > grenzeBytes) {
    let aeltester: { k: string; e: Eintrag } | null = null;
    for (const [kk, l] of eintraege) for (const e of l) if (!aeltester || e.zuletzt < aeltester.e.zuletzt) aeltester = { k: kk, e };
    if (!aeltester) break;
    entferne(aeltester.k, aeltester.e);
  }
}

/** Alle Eintraege eines Plans verwerfen (nach Teilcommit/commit: neue Basis, neue Op-Nummern). Liefert die Anzahl. */
export function verwerfeSchattenPuffer(planId: string): number {
  let n = 0;
  for (const [k, liste] of [...eintraege]) {
    if (liste[0]?.plan_id !== planId) continue;
    for (const e of liste) { summeBytes -= e.bytes; n++; }
    eintraege.delete(k);
  }
  return n;
}

/** Zugriff zaehlen (Debug). */
export function zaehleSchattenPuffer(planId: string, art: SchattenPufferArt, info: { ops: number; angewendet: number; ms: number; grund?: string }): void {
  const z = zaehler.get(planId) ?? { treffer: 0, verlaengert: 0, neuaufbau: 0, aus: 0, ms: 0 };
  z[art]++;
  z.ms += info.ms;
  z.letzte = { art, ops: info.ops, angewendet: info.angewendet, ms: Math.round(info.ms * 10) / 10, ...(info.grund ? { grund: info.grund } : {}), am: new Date().toISOString() };
  zaehler.set(planId, z);
  gesamt[art]++;
  gesamt.ms += info.ms;
  // Zaehler offener Plaene klein halten: hoechstens 500 Plaene, aelteste zuerst raus.
  if (zaehler.size > 500) zaehler.delete(zaehler.keys().next().value as string);
}

/** Debug-Stand je Plan (oder gesamt ohne plan_id). */
export function schattenPufferStatus(planId?: string): Record<string, unknown> {
  const runde = (z: SchattenPufferZaehler) => ({ ...z, ms: Math.round(z.ms) });
  if (planId !== undefined) {
    const z = zaehler.get(planId);
    const liste = [...eintraege.values()].flat().filter((e) => e.plan_id === planId);
    return { ...(z ? runde(z) : { treffer: 0, verlaengert: 0, neuaufbau: 0, aus: 0, ms: 0 }), eintraege: liste.length, bytes: liste.reduce((s, e) => s + e.bytes, 0) };
  }
  return { ...runde(gesamt), eintraege: [...eintraege.values()].reduce((s, l) => s + l.length, 0), bytes: summeBytes, plaene: zaehler.size };
}

/** Alles leeren (Tests, Notaus). */
export function leereSchattenPuffer(): void {
  eintraege.clear();
  zaehler.clear();
  Object.assign(gesamt, { treffer: 0, verlaengert: 0, neuaufbau: 0, aus: 0, ms: 0 });
  delete gesamt.letzte;
  summeBytes = 0;
}
