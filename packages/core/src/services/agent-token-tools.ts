/**
 * P22-T11: Gemeinsame Token-Grenze fuer REST und stdio.
 * Geteilte MCP-Verbindungen erhalten KEINE globale "zuletzt angemeldete" Identitaet.
 * Jeder Aufruf bezeugt sich per token oder dediziertem Starttransport (Env/Header).
 *
 * P22-T13 Phase V (K16.1/K16.2/K16.5), nur bei W1b-Durchsetzung (leseW1bSchalter('durchsetzung'),
 * Standard AUS = exakt t109):
 *  - Selbstidentitaetsfelder laut agent-selbstfelder.ts werden mit dem Token verglichen; echter
 *    Widerspruch -> identitaet_konflikt VOR Fachaktion, Epoch-/Laufaenderung und Claims
 *    (Pruefung in derselben Transaktion vor jedem UPDATE). Passende Angaben werden still ignoriert.
 *  - Vom Transport vorbelegte Felder (REST access.agentId/derivedAgentId) zaehlen nie als Angabe.
 *  - Fachfilter (chat.get.agent_id, files.history.agent_id, specialist.spawn.model ...) bleiben.
 *  - Profil-Gate (tool-gate.ts) nach Identifikation und vor dem Handler.
 * Der bestaetigte Kontext wird ausdruecklich als kontext.bestaetigt bzw. bestaetigterAufrufKontext()
 * weitergegeben, statt sich auf nichtenumerierbare Felder in args zu verlassen.
 */
import {
  leseTokenIdentitaetSchalter, stelleAgentTokenAus, meldeAgentMitTokenAn,
  pruefeAgentToken, AgentIdentitaetFehler, type AgentTokenAnmeldung,
} from './agent-identitaet.js';
import { registerAgent } from './chat.js';
import { getPool } from '../db/client.js';
import { holeAgentOnboarding } from './agent-onboarding.js';
import { pruefeUnbekannteParameter } from './unbekannte-parameter.js';
import { logToolCall } from './tool-call-log.js';
import {
  leseW1bSchalter, leseAusweisKern, ausweisTokenAktiv, ausweisAnmeldungAktiv, leseAusweisKernFuerToken, ausweisProjekt, ausweisIrgendwoAktiv,
  type AusweisKernStand,
} from './agent-profil-schalter.js';
import { feldBedeutung, sammleSelbstangaben, actorAliasFelder, bindeVerschachtelteActorFelder, selbstKonflikte, SELBSTFELD_REGELN, type Selbstangaben } from './agent-selbstfelder.js';
// P22-T56: tools/list je Verbindung (Variante aus entscheideToolListeVerbindung).
import type { ToolListeEntscheidung } from './tool-liste-verbindung.js';
import { entscheideToolAufruf, entscheideToolListe, istNichtSperrbareAktion, type TransportZugang } from './tool-gate.js';
import { loeseToolZuschnitt, TEXT_AGENT_TOKEN_FEHLT } from './agent-profil-vertrag.js';
import { bereiteZuschnittSnapshotVor, wendeProfilLimitsAn } from './agent-zuschnitt.js';
import { zaehle as zaehleZuschnitt } from './agent-zuschnitt-kontext.js';
import {
  waehleRegisterWeg, legeErstenKoordinatorAusgabe, AnmeldungsFehler,
  koordinatorListeAntwort, merkeHerkunftsort,
} from './agent-anmeldung.js';
// W12-B (P22-T25, V5/V6): Lauf-Zustellbuchhaltung + Uebernahme-Bruecke; Hinweis-Registry an den wirksamen Schalter.
import { sichereLaufFuerAufruf } from './agent-lauf.js';
import { sichereW1bAnmeldungHinweise } from './agent-anmeldung.js';

import { mitAgentAufrufKontext, leseAgentBezugModus, aktuellerAgentAufruf, agentPrincipalAusAnmeldung, type AgentAufrufKontext } from './agent-bezug.js';
// P22-T44: Ausweis fuer mehrere Projekte (Heimat, Visum, Arbeitsfreigabe).
import { vergissOnboarding } from './project-status.js';
// P23-T5: kurze Tool-Beschreibungen (Produkt-Schalter tool_beschreibungen_kurz, Standard AUS).
import { wendeKurzeBeschreibungenAn } from './fall-skills.js';
import {
  leseMehrprojektSchalter, sichereFremdprojektZugang, visumErlaubt, visumAblehnung, ausweisProjekteHinweis, ausweisProjekteStatus,
  haengeAusweisHinweiseAn, type FremdprojektStand,
} from './agent-ausweis-projekte.js';
export const AGENT_TOKEN_PARAMETER = {
  token: { type: 'string', description: 'Agenten-Ausweis (sai_...): bei JEDEM Aufruf mitgeben. Er allein bestimmt Identitaet, Projekt und Rolle (agent_id/role weglassen). Start/Kontextverlust: chat(action:"anmelden", token).' },
};
/** P22-T55: Beschreibung von agent_id, sobald der Ausweis beworben wird (getrennte Texte je Weg: Ausweis vs. Legacy). */
export const TEXT_AGENT_ID_MIT_AUSWEIS = 'Nur OHNE Ausweis (Legacy): eigene Agent-ID. Mit Ausweis weglassen, die Identitaet kommt aus token.';
/** P22-T55: Hinweis an einen Ausweis-Agenten, der agent_id/role (oder einen Absender-Alias) mitgibt; je Lauf einmal. */
export const TEXT_AUSWEIS_NUR_TOKEN = 'Mit Ausweis nur token mitgeben, agent_id/role weglassen: Identitaet, Projekt und Rolle kommen allein aus dem Ausweis.';
/** Nur Schemas erweitern; die ausgeschaltete Fachlogik bleibt unveraendert. */
export function ergaenzeAgentTokenParameter(defs: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>): void {
  for (const d of defs) {
    if (d.inputSchema?.properties) Object.assign(d.inputSchema.properties, AGENT_TOKEN_PARAMETER);
    // P22-T13 Paket B: tokenfreie Koordinatorliste; beworbeneAgentTools blendet sie ohne W1b-Anmeldung aus.
    const action = d.name === 'chat' ? d.inputSchema?.properties?.action as { enum?: unknown[] } | undefined : undefined;
    // P22-T55: anmelden/identitaet stehen in BEIDEN Transporten im chat-Enum (Werbung filtert sie ohne wirksamen Ausweis wieder aus).
    for (const a of ['anmelden', 'identitaet', 'koordinator_liste']) if (action?.enum && !action.enum.includes(a)) action.enum.push(a);
  }
}
/** P22-T27/T28 (S2): NUR in einer tools/list-Antwort auf eine Anfrage MIT Ausweis und bei wirksamem Ausweis-Kern ist project nicht Pflicht
 * (Serverseitig wird ein Aufruf mit token ohne project immer angenommen, das Projekt kommt aus dem Ausweis). Ohne Ausweis bleibt das Schema wie t110.
 * Fachparameter bleiben unveraendert, nur die Pflichtangabe und die Parameterbeschreibung aendern sich. */
