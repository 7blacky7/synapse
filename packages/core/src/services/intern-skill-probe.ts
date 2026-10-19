/**
 * MODUL: Intern skill_probe (P23-T6, User 20.10.2026, Regel neue-funktionen-mit-schalter-und-debug)
 * ZWECK: Debug-Weg fuer die Skill-Vorschlaege (P23-T1) und ihre Jev-Sinnpruefung (P23-T4). Zeigt fuer EINEN Text,
 *        was der Hook ablegen wuerde - OHNE zu schreiben (kein Vorrat, keine skill_hook_preparations/-deliveries).
 *        Eigene Datei, intern-tool.ts haengt sie nur ein (Muster intern-diagnose.ts).
 *
 * ABLAUF (derselbe Code wie im Betrieb):
 *   1) Suchtext wie im Hook (baueChannelSkillSuchtext), Empfaenger wie im Hook (skillHandle, loeseSkillEmpfaenger).
 *   2) ermittleSkillKandidaten (skill-hook.ts): Vektorsuche je Empfaenger, Namenstreffer (0,99), Schwellen,
 *      Auswahl. schwelle/abstand sind TESTWERTE nur fuer diese Probe (nichts wird gespeichert).
 *   3) baueSkillSinnAnfrage (skill-rerank.ts): der state, den die Sinnpruefung an Jev senden wuerde, mit
 *      Budgetkuerzung; gezeigt als Tokens + gekuerzter Auszug je Teil.
 *   4) mit_jev:true: ECHTER Jev-Aufruf als eigene Funktion skill_rerank_probe (jev-schalter.ts) - unabhaengig vom
 *      Schalter skill_rerank (laeuft auch bei AUS), Kosten in jev_aufrufe -> admin jev_kosten. Jev global/Projekt aus
 *      oder Budget-Pause gelten weiter. Ergebnis je Kandidat: Wert, Tor, durchgelassen/verworfen.
 * RECHTE: nur User (authentifizierter Eingang) oder Koordinator DIESES Projekts (pruefeProfilVerwalter; auch
 *   Legacy-Koordinator ohne Ausweis wie bei admin). Sonst recht_fehlt.
 * ANTWORT: { success, action, ... }; fuehreSkillProbeAus wirft nie.
 */

