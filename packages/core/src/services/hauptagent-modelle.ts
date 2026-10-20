/**
 * P22-T62: Modelle des Hauptagenten aus den AUSGELESENEN Listen beider CLI-Container (P22-T61) statt fester Werte.
 *
 * KATALOG: die rest-api registriert eine Quelle (registriereCliModellKatalog -> driver.modelle, 60 s zwischengespeichert);
 *   core kennt kein Docker. Ohne Quelle/Liste: leere Liste + grund.
 * MODELL-IDS in Synapse: Claude = Katalog-ID der CLI (claude-opus-5-5) oder Registry-Alias (opus, sonnet[1m], api-*);
 *   Codex = 'codex/<slug>' (slug = ID der Codex-CLI, z. B. codex/gpt-6-luna) bzw. 'codex' = Standard der CLI (kein -m).
 *   Das Praefix haelt Codex-Modelle eindeutig der Codex-Runtime zu (Wrapper/agents models.ts loest es zu 'codex exec -m <slug>').
 * PRUEFUNG (pruefeModellFuerRuntime): gelistet = steht in der Liste der Ziel-Runtime; nicht gelistet -> ehrliche Meldung
 *   (grund modell_nicht_gelistet), kein stilles Ersetzen. Ohne lesbare Liste nur die Zuordnung zur Runtime (gelistet null).
 * STANDARD (standardModellFuerRuntime): User-Wahl je Runtime (startrezept.modell_je_runtime, geschrieben beim completed
 *   Wechsel durch User/Main, nie durch die Ueberwachung) vor dem KLEINSTEN Modell der Liste (waehleKleinstesModell,
 *   Familienordnung FAMILIEN_ORDNUNG laut User-Entscheidung Option B; unbekannte Familie wird gemeldet, nie geraten).
 *
 * SCHALTER 'hauptagent_cli_modelle' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, Standard AUS, nur ausdruecklich):
 *   wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global) > AUS.
 *   AUS = Altverhalten: Codex nur Registry-Aliase 'codex*', Claude alles andere; Standard 'codex' bzw. Runtime-Modell/'sonnet'.
 * DEBUG: GET /api/main-agent/modelle (Listen, Standard je Runtime mit quelle/grund, Schalter mit Quelle).
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';

export const HAUPTAGENT_CLI_MODELLE_FUNKTION = 'hauptagent_cli_modelle' as const;
export const CLI_MODELL_RUNTIMES = ['claude', 'codex'] as const;
export type CliModellRuntime = typeof CLI_MODELL_RUNTIMES[number];
/** Praefix der Codex-Modelle in Synapse ('codex/<slug>'). */
export const CODEX_MODELL_PRAEFIX = 'codex/';
/** Registry-Alias = Standard der Codex-CLI (kein -m). */
export const CODEX_CLI_STANDARD = 'codex';

type Q = QueryConfig & { query_timeout: number };

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export interface CliModelleSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}