function ausweisProjektOptional(def: { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }, mehrprojekt = false): void {
  const s = def.inputSchema;
  if (!s?.required?.includes('project')) return;
  s.required = s.required.filter(f => f !== 'project');
  const p = s.properties?.project as { description?: string } | undefined;
  // P22-T44 (Konzept Punkt 6): bei Schalter mehrprojekt nennt die Beschreibung Heimat und Visa/Einwanderungen.
  if (p) p.description = `${p.description ?? 'Projekt-Name'} (mit token/Ausweis optional`
    + `${mehrprojekt ? '; ohne project gilt dein Heimatprojekt, fuer Visa/Einwanderungen in anderen Projekten project angeben' : ''})`;
}
/** P22-T56: Text fuer agent_id in einer Ausweis-Verbindung, wo das Tool agent_id nur als Fachfilter kennt. */
export const TEXT_AGENT_ID_FACHFILTER = (tool: string, aktionen: string[]) =>
  `Nur ${tool} ${aktionen.join('/')}: Filter auf einen anderen Agenten. Die eigene Identitaet kommt aus token.`;
/**
 * P22-T56: Ausweis-Verbindung - agent_id/role/project-Selbstangaben ausblenden (auch aus required). agent_id bleibt, wo
 * das Tool es laut agent-selbstfelder.ts als Fachfilter kennt (chat get, files history); project bleibt bei mehrprojekt.
 */
function blendeSelbstangabenAus(def: { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }, mehrprojekt: boolean): void {
  const props = def.inputSchema?.properties;
  if (!props) return;
  const weg: string[] = [];
  for (const feld of ['agent_id', 'role', 'project']) {
    if (!(feld in props) || (feld === 'project' && mehrprojekt)) continue;
    const fach = SELBSTFELD_REGELN.filter(r => r.tool === def.name && r.feld === feld && r.bedeutung === 'fach');
    if (fach.length) {
      props[feld] = { ...(props[feld] as Record<string, unknown>), description: TEXT_AGENT_ID_FACHFILTER(def.name, fach.flatMap(r => [...(r.actions ?? [])])) };
      continue;
    }
    delete props[feld];
    weg.push(feld);
  }
  if (def.inputSchema?.required) def.inputSchema.required = def.inputSchema.required.filter(f => !weg.includes(f));
}
/** Nur die Werbung ist schalterabhaengig; der interne Annahmevertrag bleibt stabil.
 * Kopien verhindern, dass ein paralleler tools/list-Aufruf andere Verbindungen veraendert.
 * P22-T56: opt.verbindung (entscheideToolListeVerbindung) waehlt die Liste je Verbindung; ohne bzw. 'bestand'/'gemeinsam'
 * bleibt alles wie nach P22-T55/P23-T5.
 */
export async function beworbeneAgentTools<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  defs: T[], opt?: { mitAusweis?: boolean; project?: string | null; verbindung?: ToolListeEntscheidung | null },
): Promise<T[]> {
  const variante = opt?.verbindung?.variante ?? 'bestand';
  if (variante === 'ausweis') return ausweisVerbindungTools(defs, opt?.verbindung?.ausweis_project ?? opt?.project ?? null);
  // P22-T55: ohne Projekt (tools/list) wird der Ausweis beworben, sobald der Ausweis-Kern IRGENDWO wirksam ist (global oder in
  // einem Projekt). Vorher nur global -> bei projektweisem Kern fehlte token in allen Schemas, Clients verwarfen ihn.
  // P22-T56: Legacy-Verbindung (Web-Connector ohne Ausweis) -> keine token-Werbung.
  const legacy = variante === 'legacy';
  const irgendwo = !legacy && !opt?.project ? await ausweisIrgendwoAktiv() : false;
  const tokenAn = !legacy && (irgendwo || await ausweisTokenAktiv(opt?.project ?? null));
  const anmeldungAn = irgendwo || await ausweisAnmeldungAktiv(opt?.project ?? null);
  // S2: project nur optional, wenn die Liste MIT Ausweis abgefragt wird UND der Ausweis-Kern wirksam ist.
  const projektOptional = opt?.mitAusweis === true && (await leseAusweisKern(opt?.project ?? null)).aktiv;
  const mehrprojekt = projektOptional && (await leseMehrprojektSchalter(opt?.project ?? null)).aktiv;
  // P23-T5: Beschreibungstexte zuerst kuerzen (Kopien, Struktur gleich); token/agent_id und die Ausweis-Anpassung danach bleiben unberuehrt.
  const basis = await wendeKurzeBeschreibungenAn(defs, opt?.project ?? null);
  return basis.map(def => {
    const kopie = structuredClone(def);
    if (kopie.inputSchema?.properties) {
      if (!tokenAn) delete kopie.inputSchema.properties.token;
      else {
        const aid = kopie.inputSchema.properties.agent_id as { description?: string } | undefined;
        if (aid) kopie.inputSchema.properties.agent_id = { ...aid, description: TEXT_AGENT_ID_MIT_AUSWEIS + (aid.description ? ' ' + aid.description : '') };
      }
      if (projektOptional) ausweisProjektOptional(kopie, mehrprojekt);
      if (kopie.name === 'chat') {
        const action = kopie.inputSchema.properties.action as { enum?: unknown[] } | undefined;
        if (action?.enum) {
          action.enum = action.enum.filter(a => (tokenAn || (a !== 'anmelden' && a !== 'identitaet')) && (anmeldungAn || a !== 'koordinator_liste'));
        }
      }
    }
    return kopie;
  });
}
/**
 * P22-T56: Liste einer Verbindung, die den Ausweis selbst traegt (entscheideToolListeVerbindung hat den Kern fuer diesen
 * Ausweis bereits geprueft): nur der Ausweis-Weg. token kurz, project optional (bzw. ausgeblendet), agent_id/role weg,
 * chat mit anmelden/identitaet. Massgeblich ist das Projekt des Ausweises.
 */
async function ausweisVerbindungTools<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  defs: T[], heimat: string | null,
): Promise<T[]> {
  const anmeldungAn = await ausweisAnmeldungAktiv(heimat);
  const mehrprojekt = (await leseMehrprojektSchalter(heimat)).aktiv;
  const basis = await wendeKurzeBeschreibungenAn(defs, heimat);
  return basis.map(def => {
    const kopie = structuredClone(def);
    if (kopie.inputSchema?.properties) {
      kopie.inputSchema.properties.token = { ...AGENT_TOKEN_PARAMETER.token };
      ausweisProjektOptional(kopie, mehrprojekt);
      blendeSelbstangabenAus(kopie, mehrprojekt);
      if (kopie.name === 'chat') {
        const action = kopie.inputSchema.properties.action as { enum?: unknown[] } | undefined;
        if (action?.enum) action.enum = action.enum.filter(a => anmeldungAn || a !== 'koordinator_liste');
      }
    }
    return kopie;
  });
}