import { aktuellerAgentAufruf, aktuellerAgentPrincipal } from './agent-bezug.js';
import { rolleFuerAgent } from './agent-rollen.js';
import { ProfilVerwaltungFehler, aktuellerW1bAkteur, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';
import {
  SKILL_KANDIDATEN_GRENZEN, baueChannelSkillSuchtext, ermittleSkillKandidaten, istNamentlichGenannt, loeseSkillEmpfaenger, skillHandle,
} from './skill-hook.js';
import { searchSkillsForAgents, type SkillSearchHit } from './skills.js';
import { baueSkillSinnAnfrage, schaetzeTokens, werteSkillSinnAntwort } from './skill-rerank.js';
import { leseJevOptionen, SKILL_RERANK_BUDGET_GRENZE } from './jev-optionen.js';
import { rufeJev } from './jev-client.js';
import { jevWirksam } from './jev-schalter.js';
import { scoreSchwelleMitQuelle } from '../embeddings/modell-profil.js';

export const SKILL_PROBE_ACTIONS = ['skill_probe'] as const;

export function istSkillProbeAction(action: string): boolean {
  return (SKILL_PROBE_ACTIONS as readonly string[]).includes(action);
}

/** Satz fuer die Tool-Beschreibung (intern-tool.ts haengt ihn an). */
export const SKILL_PROBE_BESCHREIBUNG =
  'skill_probe (text, project, empfaenger, schwelle, abstand, mit_jev, limit; nur Koordinator/User, schreibt nichts): Diagnose der Skill-Vorschlaege fuer einen Text - ' +
  'semantische Kandidaten je Empfaenger mit Score und Ergebnis (namentlich | kandidat | unter_schwelle | mehrdeutig | nicht_bester | deckel), ' +
  'wirksame Schwellen channel_skill/channel_skill_abstand mit Quelle (schwelle/abstand = Testwerte nur fuer diese Probe), ' +
  'Jev-state der Sinnpruefung (Tokens + gekuerzter Auszug je Teil); mit_jev:true = ECHTER Jev-Aufruf als Funktion skill_rerank_probe ' +
  '(Kosten in jev_kosten) mit Wert, Tor und Ergebnis je Kandidat, auch wenn skill_rerank AUS ist. ';

/** Nur NEUE Parameter (project, agent_id, limit und schwelle gibt es schon). */
export const SKILL_PROBE_PARAMETER: Record<string, unknown> = {
  text: { type: 'string', description: 'skill_probe: Text, fuer den Skill-Vorschlaege ermittelt werden (wie ein Channel-/Memory-/Thought-/Task-Text)' },
  empfaenger: { type: ['string', 'array'], items: { type: 'string' }, description: 'skill_probe: Empfaenger (Agent-Name, identity:<id> oder legacy:<name>; Liste bis 10). Standard: der Aufrufer' },
  abstand: { type: 'number', description: 'skill_probe: Testwert channel_skill_abstand (0..1) nur fuer diese Probe; schwelle = Testwert channel_skill' },
  mit_jev: { type: 'boolean', description: 'skill_probe: echter Jev-Aufruf (Funktion skill_rerank_probe, kostet, steht in jev_kosten); Standard false' },
};

class SkillProbeFehler extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface SkillProbeDeps {
  /** Tests: Vektorsuche ersetzen (sonst searchSkillsForAgents) */
  searchBatch?: typeof searchSkillsForAgents;
  /** Tests: fetch fuer den Jev-Aufruf ersetzen */
  fetch?: typeof fetch;
}

const AUSZUG_ZEICHEN = 300;
const MAX_EMPFAENGER = 10;

function text(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function zahl(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new SkillProbeFehler('parameter_ungueltig', `${k}: Zahl erwartet.`);
  return n;
}

function textListe(a: Record<string, unknown>, k: string): string[] {
  const v = a[k];
  let roh: unknown[] = [];
  if (Array.isArray(v)) roh = v;
  else if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try { const p: unknown = JSON.parse(t); if (Array.isArray(p)) roh = p; } catch { /* Komma-Liste */ }
    }
    if (roh.length === 0) roh = t.split(',');
  }
  return [...new Set(roh.map((x) => String(x).trim()).filter(Boolean))];
}

function auszug(wert: unknown): string {
  const s = typeof wert === 'string' ? wert : JSON.stringify(wert ?? null);
  return s.length > AUSZUG_ZEICHEN ? `${s.slice(0, AUSZUG_ZEICHEN - 1)}…` : s;
}

const rund = (n: number) => Math.round(n * 10000) / 10000;

/** Legacy-Koordinator ohne Ausweis (Erkennung wie admin: Rolle/Namensmuster koordinator, nie im fremden Projekt). */
function legacyKoordinator(agent: string | undefined): AusweisAkteur | null {
  const fremd = aktuellerAgentAufruf()?.fremdprojekt;
  if (fremd && fremd.zugang !== 'frei') return null;
  return agent && rolleFuerAgent(agent).rolle === 'koordinator' ? { art: 'legacy_koordinator', agent_id: agent } : null;
}