/** Frisch je Aufruf (kein Cache). Lesefehler -> AUS mit letzter_fehler. */
export async function leseCliModelleSchalter(): Promise<CliModelleSchalter> {
  const basis: CliModelleSchalter = { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  // Dynamisch wie runtime-ueberwachung.ts (Importzyklus ueber intern-tool).
  const { internToolAktiv } = await import('./intern-tool.js');
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [HAUPTAGENT_CLI_MODELLE_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  const p = await leseProfilProduktSchalter(HAUPTAGENT_CLI_MODELLE_FUNKTION, null);
  if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
  return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
}

// ---------------------------------------------------------------------------------------------
// Katalog (Quelle registriert die rest-api)
// ---------------------------------------------------------------------------------------------
export interface KatalogModell {
  /** ID der CLI (claude: Katalog-ID, codex: slug). */
  id: string;
  name: string;
  beschreibung: string | null;
  sichtbar: boolean;
  /** claude: section (main/overflow). */
  gruppe: string | null;
  /** claude: runtime.family des Katalogs. */
  familie: string | null;
  /** codex: von der CLI als Standard markiert. */
  standard: boolean;
  /** P22-T65: Effort-Stufen der CLI fuer dieses Modell und ihr Standard (claude default_effort, codex default_reasoning_level). */
  effort_stufen?: string[];
  standard_effort?: string | null;
}
export interface CliKatalog {
  modelle: KatalogModell[];
  grund: string | null;
  /** P22-T65: claude config.provider_alias_targets (Kurzname -> Katalog-ID). */
  alias_ziele?: Record<string, string>;
}
export type CliKatalogQuelle = (runtime: CliModellRuntime) => Promise<CliKatalog>;

let katalogQuelle: CliKatalogQuelle | null = null;
export function registriereCliModellKatalog(q: CliKatalogQuelle | null): void { katalogQuelle = q; }

export async function leseCliKatalog(runtime: CliModellRuntime): Promise<CliKatalog> {
  if (!katalogQuelle) return { modelle: [], grund: 'katalog_quelle_fehlt' };
  try {
    const k = await katalogQuelle(runtime);
    return { modelle: Array.isArray(k?.modelle) ? k.modelle : [], grund: k?.grund ?? null, alias_ziele: k?.alias_ziele ?? {} };
  } catch (err) {
    return { modelle: [], grund: 'katalog_fehler: ' + ((err as Error)?.message ?? String(err)).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------------------------
/** CLI-ID -> Synapse-Modell-ID (codex: 'codex/<slug>'). */
export function synapseModellId(runtime: CliModellRuntime, cliId: string): string {
  return runtime === 'codex' ? CODEX_MODELL_PRAEFIX + cliId : cliId;
}

/** Codex-slug aus 'codex/<slug>' (oder null). */
export function codexSlugAus(modell: string): string | null {
  return modell.startsWith(CODEX_MODELL_PRAEFIX) && modell.length > CODEX_MODELL_PRAEFIX.length ? modell.slice(CODEX_MODELL_PRAEFIX.length) : null;
}

/** Altregel (Schalter AUS, P22-T6c): Codex-Container nur 'codex*', Claude-Container alles andere. */
export function modellPasstAltregel(modell: string | null | undefined, runtime: string): boolean {
  if (!modell) return false;
  return runtime === 'codex' ? /^codex/.test(modell) : !/^codex/.test(modell);
}

/** Registry-Aliase der Claude-CLI (rein, versioniert, [1m]) und API-Aliase: loest die CLI bzw. die Registry selbst auf. */
const CLAUDE_REGISTRY_ALIAS = /^(opus|sonnet|haiku|fable)([-.0-9]*)(\[1m\])?$|^api-[a-z0-9-]+$/;

// ---------------------------------------------------------------------------------------------
// Pruefung
// ---------------------------------------------------------------------------------------------
export interface ModellPruefung {
  passt: boolean;
  /** Normalisierte Synapse-ID (codex: 'codex/<slug>'). */
  modell: string;
  /** true/false = gegen die Liste geprueft; null = ohne Liste bzw. Alias. */
  gelistet: boolean | null;
  grund: string | null;
  quelle: 'schalter_aus' | 'liste' | 'alias' | 'ohne_liste';
}

/**
 * Passt ein Modell zur Runtime? Schalter AUS: Altregel. EIN: gegen die ausgelesene Liste (Codex: bare slug wird zu
 * 'codex/<slug>' normalisiert). Nie still ersetzen: der Aufrufer meldet grund.
 */
export async function pruefeModellFuerRuntime(modellRoh: string | null | undefined, runtime: string,
  o: { schalter?: boolean } = {}): Promise<ModellPruefung> {
  const modell = typeof modellRoh === 'string' ? modellRoh.trim() : '';
  const ein = o.schalter ?? (await leseCliModelleSchalter()).aktiv;
  if (!ein) return { passt: modellPasstAltregel(modell, runtime), modell, gelistet: null, grund: null, quelle: 'schalter_aus' };
  if (!modell) return { passt: false, modell, gelistet: null, grund: 'modell_leer', quelle: 'ohne_liste' };
  if (runtime === 'codex') {
    if (modell === CODEX_CLI_STANDARD) return { passt: true, modell, gelistet: null, grund: null, quelle: 'alias' };
    if (CLAUDE_REGISTRY_ALIAS.test(modell) || /^claude-/.test(modell)) {
      return { passt: false, modell, gelistet: false, grund: 'modell_gehoert_zu_claude', quelle: 'ohne_liste' };
    }
    const slug = codexSlugAus(modell) ?? modell;
    const norm = synapseModellId('codex', slug);
    const k = await leseCliKatalog('codex');
    if (!k.modelle.length) {
      return { passt: modell.startsWith(CODEX_MODELL_PRAEFIX), modell: norm, gelistet: null, grund: 'modellliste_fehlt: ' + (k.grund ?? 'leer'), quelle: 'ohne_liste' };
    }
    const gelistet = k.modelle.some(m => m.id === slug);
    return { passt: gelistet, modell: norm, gelistet, grund: gelistet ? null : 'modell_nicht_gelistet', quelle: 'liste' };
  }
  if (runtime !== 'claude') return { passt: modellPasstAltregel(modell, runtime), modell, gelistet: null, grund: null, quelle: 'alias' };
  if (modell === CODEX_CLI_STANDARD || modell.startsWith(CODEX_MODELL_PRAEFIX)) {
    return { passt: false, modell, gelistet: false, grund: 'modell_gehoert_zu_codex', quelle: 'ohne_liste' };
  }
  if (CLAUDE_REGISTRY_ALIAS.test(modell)) return { passt: true, modell, gelistet: null, grund: null, quelle: 'alias' };
  const k = await leseCliKatalog('claude');
  const basisId = modell.replace(/\[1m\]$/, '');
  if (k.modelle.length) {
    const gelistet = k.modelle.some(m => m.id === basisId);
    if (gelistet) return { passt: true, modell, gelistet, grund: null, quelle: 'liste' };
    // Ein Codex-slug ohne Praefix ist kein Claude-Modell.
    const codex = await leseCliKatalog('codex');
    const grund = codex.modelle.some(m => m.id === modell) ? 'modell_gehoert_zu_codex' : 'modell_nicht_gelistet';
    return { passt: false, modell, gelistet: false, grund, quelle: 'liste' };
  }
  return { passt: /^claude-/.test(modell), modell, gelistet: null, grund: 'modellliste_fehlt: ' + (k.grund ?? 'leer'), quelle: 'ohne_liste' };
}

// ---------------------------------------------------------------------------------------------
// Standard
// ---------------------------------------------------------------------------------------------
/**
 * Familienordnung (User-Entscheidung Option B zu Rueckfrage d1577424, 20.10.2026): die Kataloge tragen kein Groessen-/Kosten-
 * /Rangfeld, deshalb eine kleine Ordnung je Runtime ueber die FAMILIE (nicht ueber Modell-IDs).
 *   claude: runtime.family des Katalogs; codex: letzter Namensteil des slugs (gpt-6-luna -> luna).
 */
export const FAMILIEN_ORDNUNG: Record<CliModellRuntime, readonly string[]> = {
  claude: ['haiku', 'sonnet', 'opus', 'fable'],
  codex: ['luna', 'terra', 'sol', 'astra'],
};

/** Familie eines Katalogmodells (claude: familie; codex: Endung des slugs) oder null. */
export function modellFamilie(runtime: CliModellRuntime, m: KatalogModell): string | null {
  if (runtime === 'claude') return m.familie?.trim().toLowerCase() || null;
  const f = /-([a-z]+)$/.exec(m.id.toLowerCase());
  return f ? f[1] : null;
}

/**
 * Kleinstes Modell einer Runtime aus den Katalogdaten: nur sichtbare, aktuelle Modelle (claude: section 'main';
 * codex: sichtbar = visibility list), davon die kleinste Familie laut FAMILIEN_ORDNUNG; innerhalb einer Familie gewinnt die
 * neueste Generation laut Listenreihenfolge (erstes Modell der Liste; Codex-Liste nach priority). Modelle mit
 * unbekannter Familie werden nicht geraten, sondern im grund genannt; bleibt keins uebrig -> id null + grund.
 */
export function waehleKleinstesModell(runtime: CliModellRuntime, k: CliKatalog): { id: string | null; grund: string | null } {
  if (!k.modelle.length) return { id: null, grund: 'modellliste_fehlt: ' + (k.grund ?? 'leer') };
  const ordnung = FAMILIEN_ORDNUNG[runtime];
  const aktuell = k.modelle.filter(m => m.sichtbar && (runtime !== 'claude' || m.gruppe === 'main'));
  if (!aktuell.length) return { id: null, grund: 'keine_sichtbaren_aktuellen_modelle (' + runtime + ')' };
  const unbekannt: string[] = [];
  let best: { m: KatalogModell; rang: number } | null = null;
  for (const m of aktuell) {
    const fam = modellFamilie(runtime, m);
    const rang = fam ? ordnung.indexOf(fam) : -1;
    if (rang < 0) { unbekannt.push(m.id + (fam ? '=' + fam : '')); continue; }
    // Gleiche Familie: das erste Modell der Liste (neueste Generation laut Listenreihenfolge) bleibt.
    if (!best || rang < best.rang) best = { m, rang };
  }
  const hinweis = unbekannt.length ? '; unbekannte Familie (nicht beruecksichtigt): ' + unbekannt.join(', ') : '';
  if (!best) return { id: null, grund: 'keine_bekannte_familie (' + runtime + ')' + hinweis };
  return {
    id: best.m.id,
    grund: 'kleinste Familie ' + ordnung[best.rang] + ' (' + ordnung.join(' < ') + '), nur '
      + (runtime === 'claude' ? 'section main' : 'visibility list') + ', neueste Generation laut Listenreihenfolge -> ' + best.m.id + hinweis,
  };
}

export interface StandardModellWahl {
  /** Synapse-ID; null = keins bestimmbar (grund). */
  modell: string | null;
  quelle: 'schalter_aus' | 'user_wahl' | 'profil' | 'kleinstes' | 'keins';
  grund: string | null;
  /** Gespeicherte User-Wahl dieser Runtime (auch wenn sie nicht mehr gelistet ist). */
  user_wahl: string | null;
}

/** User-Wahl je Runtime aus dem Startrezept der Main-Identitaet. */
export async function leseUserModellWahl(): Promise<Partial<Record<CliModellRuntime, string>>> {
  const r = await getPool().query<{ wahl: Record<string, unknown> | null }>(
    `SELECT startrezept->'modell_je_runtime' AS wahl FROM agent_identitaeten WHERE project = $1 AND agent_id = 'hauptagent'`, [HAUPTAGENT_PROJEKT]);
  const w = r.rows[0]?.wahl;
  const aus: Partial<Record<CliModellRuntime, string>> = {};
  if (w && typeof w === 'object') for (const rt of CLI_MODELL_RUNTIMES) if (typeof w[rt] === 'string' && (w[rt] as string).trim()) aus[rt] = (w[rt] as string).trim();
  return aus;
}

/** Profil-Modell (modell_bestaetigt, gespeichertes konfiguriertes Modell) der Main-Identitaet. */
async function leseProfilModell(): Promise<string | null> {
  const r = await getPool().query<{ m: string | null }>(
    `SELECT modell_bestaetigt AS m FROM agent_identitaeten WHERE project = $1 AND agent_id = 'hauptagent'`, [HAUPTAGENT_PROJEKT]);
  return r.rows[0]?.m?.trim() || null;
}

export const HINWEIS_LISTE_NICHT_LESBAR = 'Liste nicht lesbar, gespeichertes Modell verwendet';

/**
 * Standard ohne ausdrueckliches Modell (User-Entscheidung 20.10.: gespeicherte Wahl geht immer vor):
 *   1. User-Wahl je Runtime (startrezept.modell_je_runtime), 2. Profil-Modell (modell_bestaetigt), 3. kleinstes Modell.
 * Gegen die Liste geprueft wird nur, wenn sie lesbar ist; sonst wird ein gespeichertes Modell, das zur Runtime gehoert, mit
 * Hinweis HINWEIS_LISTE_NICHT_LESBAR genommen (kein Abbruch). Erst wenn nichts davon etwas liefert: modell null + grund.
 * Schalter AUS: altStandard.
 */
export async function standardModellFuerRuntime(runtime: CliModellRuntime, altStandard: () => Promise<string>): Promise<StandardModellWahl> {
  const ein = (await leseCliModelleSchalter()).aktiv;
  if (!ein) return { modell: await altStandard(), quelle: 'schalter_aus', grund: null, user_wahl: null };
  const wahl = (await leseUserModellWahl().catch(() => ({} as Partial<Record<CliModellRuntime, string>>)))[runtime] ?? null;
  const hinweise: string[] = [];
  const gespeichert: Array<{ modell: string | null; quelle: 'user_wahl' | 'profil' }> = [
    { modell: wahl, quelle: 'user_wahl' },
    { modell: await leseProfilModell().catch(() => null), quelle: 'profil' },
  ];
  for (const g of gespeichert) {
    if (!g.modell) continue;
    const p = await pruefeModellFuerRuntime(g.modell, runtime, { schalter: true });
    if (p.passt) {
      const grund = p.quelle === 'ohne_liste' ? HINWEIS_LISTE_NICHT_LESBAR + ' (' + (p.grund ?? 'leer') + ')' : p.grund;
      return { modell: p.modell, quelle: g.quelle, grund: [...hinweise, grund].filter(Boolean).join('; ') || null, user_wahl: wahl };
    }
    // Ein Modell der anderen Runtime ist kein Fehler der Wahl, nur nicht anwendbar; nicht mehr gelistet wird genannt.
    if (p.grund !== 'modell_gehoert_zu_codex' && p.grund !== 'modell_gehoert_zu_claude') {
      merkeHinweis(hinweise, g.quelle + '_ungueltig: ' + g.modell + ' (' + (p.grund ?? 'passt_nicht') + ')');
    }
  }
  const k = await leseCliKatalog(runtime);
  const klein = waehleKleinstesModell(runtime, k);
  if (klein.id) return { modell: synapseModellId(runtime, klein.id), quelle: 'kleinstes', grund: [...hinweise, klein.grund].filter(Boolean).join('; ') || null, user_wahl: wahl };
  return { modell: null, quelle: 'keins', grund: [...hinweise, klein.grund].filter(Boolean).join('; ') || 'standardmodell_unbestimmt', user_wahl: wahl };
}

function merkeHinweis(liste: string[], text: string): void { if (!liste.includes(text)) liste.push(text); }

// ---------------------------------------------------------------------------------------------
// P22-T65: Effort-Stufe je Modell (Schalter hauptagent_cli_modelle)
// ---------------------------------------------------------------------------------------------
/**
 * Claude-Kurzname (opus, sonnet[1m], haiku, fable) -> aktuelle Katalog-ID: config.provider_alias_targets des Katalogs, sonst die
 * neueste ID der Familie (erstes Modell der Familie in der Listenreihenfolge). Kein Kurzname / nichts gefunden -> null.
 */
export function loeseClaudeKurznamenAuf(modell: string, k: CliKatalog): string | null {
  const kurz = /^(opus|sonnet|haiku|fable)(\[1m\])?$/.exec(modell.trim());
  if (!kurz) return null;
  const ziel = k.alias_ziele?.[kurz[1]];
  if (ziel && k.modelle.some(m => m.id === ziel)) return ziel;
  return k.modelle.find(m => (m.familie ?? '').toLowerCase() === kurz[1])?.id ?? null;
}

/** Katalogeintrag eines Synapse-Modells (codex/<slug> -> slug; claude ohne [1m], Kurzname ueber loeseClaudeKurznamenAuf) oder null. */
async function katalogEintrag(runtime: CliModellRuntime, modell: string): Promise<{ eintrag: KatalogModell | null; liste_lesbar: boolean; grund: string | null }> {
  const k = await leseCliKatalog(runtime);
  if (!k.modelle.length) return { eintrag: null, liste_lesbar: false, grund: k.grund };
  const id = runtime === 'codex' ? (codexSlugAus(modell) ?? modell) : (loeseClaudeKurznamenAuf(modell, k) ?? modell.replace(/\[1m\]$/, ''));
  return { eintrag: k.modelle.find(m => m.id === id) ?? null, liste_lesbar: true, grund: null };
}

export interface EffortPruefung {
  ok: boolean;
  effort: string;
  /** Stufen laut Liste (leer = unbekannt). */
  stufen: string[];
  grund: string | null;
}

/**
 * Ist die Stufe fuer dieses Modell gueltig? Nur gegen die ausgelesene Liste; ist sie nicht lesbar oder das Modell nicht gelistet
 * (Registry-Alias), wird die Stufe mit Hinweis angenommen (die CLI meldet einen Fehler selbst). Unbekannte Stufe -> ok false.
 */
export async function pruefeEffortFuerModell(runtime: CliModellRuntime, modell: string, effortRoh: string): Promise<EffortPruefung> {
  const effort = effortRoh.trim().toLowerCase();
  if (!/^[a-z]{2,16}$/.test(effort)) return { ok: false, effort, stufen: [], grund: 'effort_ungueltig' };
  const k = await katalogEintrag(runtime, modell);
  if (!k.liste_lesbar) return { ok: true, effort, stufen: [], grund: HINWEIS_LISTE_NICHT_LESBAR + ' (' + (k.grund ?? 'leer') + ')' };
  const stufen = k.eintrag?.effort_stufen ?? [];
  if (!k.eintrag) return { ok: true, effort, stufen: [], grund: 'modell_ohne_katalogeintrag: Stufe ungeprueft' };
  if (!stufen.length) return { ok: false, effort, stufen, grund: 'modell_ohne_effort_stufen' };
  return stufen.includes(effort) ? { ok: true, effort, stufen, grund: null } : { ok: false, effort, stufen, grund: 'effort_nicht_fuer_modell' };
}

/** Effort-Wahl je Modell (Synapse-ID) aus dem Startrezept der Main-Identitaet. */
export async function leseEffortWahl(): Promise<Record<string, string>> {
  const r = await getPool().query<{ wahl: Record<string, unknown> | null }>(
    `SELECT startrezept->'effort_je_modell' AS wahl FROM agent_identitaeten WHERE project = $1 AND agent_id = 'hauptagent'`, [HAUPTAGENT_PROJEKT]);
  const w = r.rows[0]?.wahl;
  const aus: Record<string, string> = {};
  if (w && typeof w === 'object') for (const [k, v] of Object.entries(w)) if (typeof v === 'string' && v.trim()) aus[k] = v.trim();
  return aus;
}

export interface EffortWahl { effort: string | null; quelle: 'schalter_aus' | 'user_wahl' | 'standard_effort' | 'keins'; grund: string | null }

/**
 * Effort fuer den Start eines Modells (Schalter EIN): gespeicherte Wahl dieses Modells (gueltig) vor standard_effort des Katalogs.
 * Schalter AUS -> null (Altverhalten: kein Effort aus der Modellwahl).
 */
export async function effortFuerStart(runtime: CliModellRuntime, modell: string): Promise<EffortWahl> {
  if (!(await leseCliModelleSchalter()).aktiv) return { effort: null, quelle: 'schalter_aus', grund: null };
  const wahl = (await leseEffortWahl().catch(() => ({} as Record<string, string>)))[modell] ?? null;
  let hinweis: string | null = null;
  if (wahl) {
    const p = await pruefeEffortFuerModell(runtime, modell, wahl);
    if (p.ok) return { effort: p.effort, quelle: 'user_wahl', grund: p.grund };
    hinweis = 'effort_wahl_ungueltig: ' + wahl + ' (' + (p.grund ?? '') + ')';
  }
  const k = await katalogEintrag(runtime, modell);
  const std = k.eintrag?.standard_effort ?? null;
  if (std) return { effort: std, quelle: 'standard_effort', grund: hinweis };
  return { effort: null, quelle: 'keins', grund: hinweis ?? (k.liste_lesbar ? 'kein standard_effort im Katalog' : 'modellliste_fehlt') };
}

/**
 * Nach einem completed Wechsel durch User/Main: Wahl je Runtime im Startrezept festhalten (ueberlebt Neustart/Deploy).
 * Auftraege der Ueberwachung (Failover/Kontingent/Rueckkehr) schreiben nie (die Rueckkehr nutzt modell_ursprung).
 */
export function istUserWahlAuftrag(erstelltVon: string | null | undefined): boolean {
  return !!erstelltVon && erstelltVon !== 'runtime-ueberwachung';
}