/**
 * P22-T13 K16.2: tools/list ueber das EINE Gate. Transportteil (Hauptagent) immer wie bisher;
 * Profilteil nur bei W1b-Durchsetzung UND gueltigem identitaetsgebundenem Transporttoken.
 * Ohne Nachweis neutrale Liste (gewaehrt keine Ausfuehrungsrechte; jeder call prueft frisch).
 */
export async function gateToolListe<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  tools: T[], e: { transport?: TransportZugang | null; transportToken?: string },
): Promise<T[]> {
  const basis = entscheideToolListe(tools, { transport: e.transport });
  if (!e.transportToken || e.transport?.error) return basis;
  if (!(await leseW1bSchalter('durchsetzung')).freigegeben) return basis;
  if (!(await ausweisTokenAktiv(null, e.transportToken))) return basis;
  try {
    const p = await pruefeAgentToken(e.transportToken);
    const z = await loeseToolZuschnitt(agentPrincipalAusAnmeldung(p));
    return z ? entscheideToolListe(basis, { zuschnitt: z }) : basis;
  } catch {
    // Auflage C2 (P22-T13 Paket C): Token-/Resolverfehler bei tools/list -> NEUTRALE Liste (Transportteil wie
    // bisher, ohne Profilzuschnitt). Bewusst: eine Liste gewaehrt keine Rechte; jeder tools/call prueft frisch
    // und lehnt bei Resolverfehler fail-closed mit profil_nicht_pruefbar ab. Diagnose: Zaehler liste_fallback.
    zaehleZuschnitt('liste_fallback');
    return basis;
  }
}

/** P22-T13 K16.1: Herkunft der Argumente; REST sichert Originale VOR jeder Vorbelegung. */
export interface AgentToolAufrufOptionen {
  /** vom Aufrufer tatsaechlich gesendete Argumente */
  originalArgs?: Record<string, unknown>;
  /** vom Transport serverseitig vorbelegte Felder (z. B. agent_id aus access.agentId/derivedAgentId) */
  vorbelegt?: readonly string[];
  /** Anzeige: Herkunftsort des Clients (nur W1b-Anmeldung); nie Berechtigung. */
  herkunft?: string;
}
/** Ohne Optionen (stdio) ist die Herkunft die lokale CLI-Anbindung. */
const herkunftVon = (o?: AgentToolAufrufOptionen): string | undefined => (o ? o.herkunft : 'CLI/stdio');

/** P22-T13 K16.5: ausdruecklich weitergegebener, aus dem Token bestaetigter Aufrufkontext. */
export interface BestaetigterAufrufKontext {
  identity_id: string;
  agent_id: string;
  project: string;
  rolle: string;
  modell: string | null;
  context_epoch: number;
  lauf_id: string | null;
  token_herkunft: 'argument' | 'transport';
  /** W1b-Durchsetzung fuer diesen Aufruf (Snapshot) */
  strikt: boolean;
  /** vorbelegte Selbstfelder, die NICHT als Agentenangabe gewertet wurden */
  vorbelegung_ignoriert: string[];
  /** P22-T44: Aufruf in einem anderen Projekt als der Heimat (project bleibt die Heimat der Identitaet). */
  ziel_project?: string;
  zugang?: 'frei' | 'visum' | 'arbeitsfreigabe';
}
const bestaetigteKontexte = new WeakMap<AgentAufrufKontext, BestaetigterAufrufKontext>();
/** Fuer Handler/Hooks, die keinen kontext-Parameter erhalten (ueberlebt jeden args-Spread). */
export function bestaetigterAufrufKontext(): BestaetigterAufrufKontext | null {
  const k = aktuellerAgentAufruf();
  return k ? bestaetigteKontexte.get(k) ?? null : null;
}

/** Umfasst Authentifizierung, Fachaktion, Antwort-Hooks und Audit in EINEM Modus-Snapshot. */
export async function mitAgentToolAufruf<T>(
  tool: string, eingabe: Record<string, unknown>, serverInstanceId: string,
  arbeit: (kontext: AgentToolKontext) => Promise<T>,
  transportToken?: string, erlaubteParameter?: Set<string>, optionen?: AgentToolAufrufOptionen,
): Promise<T> {
  return mitAgentAufrufKontext({ principal: null, bezug: await leseAgentBezugModus() }, async () => {
    const kontext = await bereiteAgentToolAufrufVor(tool, eingabe, serverInstanceId, transportToken, erlaubteParameter, optionen);
    let ergebnis = await arbeit(kontext);
    // P22-T50: index_stats(sitzung:'fortsetzung') mit Ausweis -> Verweis auf chat(anmelden).
    if (kontext.sitzung_hinweis) ergebnis = haengeAusweisHinweiseAn(ergebnis, kontext.sitzung_hinweis, 'ausweis_sitzung_hinweis');
    // P22-T55: agent_id/role mit Ausweis mitgegeben -> kurzer Hinweis (je Lauf einmal, abweichende Werte ignoriert).
    if (kontext.angabe_hinweis) ergebnis = haengeAusweisHinweiseAn(ergebnis, kontext.angabe_hinweis, 'ausweis_hinweis');
    // P22-T44: Visum-/Einwanderungsanzeige (einmal je Lauf und bei Aenderung) an die fertige Antwort beider Transporte.
    return kontext.ausweis_hinweise?.length ? haengeAusweisHinweiseAn(ergebnis, kontext.ausweis_hinweise) : ergebnis;
  });
}
function setzeAufrufPrincipal(p: AgentTokenAnmeldung): void {
  const k = aktuellerAgentAufruf();
  if (k) k.principal = agentPrincipalAusAnmeldung(p);
}