/** Warum ein Treffer (nicht) Kandidat wurde - dieselben Regeln wie waehleChannelSkillTreffer + Deckel. */
function ergebnisFuer(
  hit: SkillSearchHit, query: string, minScore: number | null, abstand: number | null,
  auswahl: { namentlich: SkillSearchHit[]; semantisch: SkillSearchHit[] },
): string {
  if (istNamentlichGenannt(hit.skill_name, query)) return 'namentlich';
  if (auswahl.semantisch.some((h) => h.skill_name === hit.skill_name)) return 'kandidat';
  if (minScore === null) return 'schwelle_nicht_kalibriert';
  if (hit.score < minScore) return 'unter_schwelle';
  if (auswahl.namentlich.length > 0) return 'deckel';
  if (abstand === null) return 'abstand_nicht_kalibriert';
  return auswahl.semantisch.length === 0 ? 'mehrdeutig' : 'nicht_bester';
}

/** Die Probe selbst. Wirft SkillProbeFehler / ProfilVerwaltungFehler (der Dispatcher faengt). */
export async function skillProbe(
  a: Record<string, unknown>, agentId?: string, deps: SkillProbeDeps = {},
): Promise<Record<string, unknown>> {
  const eingabe = text(a, 'text');
  if (!eingabe) throw new SkillProbeFehler('parameter_fehlt', 'text fehlt (der Text, fuer den Skill-Vorschlaege ermittelt werden).');
  const principal = aktuellerAgentPrincipal();
  const project = text(a, 'project') ?? principal?.project;
  if (!project) throw new SkillProbeFehler('parameter_fehlt', 'project fehlt.');
  const aufrufer = text(a, 'agent_id') ?? agentId;

  // Rechte: User oder Koordinator dieses Projekts (Rolle in PG gegengeprueft), auch Legacy-Koordinator.
  const akteur = aktuellerW1bAkteur() ?? legacyKoordinator(aufrufer);
  if (!akteur) throw new ProfilVerwaltungFehler('recht_fehlt');
  await pruefeProfilVerwalter(akteur, project);

  const schwelle = zahl(a, 'schwelle');
  const abstand = zahl(a, 'abstand');
  for (const [k, v] of [['schwelle', schwelle], ['abstand', abstand]] as const) {
    if (v !== undefined && (v < 0 || v > 1)) throw new SkillProbeFehler('parameter_ungueltig', `${k}: Zahl 0..1.`);
  }
  const limit = Math.min(Math.max(Math.floor(zahl(a, 'limit') ?? 15), 1), SKILL_KANDIDATEN_GRENZEN.suchbreite);
  const mitJev = a.mit_jev === true || a.mit_jev === 'true';

  // Empfaenger wie im Hook: Handles (identity:/legacy:) und daraus Identitaet bzw. Legacy-Name.
  let roh = textListe(a, 'empfaenger');
  if (roh.length === 0) {
    roh = principal?.art === 'identity' ? ['identity:' + principal.identity_id] : [aufrufer ?? 'skill-probe'];
  }
  if (roh.length > MAX_EMPFAENGER) throw new SkillProbeFehler('parameter_ungueltig', `empfaenger: hoechstens ${MAX_EMPFAENGER}.`);
  const handles = [...new Set(roh.map((x) => skillHandle(project, x)))];
  const empfaenger = await loeseSkillEmpfaenger(project, handles);

  const query = baueChannelSkillSuchtext([{ content: eingabe }]);
  const [sq, aq] = await Promise.all([scoreSchwelleMitQuelle('channel_skill'), scoreSchwelleMitQuelle('channel_skill_abstand')]);
  const erm = await ermittleSkillKandidaten(project, query, handles, deps.searchBatch ?? searchSkillsForAgents, {
    ...(schwelle !== undefined ? { minScore: schwelle } : {}),
    ...(abstand !== undefined ? { abstand } : {}),
  });

  const jeEmpfaenger = erm.results.map(({ agent, hits }) => {
    const auswahl = erm.auswahl.find((x) => x.agent === agent) ?? { namentlich: [], semantisch: [] };
    const beste = new Map<string, SkillSearchHit>();
    for (const h of hits) {
      if (!h.skill_name) continue;
      const alt = beste.get(h.skill_name);
      if (!alt || h.score > alt.score) beste.set(h.skill_name, h);
    }
    const sortiert = [...beste.values()].sort((x, y) => y.score - x.score);
    const semantischUeber = sortiert.filter((h) => !istNamentlichGenannt(h.skill_name, query) && erm.minScore !== null && h.score >= erm.minScore);
    const [erster, zweiter] = semantischUeber;
    return {
      empfaenger: agent,
      treffer_gesamt: sortiert.length,
      namentlich: auswahl.namentlich.map((h) => h.skill_name),
      kandidaten_semantisch: auswahl.semantisch.map((h) => h.skill_name),
      ...(auswahl.namentlich.length === 0 && erster ? {
        mehrdeutigkeit: {
          erster: erster.skill_name, zweiter: zweiter?.skill_name ?? null,
          differenz: zweiter ? rund(erster.score - zweiter.score) : null, abstand: erm.abstand,
        },
      } : {}),
      treffer: sortiert.slice(0, limit).map((h) => ({
        skill_name: h.skill_name,
        score: rund(h.score),
        abschnitt: h.section || null,
        scope: h.scope ?? null,
        projekt: h.project ?? null,
        ueber_schwelle: erm.minScore !== null && h.score >= erm.minScore,
        ergebnis: ergebnisFuer(h, query, erm.minScore, erm.abstand, auswahl),
      })),
    };
  });

  // Jev-Teil: derselbe state wie im Betrieb (baueSkillSinnAnfrage); geht im Betrieb nur bei skill_rerank an Jev.
  const opt = await leseJevOptionen();
  const schalter = await jevWirksam(project, 'skill_rerank');
  const jev: Record<string, unknown> = {
    skill_rerank: { an: schalter.an, ebene: schalter.ebene ?? null, quelle: schalter.quelle ?? null, text: schalter.text ?? null },
    tor: opt.skill_rerank_tor,
    max_kandidaten: opt.skill_rerank_max,
    budget_tokens: opt.skill_rerank_budget_tokens,
    obergrenze_tokens: SKILL_RERANK_BUDGET_GRENZE,
    timeout_ms: opt.skill_rerank_timeout_ms,
  };
  const kandidaten = [...erm.besterJeSkill.values()].map((hit) => ({
    skill_name: hit.skill_name, inhalt: hit.content ?? '', abschnitt: hit.section ?? null, scope: hit.scope ?? null, projekt: hit.project ?? null,
  }));
  if (kandidaten.length === 0) {
    jev.state = null;
    jev.grund = 'keine_kandidaten';
    jev.hinweis = 'Keine semantischen Kandidaten - genannte Skills (Kette 0,99) laufen nie durch die Sinnpruefung.';
    if (mitJev) jev.ergebnis = { gelaufen: false, grund: 'keine_kandidaten' };
  } else {
    const { state, questions, bericht } = await baueSkillSinnAnfrage({
      project, text: query, kandidaten, empfaenger, agent_id: aufrufer ?? null,
      quelle: { art: 'probe', klartext: 'Diagnose intern skill_probe' },
    }, opt);
    const tokensState = schaetzeTokens(state);
    const tokensFragen = schaetzeTokens(questions);
    jev.tokens = { state: tokensState, questions: tokensFragen, gesamt: tokensState + tokensFragen };
    jev.budget = bericht;
    jev.teile = {
      quelle: { tokens: schaetzeTokens(state.quelle), auszug: auszug(state.quelle) },
      text: { tokens: schaetzeTokens(state.text), zeichen: state.text.length, auszug: auszug(state.text) },
      empfaenger: { tokens: schaetzeTokens(state.empfaenger), gruppen: state.empfaenger.length, auszug: auszug(state.empfaenger) },
      aufgaben: { tokens: schaetzeTokens(state.aufgaben), anzahl: state.aufgaben.length, auszug: auszug(state.aufgaben) },
      skills: state.skills.map((s) => ({
        i: s.i, name: s.name, tokens: schaetzeTokens(s),
        zweck: s.zweck === null ? null : auszug(s.zweck),
        abschnitt_titel: s.abschnitt_titel, abschnitt_zeichen: s.abschnitt.length, abschnitt: auszug(s.abschnitt),
        abschnitte: s.abschnitte,
      })),
    };
    if (mitJev) {
      const tor = opt.skill_rerank_tor;
      if (bericht.tokens_geschaetzt > SKILL_RERANK_BUDGET_GRENZE) {
        jev.ergebnis = { gelaufen: false, grund: 'budget_tokens' };
      } else {
        try {
          const r = await rufeJev({
            funktion: 'skill_rerank_probe', project, agent_id: aufrufer ?? null,
            identity_id: principal?.art === 'identity' ? principal.identity_id : null,
            state, questions, timeout_ms: opt.skill_rerank_timeout_ms,
          }, deps.fetch ? { fetch: deps.fetch } : {});
          if (!r.ok) {
            jev.ergebnis = { gelaufen: false, grund: r.grund, message: r.message };
          } else {
            const werte = werteSkillSinnAntwort(state, r.daten);
            jev.ergebnis = {
              gelaufen: true, funktion: 'skill_rerank_probe', tor, dauer_ms: r.dauer_ms, modell: r.modell,
              usd: r.kosten.usd, usd_quelle: r.kosten.quelle, input_tokens: r.kosten.input_tokens, output_tokens: r.kosten.output_tokens,
              je_kandidat: [
                ...state.skills.map((s) => {
                  const w = werte.get(s.name);
                  return {
                    skill_name: s.name, wert: w ?? null,
                    ergebnis: w === undefined ? 'verworfen (ohne Wert)' : w >= tor ? 'durchgelassen' : 'verworfen',
                  };
                }),
                ...(bericht.kandidaten_entfallen ?? []).map((name) => ({ skill_name: name, wert: null, ergebnis: 'verworfen (Budget, nicht gefragt)' })),
              ],
            };
          }
        } catch (err) {
          jev.ergebnis = { gelaufen: false, grund: 'antwort_unlesbar', message: err instanceof Error ? err.message : String(err) };
        }
      }
    }
  }

  return {
    project,
    geschrieben: false,
    text_zeichen: eingabe.length,
    suchtext_zeichen: query.length,
    empfaenger: handles.map((h, i) => ({ handle: h, ...empfaenger[i] })),
    schwellen: {
      channel_skill: { ...sq, test: schwelle ?? null },
      channel_skill_abstand: { ...aq, test: abstand ?? null },
      wirksam: { schwelle: erm.minScore, abstand: erm.abstand, test: schwelle !== undefined || abstand !== undefined },
    },
    grenzen: SKILL_KANDIDATEN_GRENZEN,
    namentlich_genannt: erm.namensTreffer,
    je_empfaenger: jeEmpfaenger,
    sinnpruefung_kandidaten: kandidaten.map((k) => k.skill_name),
    jev,
    hinweis: 'Nur Diagnose: nichts in den Vorrat geschrieben. Testwerte schwelle/abstand gelten nur fuer diese Probe.',
  };
}

/** Dispatcher fuer intern-tool.ts. Wirft nie. */
export async function fuehreSkillProbeAus(
  action: string, a: Record<string, unknown>, agentId?: string, deps: SkillProbeDeps = {},
): Promise<Record<string, unknown>> {
  try {
    return { success: true, action, ...(await skillProbe(a, agentId, deps)) };
  } catch (err) {
    if (err instanceof SkillProbeFehler) return { success: false, action, error: err.code, message: err.message };
    if (err instanceof ProfilVerwaltungFehler) {
      return { success: false, action, error: err.code, message: 'skill_probe nur fuer den User oder einen Koordinator dieses Projekts.' };
    }
    return { success: false, action, error: 'interner_fehler', message: err instanceof Error ? err.message : String(err) };
  }
}