export interface AgentToolKontext {
  aktiv: boolean;
  args: Record<string, unknown>;
  principal?: AgentTokenAnmeldung;
  antwort?: Record<string, unknown>;
  /** P22-T13: nur bei Tokenaufrufen gesetzt */
  bestaetigt?: BestaetigterAufrufKontext;
  /** P22-T44: Anzeige Visa/Einwanderungen (Feld ausweis_projekte_hinweis, mitAgentToolAufruf haengt es an). */
  ausweis_hinweise?: string[];
  /** P22-T50: Verweis auf chat(anmelden) bei index_stats(sitzung:'fortsetzung') mit Ausweis (Feld ausweis_sitzung_hinweis). */
  sitzung_hinweis?: string;
  /** P22-T55: Hinweis 'nur token mitgeben' (Feld ausweis_hinweis), je Lauf einmal. */
  angabe_hinweis?: string;
}
/** P22-T55: je Lauf (und je Satz abweichender Felder) einmal gezeigt; Prozessspeicher, begrenzt. */
const ANGABE_HINWEIS_GEZEIGT = new Set<string>();
function ausweisAngabeHinweis(p: AgentTokenAnmeldung, s: Selbstangaben): string | null {
  const felder = [...s.ids.map(x => x.feld), ...(s.rolle ? [s.rolle.feld] : [])];
  if (!felder.length) return null;
  const abweichend = selbstKonflikte({ agent_id: p.agent_id, rolle: p.rolle }, s).sort();
  const schluessel = `${p.lauf_id ?? p.identitaet.id + ':' + p.context_epoch}|${abweichend.join(',')}`;
  if (ANGABE_HINWEIS_GEZEIGT.has(schluessel)) return null;
  if (ANGABE_HINWEIS_GEZEIGT.size > 5000) ANGABE_HINWEIS_GEZEIGT.clear();
  ANGABE_HINWEIS_GEZEIGT.add(schluessel);
  return `${TEXT_AUSWEIS_NUR_TOKEN} Du bist ${p.agent_id}.`
    + (abweichend.length ? ` Abweichende Angabe ignoriert (${abweichend.join(', ')}), kein Fehler.` : '');
}
/** P22-T50 (User 19.10.): mit Ausweis gibt es keine Fortsetzung - jede Anmeldung ist eine Neuanmeldung. */
const TEXT_AUSWEIS_KEINE_FORTSETZUNG = 'Mit Ausweis gibt es keine Fortsetzung: Start, Neustart, Compaction und Kontextverlust = '
  + 'chat(action:"anmelden", token) (jede Anmeldung ist eine Neuanmeldung). index_stats hat keinen neuen Lauf begonnen.';
/**
 * P22-T50 Nachtrag (User): EIGENE offene files-Plaene der Identitaet (status open = weder committed noch cancelled/abgelaufen)
 * aus dem Zeitfenster anmeldung_plaene_minuten (Ausweis-Frist, projekt > global > Standard 30) als EINE Zeile. Fremde und
 * aeltere Plaene nicht; keiner offen -> null (Zeile entfaellt). Lesefehler -> null.
 */
async function eigenePlaeneZeile(p: AgentTokenAnmeldung): Promise<string | null> {
  try {
    const { leseAusweisFristen } = await import('./agent-ausweis-fristen.js');
    const fenster = (await leseAusweisFristen(p.project)).fristen.anmeldung_plaene_minuten;
    const r = await getPool().query<{ id: string; min: number }>(
      `SELECT id::text AS id, FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::int AS min FROM file_batch_plans
        WHERE project=$1 AND status='open' AND created_at > NOW() - ($4::int * INTERVAL '1 minute')
          AND (owner_identity_id=$2 OR (owner_identity_id IS NULL AND owner_agent_id=$3))
        ORDER BY created_at DESC LIMIT 10`, [p.project, p.identitaet.id, p.agent_id, fenster.wert]);
    if (!r.rows.length) return null;
    return `Eigene offene files-Plaene (letzte ${fenster.wert} Min): ${r.rows.map((z) => `${z.id} (${z.min} Min)`).join(', ')}`
      + ' - pruefen: files(action:"plan_status", plan_id); dann commit/cancel/plan_update.';
  } catch { return null; }
}
/** P22-T50: Abloesung des vorigen Laufs als hoechstens eine Zeile (statt fortsetzung.letzter_lauf). Lesefehler -> keine Zeile. */
async function abloesungsZeile(p: AgentTokenAnmeldung): Promise<string | null> {
  if (!p.lauf_id) return null;
  try {
    const r = await getPool().query<{ id: string }>(
      'SELECT id FROM agent_identitaet_laeufe WHERE identity_id=$1 AND abgeloest_durch=$2 ORDER BY context_epoch DESC LIMIT 1',
      [p.identitaet.id, p.lauf_id]);
    return r.rows[0] ? `Vorheriger Lauf ${r.rows[0].id.slice(0, 8)} abgeloest.` : null;
  } catch { return null; }
}
function feld(a: Record<string, unknown>, k: string): string | undefined {
  return typeof a[k] === 'string' && a[k] !== '' ? a[k] as string : undefined;
}
function bezeuge(a: Record<string, unknown>, k: string, v: unknown, erlaubt?: Set<string>): void {
  // Deklarierte Felder ueberleben Fachadapter-Spreads; interne Rollen bleiben nur fuer Hooks sichtbar.
  Object.defineProperty(a, k, { value: v, enumerable: Object.hasOwn(a, k) || (k !== 'role' && erlaubt?.has(k) === true), writable: true, configurable: true });
}
/** P22-T55 (User 19.10.): der Ausweis wird NICHT mehr maskiert - principal.ausweis ist der Klartext-Wert (derselbe wie token). */
function zeigePrincipal(p: AgentTokenAnmeldung, ausweis?: string): Record<string, unknown> {
  return { identity_id: p.identitaet.id, agent_id: p.agent_id, project: p.project,
    rolle: p.rolle, modell: p.modell, context_epoch: p.context_epoch,
    ...('lauf_id' in p ? { lauf_id: p.lauf_id } : {}), ...(ausweis ? { ausweis } : {}) };
}
/**
 * P22-T43 (B2): wirksamer Ausweis-Schalter fuer Antworten (token_identitaet_aus, chat(identitaet)). freigegeben ist exakt
 * ausweisTokenAktiv (Ausweis-Kern ODER alter Einzelschalter). quelle/bis kommen aus der WIRKSAMEN Quelle: Kern (standard |
 * intern | produkt-schalter | altschalter) bzw. bei Freigabe nur durch den alten Einzelschalter 'altschalter'/'altschalter-intern'
 * mit dessen bis. Der alte Einzelschalter token_identitaet steht nur noch als Detail unter alt_schalter. Aendert keinen Schalter.
 */
export interface WirksamerAusweisSchalter {
  freigegeben: boolean;
  quelle: AusweisKernStand['quelle'] | 'altschalter-intern';
  bis: string | null;
  letzter_fehler: string | null;
  project: string | null;
  ausweis_kern: { aktiv: boolean; quelle: AusweisKernStand['quelle']; agent_bezug_modus: AusweisKernStand['agent_bezug_modus'] };
  alt_schalter: { freigegeben: boolean; quelle: 'standard' | 'intern'; bis: string | null };
}
async function wirksamerAusweisSchalter(project: string | null, token?: string): Promise<WirksamerAusweisSchalter> {
  const kern = await leseAusweisKernFuerToken(token, project);
  const alt = await leseTokenIdentitaetSchalter();
  const nurAlt = !kern.aktiv && alt.freigegeben;
  return {
    freigegeben: kern.aktiv || alt.freigegeben,
    quelle: nurAlt ? (alt.quelle === 'intern' ? 'altschalter-intern' : 'altschalter') : kern.quelle,
    bis: nurAlt ? alt.bis : null,
    letzter_fehler: kern.letzter_fehler ?? (nurAlt ? alt.letzter_fehler : null),
    project: kern.project,
    ausweis_kern: { aktiv: kern.aktiv, quelle: kern.quelle, agent_bezug_modus: kern.agent_bezug_modus },
    alt_schalter: { freigegeben: alt.freigegeben, quelle: alt.quelle, bis: alt.bis },
  };
}

/** Fehlermeldungen enthalten ausschliesslich feste Codes, niemals Zugangswerte/DB-Fehler. */
export async function bereiteAgentToolAufrufVor(
  tool: string, eingabe: Record<string, unknown>, serverInstanceId: string, transportToken?: string, erlaubteParameter?: Set<string>,
  optionen?: AgentToolAufrufOptionen,
): Promise<AgentToolKontext> {
  const bezug = aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  const args = { ...eingabe };
  const token = Object.hasOwn(eingabe, 'token') ? feld(eingabe, 'token') : transportToken;
  // W12 V7: Lesepunkt = Ausweis-Kern ODER alter Einzelschalter (siehe ausweisTokenAktiv); Antwortform wie bisher.
  // P22-T50: project '*' (jev abwesend: alle Projekte) ist nie ein Projekt - kein Fremdprojekt, kein Visum, kein Onboarding.
  const alleProjekte = feld(eingabe, 'project') === '*';
  const projektHinweis = alleProjekte ? null : feld(eingabe, 'project') ?? null;
  // P22-T44: Ausweis + project eines ANDEREN Projekts als der Heimat -> bei Produkt-Schalter 'mehrprojekt' (Stand der Heimat)
  // Visum/Arbeitsfreigabe statt Abweisung. Anmelde-/Identitaetsaktionen bleiben Heimataktionen. Schalter AUS = Bestand.
  const aktionRoh = feld(eingabe, 'action');
  // User-Entscheidung 44dc299e: das reverse-Tool (globale Reverse-Bibliothek, eigenes Zugriffsmodell ueber Bindungen; project = Projekt
  // der Bindung) ist von Visum/Arbeitsfreigabe ausgenommen und verhaelt sich mit Ausweis wie bisher.
  const fremdKandidat = !!token && !!projektHinweis && tool !== 'reverse'
    && !(tool === 'chat' && ['anmelden', 'register', 'identitaet', 'koordinator_liste'].includes(aktionRoh ?? ''));
  const heimatDesAusweises = fremdKandidat ? await ausweisProjekt(token) : null;
  const fremdProjekt = heimatDesAusweises && heimatDesAusweises !== projektHinweis
    && (await leseMehrprojektSchalter(heimatDesAusweises)).aktiv ? projektHinweis : null;
  // P22-T43 (B2): Anzeige aus der WIRKSAMEN Quelle; freigegeben unveraendert = ausweisTokenAktiv (Kern ODER Altschalter).
  // P22-T44: im fremden Projekt gilt der Stand der Heimat.
  const schalter = await wirksamerAusweisSchalter(fremdProjekt ? heimatDesAusweises : projektHinweis, token);
  const anmeldungAn = (): Promise<boolean> => ausweisAnmeldungAktiv(projektHinweis);

  delete args.token;
  const basis: AgentToolKontext = { aktiv: schalter.freigegeben, args };
  const action = feld(args, 'action');
  if (!schalter.freigegeben) {
    if (Object.hasOwn(eingabe, 'token') || !!transportToken || (tool === 'chat' && ['anmelden', 'identitaet'].includes(action ?? ''))) {
      // P22-T43 (D9): gehoert der Ausweis zu einem ANDEREN Projekt als dem angefragten, kommt unabhaengig vom Schalter
      // agent_token_fremdes_projekt (wie bei EIN aus pruefeAgentToken). Nur die Meldung; abgelehnt wird wie bisher.
      const eigenesProjekt = token ? await ausweisProjekt(token) : null;
      basis.antwort = eigenesProjekt && projektHinweis && eigenesProjekt !== projektHinweis
        ? { success: false, error: 'agent_token_fremdes_projekt',
          message: `Der Agentenausweis gilt nur fuer sein eigenes Projekt, nicht fuer "${projektHinweis}". Nichts wurde ausgefuehrt.` }
        : { success: false, error: 'token_identitaet_aus', schalter,
          message: `Der Agentenausweis ist ${schalter.project ? `in Projekt "${schalter.project}"` : 'ohne Projektangabe'} nicht wirksam`
            + ` (Ausweis-Kern aus, Quelle ${schalter.quelle}${schalter.letzter_fehler ? ', ' + schalter.letzter_fehler : ''}). Nichts wurde ausgefuehrt.` };
    }
    return basis;
  }
  // W12-B (P22-T25): Hinweisquellen registrieren, sobald der wirksame Schalter EIN ist (registriert/gedrosselt: sofort zurueck).
  await sichereW1bAnmeldungHinweise();
  // P22-T55: mit Ausweis sind agent_id/role wirkungslose Selbstangaben -> nie 'unbekannter_parameter' (nur ausweis_hinweis);
  // nicht deklarierte Exemplare fallen aus args, damit auch die Fachstrecke (PA-1 im Handler) sie nicht als unbekannt meldet.
  const pruefEingabe = token ? Object.fromEntries(Object.entries(eingabe).filter(([k]) => k !== 'agent_id' && k !== 'role')) : eingabe;
  if (token && erlaubteParameter) for (const k of ['agent_id', 'role']) if (!erlaubteParameter.has(k)) delete args[k];
  const parameterBefund = erlaubteParameter ? pruefeUnbekannteParameter(tool, erlaubteParameter, pruefEingabe) : null;
  if (parameterBefund) {
    basis.antwort = { success: false, error: 'unbekannter_parameter', tool,
      unbekannte_parameter: parameterBefund.unbekannt, message: parameterBefund.meldung };
    return basis;
  }
  // P22-T13 Paket B (K3C): tokenfreie Koordinatorliste (der Anmeldende ist noch kein Koordinator).
  if (tool === 'chat' && action === 'koordinator_liste' && await anmeldungAn()) {
    try { basis.antwort = await koordinatorListeAntwort(feld(args, 'project') ?? ''); }
    catch { basis.antwort = { success: false, error: 'koordinator_liste_fehlgeschlagen' }; }
    return basis;
  }
  try {
    if ((Object.hasOwn(eingabe, 'token') || transportToken !== undefined) && !token) throw new AgentIdentitaetFehler('agent_token_ungueltig');
    // Bestehende PC-/CLI-Legacy-Sitzungen bleiben auch bei ID-Modus auf ihrem alten Pfad.
    // Keine Adoption einer Token-Sitzung und keine Identitaetsanlage fuer Alt-Agenten.
    if (bezug.modus !== 'alt' && !token && !Object.hasOwn(eingabe, 'token')) {
      const legacyId = tool === 'chat' && action === 'register' ? feld(args, 'id') : feld(args, 'agent_id');
      const project = feld(args, 'project');
      if (legacyId && project) {
        const legacy = await getPool().query(
          'SELECT 1 FROM agent_sessions WHERE id=$1 AND project=$2 AND identity_id IS NULL', [legacyId, project]);
        if (legacy.rows.length) {
          const k = aktuellerAgentAufruf();
          if (k) k.principal = { art: 'legacy', project, agent_id: legacyId };
          return basis;
        }
      }
    }
    // P22-T16: Der Freigabeschalter macht Legacy-Aufrufe nicht ausweispflichtig.
    // Nur eine explizit beanspruchte Token-Identitaet im Projekt braucht ihren Ausweis.
    // Gleichnamige echte Legacy-Sitzungen behalten in beide/neu ihren eigenen Pfad.
    if (!token && !(tool === 'chat' && ['register', 'anmelden', 'identitaet'].includes(action ?? ''))) {
      const legacyId = feld(args, 'agent_id'), project = feld(args, 'project');
      if (legacyId && project) {
        const tokenName = await getPool().query(
          'SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, legacyId]);
        if (tokenName.rows.length) throw new AgentIdentitaetFehler('agent_token_fehlt');
        const k = aktuellerAgentAufruf();
        if (k) k.principal = { art: 'legacy', project, agent_id: legacyId };
      }
      return basis;
    }
    // Explizite Token-Erstanmeldung. Selbstauskunft verleiht keine Rechte.
    if (tool === 'chat' && action === 'register' && !token) {
      const id = feld(args, 'id'), project = feld(args, 'project');
      if (!id || !project || /^user$/i.test(id)) throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
      // P22-T13 Paket B: bei EIN zuerst Standardanmeldung (Legacy) mit additivem Schattenprofil statt sofortigem Token (K3B);
      // der erste Koordinator eines Projekts bekommt ohne Anfangstoken sein Profil (K3C). AUS: 'token' = t109.
      const weg = await waehleRegisterWeg(project, id);
      if (weg === 'legacy') {
        const k = aktuellerAgentAufruf();
        if (k) k.principal = { art: 'legacy', project, agent_id: id };
        return basis;
      }
      let ausgabeToken: string;
      if (weg === 'erster') {
        try {
          ausgabeToken = (await legeErstenKoordinatorAusgabe(project,
            'User-Auftrag: Anmeldung als Koordinator im Projekt (chat register, erster Koordinator)', feld(args, 'model'))).token;
        } catch (fehler) {
          if (!(fehler instanceof AnmeldungsFehler && fehler.code === 'koordinator_vorhanden')) throw fehler;
          const k = aktuellerAgentAufruf();
          if (k) k.principal = { art: 'legacy', project, agent_id: id };
          return basis;
        }
      } else {
        ausgabeToken = (await stelleAgentTokenAus({ project, name: id, modell_selbstauskunft: feld(args, 'model') }, undefined, bezug)).token;
      }
      const p = await meldeAgentMitTokenAn(ausgabeToken, project, bezug);
      if (await anmeldungAn()) await merkeHerkunftsort(p.lauf_id, herkunftVon(optionen));
      basis.principal = p;
      setzeAufrufPrincipal(p);
      bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter); bezeuge(args, 'project', p.project, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
      const session = bezug.modus === 'alt'
        ? await registerAgent(p.agent_id, p.project, p.modell ?? undefined, feld(args, 'cutoff_date'))
        : { id: p.agent_id, project: p.project, model: p.modell, status: 'active', identity_id: p.identitaet.id };
      const agentOnboarding = await holeAgentOnboarding({ project: p.project, agentId: p.agent_id,
        role: p.rolle, serverInstanceId, explizit: true });
      basis.antwort = { success: true, ...session, action: 'register', token: ausgabeToken,
        principal: zeigePrincipal(p, ausgabeToken), agentOnboarding };
      return basis;
    }
    if (!token) {
      basis.antwort = { success: false, error: 'agent_token_fehlt',
        message: TEXT_AGENT_TOKEN_FEHLT };
      return basis;
    }
    // P22-T13 K16.1: Herkunft der Angaben. Vorbelegte Selbstfelder gehoeren nicht zum Konfliktvergleich.
    const strikt = (await leseW1bSchalter('durchsetzung')).freigegeben;
    const explizit = optionen?.originalArgs ?? eingabe;
    const vorbelegungIgnoriert: string[] = [];
    if (strikt) {
      for (const f of optionen?.vorbelegt ?? []) {
        if (feldBedeutung(tool, action, f) === 'fach' || Object.hasOwn(explizit, f)) continue;
        delete args[f];
        vorbelegungIgnoriert.push(f);
      }
    }
    // K16.5: widerspruechliche Ausweise (Argument vs. Transport) vor jeder Nebenwirkung ablehnen.
    // Nur lesend ueber den Hash; keine Tokenwerte in der Antwort.
    if (strikt && Object.hasOwn(eingabe, 'token') && transportToken && token !== transportToken) {
      const r = await getPool().query<{ identity_id: string }>(
        'SELECT identity_id FROM agent_identitaet_tokens WHERE token_offen = ANY($1::text[]) AND widerrufen_am IS NULL',
        [[token, transportToken]]);
      if (r.rows.length < 2 || new Set(r.rows.map(z => z.identity_id)).size !== 1) {
        basis.antwort = { success: false, error: 'ausweis_konflikt',
          message: 'Mitgesendeter und konfigurierter Agentenausweis bezeichnen nicht dieselbe Identitaet; nichts wurde ausgefuehrt.' };
        return basis;
      }
    }
    // P22-T55 (User 19.10.): mit Ausweis zaehlt NUR die Ausweis-Identitaet. Selbstangaben (agent_id/role/Absender-Aliasse) werden
    // in BEIDEN Modi ignoriert und nur als Hinweis gemeldet (ausweis_hinweis) - kein identitaet_konflikt mehr, kein Abbruch.
    const selbst = sammleSelbstangaben(tool, action, explizit, erlaubteParameter);
    // P22-T44: im fremden Projekt kein Sitzungssignal (Lauf/Sitzung gehoeren der Heimat); der Ausweis wird ohne Projekt geprueft.
    if (fremdProjekt && tool === 'admin' && action === 'index_stats') delete args.sitzung;
    // P22-T50: mit Ausweis ist index_stats(sitzung:'fortsetzung') kein Sitzungssignal mehr (kein neuer Lauf, keine Epoch);
    // die Antwort verweist auf chat(anmelden). Mit onboarding:true bleibt das volle Onboarding als Nachschlagen erhalten.
    // P22-T52: volles Onboarding mit Ausweis OHNE fortsetzung-Parameter nachschlagen: index_stats(onboarding:true) ohne sitzung
    // laeuft intern wie sitzung:'fortsetzung' + onboarding:true (kein neuer Lauf, keine Epoch), ohne Verweis-Hinweis.
    const nachschlagen = !fremdProjekt && tool === 'admin' && action === 'index_stats' && args.onboarding === true
      && (args.sitzung === undefined || args.sitzung === null || args.sitzung === '');
    if (nachschlagen) args.sitzung = 'fortsetzung';
    const ausweisFortsetzung = !nachschlagen && tool === 'admin' && action === 'index_stats' && String(args.sitzung) === 'fortsetzung';
    if (ausweisFortsetzung) {
      basis.sitzung_hinweis = TEXT_AUSWEIS_KEINE_FORTSETZUNG;
      if (args.onboarding !== true) delete args.sitzung;
    }
    const sitzungsSignal = tool === 'admin' && action === 'index_stats' && String(args.sitzung) === 'neu';
    const anmeldung = (tool === 'chat' && (action === 'anmelden' || action === 'register')) || sitzungsSignal;
    const tokenProjekt = fremdProjekt || alleProjekte ? undefined : feld(args, 'project');
    const p = anmeldung ? await meldeAgentMitTokenAn(token, alleProjekte ? undefined : feld(args, 'project'), bezug)
      : await pruefeAgentToken(token, tokenProjekt, bezug);
    // W12-B (P22-T25, V5): aktiven Lauf + Identitaets-Sitzung sichern (erster Token-Aufruf ohne anmelden -> 'implizit',
    // Legacy-Ursprung -> 'uebernahme' mit Bruecke). Nur bei wirksamem Ausweis-Kern; Fehler lassen den Aufruf unberuehrt.
    await sichereLaufFuerAufruf(p, anmeldung ? 'anmelden' : null);
    basis.principal = p;
    const angabeHinweis = ausweisAngabeHinweis(p, selbst);
    if (angabeHinweis) basis.angabe_hinweis = angabeHinweis;
    let fremd: FremdprojektStand | null = null;
    if (fremdProjekt) {
      // P22-T44: Eintrag/Zugang in B (frei | visum | arbeitsfreigabe). Danach arbeitet der Agent in B im Legacy-Namensraum von B
      // (wie Legacy heute); der Profilzuschnitt seiner Heimat-Identitaet gilt weiter (Gate unten mit p).
      try {
        fremd = await sichereFremdprojektZugang({ identity_id: p.identitaet.id, heimat: p.project, project: fremdProjekt, lauf_id: p.lauf_id });
      } catch {
        basis.antwort = { success: false, error: 'fremdprojekt_nicht_pruefbar', project: fremdProjekt,
          message: `Der Zugang zum Projekt "${fremdProjekt}" konnte nicht geprueft werden; nichts wurde ausgefuehrt.` };
        return basis;
      }
      const k = aktuellerAgentAufruf();
      if (k) {
        k.principal = { art: 'legacy', project: fremdProjekt, agent_id: p.agent_id };
        k.fremdprojekt = { project: fremdProjekt, heimat: p.project, zugang: fremd.zugang, identity_id: p.identitaet.id };
      }
      // Pflichtregeln von B einmal je Lauf: Onboarding-Nachweis des Namens in B vergessen -> das Bestands-Onboarding liefert sie.
      if (fremd.regeln_neu) await vergissOnboarding(fremdProjekt, p.agent_id).catch(() => 0);
    } else {
      setzeAufrufPrincipal(p);
    }
    // P22-T50: jev bekommt '*' unveraendert (alle Projekte); andere Tools mit '*' arbeiten in der Heimat.
    const zielProjekt = alleProjekte && tool === 'jev' ? '*' : fremdProjekt ?? p.project;
    // P22-T44: Anzeige Visa/Einwanderungen (einmal je Lauf und bei Aenderung), nur bei Schalter mehrprojekt der Heimat.
    try {
      if (tool !== 'reverse' && (await leseMehrprojektSchalter(p.project)).aktiv) {
        const h = await ausweisProjekteHinweis({ identity_id: p.identitaet.id, heimat: p.project, lauf_id: p.lauf_id });
        if (h) basis.ausweis_hinweise = h;
      }
    } catch { /* Anzeige ist Zugabe */ }
    basis.bestaetigt = { identity_id: p.identitaet.id, agent_id: p.agent_id, project: p.project, rolle: p.rolle,
      modell: p.modell, context_epoch: p.context_epoch, lauf_id: p.lauf_id,
      token_herkunft: Object.hasOwn(eingabe, 'token') ? 'argument' : 'transport', strikt,
      vorbelegung_ignoriert: vorbelegungIgnoriert, ...(fremd ? { ziel_project: fremd.project, zugang: fremd.zugang } : {}) };
    const aufruf = aktuellerAgentAufruf();
    if (aufruf) bestaetigteKontexte.set(aufruf, basis.bestaetigt);
    // t109: Abweichungen nur auditieren. Strikt sind Widersprueche bereits abgelehnt; nur die
    // Modell-Selbstbeobachtung bleibt auditierbar.
    const pruefFelder = strikt
      ? (feldBedeutung(tool, action, 'model') === 'selbst_beobachtung' ? ['model'] : [])
      : ['agent_id', 'role', 'model'];
    const abweichungen = Object.fromEntries(pruefFelder.flatMap(k => {
      const soll = k === 'agent_id' ? p.agent_id : k === 'role' ? p.rolle : p.modell;
      return args[k] !== undefined && args[k] !== soll ? [[k, { vorschlag: args[k], bezeugt: soll }]] : [];
    }));
    if (Object.keys(abweichungen).length) await logToolCall({
      project: p.project, agentId: p.agent_id, source: 'token-identitaet', tool: 'chat',
      action: 'identitaet_abweichung', argsPreview: JSON.stringify(abweichungen), ok: false,
      error: 'selbstauskunft_weicht_ab',
    });
    if (!strikt) {
      // P22-T55: der Exaktfilter files.history.agent_id bleibt wie gesendet - vorher wurde dort die eigene Identitaet
      // eingesetzt (files history mit Ausweis zeigte nur eigene Versionen).
      // chat.get braucht den Leser (DMs/Lesestand) und bekommt im Normalmodus weiter die Identitaet (Bestand t109).
      if (!(tool === 'files' && action === 'history')) bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter);
      bezeuge(args, 'project', zielProjekt, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
      if (Object.hasOwn(args, 'model')) args.model = p.modell;
      // Fachliche Absenderfelder duerfen die gepruefte Attribution nicht wieder ersetzen.
      if (tool === 'thought' && ['add', 'add_batch'].includes(action ?? '')) args.source = p.agent_id;
      if (tool === 'event' && action === 'emit') args.source_id = p.agent_id;
      if (tool === 'chat' && action === 'send') args.sender_id = p.agent_id;
      if (tool === 'chat' && action === 'inbox_send') args.from_agent = p.agent_id;
      if (tool === 'chat' && action === 'inbox_check') args.agent_name = p.agent_id;
      if (tool === 'channel' && action === 'post') args.sender = p.agent_id;
      if (tool === 'channel' && ['join', 'leave', 'mark_read'].includes(action ?? '')) args.agent_name = p.agent_id;
    } else {
      // Nur deklarierte Selbstfelder materialisieren; Fachfilter/Zielwerte bleiben unveraendert.
      if (feldBedeutung(tool, action, 'agent_id') !== 'fach') bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter);
      bezeuge(args, 'project', zielProjekt, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
      if (Object.hasOwn(args, 'model') && feldBedeutung(tool, action, 'model') === 'selbst_beobachtung') args.model = p.modell;
      for (const f of actorAliasFelder(tool, action, erlaubteParameter)) args[f] = p.agent_id;
      bindeVerschachtelteActorFelder(tool, action, args, p.agent_id, erlaubteParameter);
    }
    // P22-T44: Visum = nur lesende Aktionen + Channels; Schreiben braucht die Arbeitsfreigabe durch den Koordinator von B.
    if (fremd?.zugang === 'visum' && !visumErlaubt(tool, action)) {
      basis.antwort = visumAblehnung(tool, action, fremd.project, fremd.heimat, fremd.identity_id, fremd.visum_bis);
      return basis;
    }
    if (anmeldung) {
      if (await anmeldungAn()) await merkeHerkunftsort(p.lauf_id, herkunftVon(optionen));
      // Auch nach Inaktivitaet die Lebensphase erhalten: offene Broadcasts bleiben adressiert.
      if (bezug.modus === 'alt') await getPool().query("UPDATE agent_sessions SET status='active', sitzung_seit=clock_timestamp() WHERE id=$1 AND project=$2 AND identity_id=$3", [p.agent_id, p.project, p.identitaet.id]);
      if (sitzungsSignal) {
        // Die Fachantwort von index_stats bleibt erhalten. Kein 'neu' darf die Lebensphase ersetzen.
        // P22-T43 (D2): das Onboarding liefert der index_stats-Handler (wendeSitzungsSignalAn mit onboarding:true). Ein
        // zweiter, verworfener Aufruf hier wuerde den Profilblock als zugestellt markieren, ohne ihn je zu zeigen.
        args.sitzung = 'fortsetzung'; args.onboarding = true;
      } else {
        // P22-T50 (User 19.10.): jede Anmeldung mit Ausweis ist eine Neuanmeldung -> kein fortsetzung-Block. Profilblock,
        // Profil-Channels und gebundene Tasks liefert das Onboarding (einmal je Lauf); Abloesung hoechstens als eine Zeile.
        const agentOnboarding = await holeAgentOnboarding({ project: p.project, agentId: p.agent_id,
          role: p.rolle, serverInstanceId, explizit: true, koordinatorKurz: true, anmeldung: true });
        const abloesung = await abloesungsZeile(p);
        const eigenePlaene = await eigenePlaeneZeile(p);
        basis.antwort = { success: true, action: 'anmelden', principal: zeigePrincipal(p, token), ...(abloesung ? { abloesung } : {}),
          ...(eigenePlaene ? { offene_plaene: eigenePlaene } : {}), agentOnboarding };
      }
    } else if (tool === 'chat' && action === 'identitaet') {
      // P22-T44 (Debug): Heimat, Schalter mehrprojekt mit Quelle, Projekte im Ausweis mit Zugang und Ablauf.
      basis.antwort = { success: true, action: 'identitaet', principal: zeigePrincipal(p, token), schalter,
        ausweis_projekte: await ausweisProjekteStatus(p.identitaet.id, p.project) };
    }
    // P22-T13 Paket C (K16.4/K16.8): EIN requestweiter Profil-Snapshot (eine PG-Lesung der aktuellen
    // Profil-/Typrevision) fuer Gate, Hinweisfilter VOR Suche/Claim und Agentenprojektion. Fehler ->
    // Ablehnung vor dem Handler, nie alte Freigaben; die nicht sperrbaren Anmelde-/Sitzungsaktionen
    // (Auflage C1) laufen dann ohne Zuschnitt (= heutiges Verhalten) weiter.
    const anpassung = (await leseW1bSchalter('antwortanpassung')).freigegeben;
    if (strikt || anpassung) {
      try {
        await bereiteZuschnittSnapshotVor(agentPrincipalAusAnmeldung(p), { anpassung });
      } catch {
        if (!istNichtSperrbareAktion(tool, action)) {
          basis.antwort = { success: false, error: 'profil_nicht_pruefbar', tool,
            message: 'Der aktuelle Profilzuschnitt konnte nicht ermittelt werden; der Aufruf wurde vor der Ausfuehrung abgelehnt.' };
          return basis;
        }
      }
    }
    // P22-T13 K16.2: EIN Gate vor dem Handler. Kein Profil = heutiges Verhalten; Fehler beim
    // Ermitteln des Zuschnitts lehnt ab statt alte/fremde Freigaben zu verwenden (K16.8).
    // C1: nicht sperrbare Aktionen (tool-gate NICHT_SPERRBARE_AKTIONEN) erreichen das Gate nicht - es kann
    // daher nie nach einer bereits erfolgten Epoch-Erhoehung (anmelden/register/Sitzungssignal) ablehnen.
    if (strikt && !basis.antwort && !istNichtSperrbareAktion(tool, action)) {
      try {
        const zuschnitt = await loeseToolZuschnitt(agentPrincipalAusAnmeldung(p));
        const ablehnung = entscheideToolAufruf(tool, args, { zuschnitt });
        if (ablehnung) {
          basis.antwort = { success: false, error: ablehnung.code, tool, ...(action ? { action } : {}),
            message: ablehnung.message, ...(ablehnung.revision ? { profil_revision: ablehnung.revision } : {}) };
        }
      } catch {
        basis.antwort = { success: false, error: 'profil_nicht_pruefbar', tool,
          message: 'Der aktuelle Profilzuschnitt konnte nicht ermittelt werden; der Aufruf wurde vor der Ausfuehrung abgelehnt.' };
      }
    }
    // P22-T13 Paket C (K15.6): Antwortdefault/Obergrenze deklarierter Mengenparameter VOR dem Handler (keine
    // verlustbehaftete Kuerzung danach); nur mit Schalter antwortanpassung und Profil-limits.
    if (anpassung && !basis.antwort) wendeProfilLimitsAn(tool, action, args, erlaubteParameter);
    return basis;
  } catch (e) {
    if (e instanceof AgentIdentitaetFehler && e.code === 'identitaet_konflikt') {
      basis.antwort = { success: false, error: e.code, ...(e.details ?? {}),
        message: 'Ausdrueckliche Selbstangaben widersprechen dem Agentenausweis; nichts wurde ausgefuehrt.' };
      return basis;
    }
    basis.antwort = { success: false, error: e instanceof AgentIdentitaetFehler ? e.code : 'agent_anmeldung_fehlgeschlagen' };
    return basis;
  }
}
