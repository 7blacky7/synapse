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
import { leseW1bSchalter, leseAusweisKern, ausweisTokenAktiv, ausweisAnmeldungAktiv } from './agent-profil-schalter.js';
import { feldBedeutung, sammleSelbstangaben, actorAliasFelder, bindeVerschachtelteActorFelder } from './agent-selbstfelder.js';
import { entscheideToolAufruf, entscheideToolListe, istNichtSperrbareAktion, type TransportZugang } from './tool-gate.js';
import { loeseToolZuschnitt, TEXT_AGENT_TOKEN_FEHLT } from './agent-profil-vertrag.js';
import { bereiteZuschnittSnapshotVor, wendeProfilLimitsAn } from './agent-zuschnitt.js';
import { zaehle as zaehleZuschnitt } from './agent-zuschnitt-kontext.js';
import {
  waehleRegisterWeg, legeErstenKoordinatorAusgabe, AnmeldungsFehler, fortsetzungFuerAntwort,
  koordinatorListeAntwort, merkeHerkunftsort,
} from './agent-anmeldung.js';
// W12-B (P22-T25, V5/V6): Lauf-Zustellbuchhaltung + Uebernahme-Bruecke; Hinweis-Registry an den wirksamen Schalter.
import { sichereLaufFuerAufruf } from './agent-lauf.js';
import { sichereW1bAnmeldungHinweise } from './agent-anmeldung.js';

import { mitAgentAufrufKontext, leseAgentBezugModus, aktuellerAgentAufruf, agentPrincipalAusAnmeldung, type AgentAufrufKontext } from './agent-bezug.js';
export const AGENT_TOKEN_PARAMETER = {
  token: { type: 'string', description: 'Persoenlicher Synapse-Agentenausweis, bei JEDEM Aufruf mitgeben. chat(anmelden) erneuert den Kontext; Folgeaufrufe pruefen die Identitaet. Nie in Logs/Channels ablegen.' },
};
/** Nur Schemas erweitern; die ausgeschaltete Fachlogik bleibt unveraendert. */
export function ergaenzeAgentTokenParameter(defs: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }>): void {
  for (const d of defs) {
    if (d.inputSchema?.properties) Object.assign(d.inputSchema.properties, AGENT_TOKEN_PARAMETER);
    // P22-T13 Paket B: tokenfreie Koordinatorliste; beworbeneAgentTools blendet sie ohne W1b-Anmeldung aus.
    const action = d.name === 'chat' ? d.inputSchema?.properties?.action as { enum?: unknown[] } | undefined : undefined;
    if (action?.enum && !action.enum.includes('koordinator_liste')) action.enum.push('koordinator_liste');
  }
}
/** P22-T27/T28 (S2): NUR in einer tools/list-Antwort auf eine Anfrage MIT Ausweis und bei wirksamem Ausweis-Kern ist project nicht Pflicht
 * (Serverseitig wird ein Aufruf mit token ohne project immer angenommen, das Projekt kommt aus dem Ausweis). Ohne Ausweis bleibt das Schema wie t110.
 * Fachparameter bleiben unveraendert, nur die Pflichtangabe und die Parameterbeschreibung aendern sich. */
function ausweisProjektOptional(def: { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }): void {
  const s = def.inputSchema;
  if (!s?.required?.includes('project')) return;
  s.required = s.required.filter(f => f !== 'project');
  const p = s.properties?.project as { description?: string } | undefined;
  if (p) p.description = `${p.description ?? 'Projekt-Name'} (mit token/Ausweis optional)`;
}
/** Nur die Werbung ist schalterabhaengig; der interne Annahmevertrag bleibt stabil.
 * Kopien verhindern, dass ein paralleler tools/list-Aufruf andere Verbindungen veraendert.
 */
export async function beworbeneAgentTools<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  defs: T[], opt?: { mitAusweis?: boolean; project?: string | null },
): Promise<T[]> {
  const tokenAn = await ausweisTokenAktiv(opt?.project ?? null);
  const anmeldungAn = await ausweisAnmeldungAktiv(opt?.project ?? null);
  // S2: project nur optional, wenn die Liste MIT Ausweis abgefragt wird UND der Ausweis-Kern wirksam ist.
  const projektOptional = opt?.mitAusweis === true && (await leseAusweisKern(opt?.project ?? null)).aktiv;
  return defs.map(def => {
    const kopie = structuredClone(def);
    if (kopie.inputSchema?.properties) {
      if (!tokenAn) delete kopie.inputSchema.properties.token;
      if (projektOptional) ausweisProjektOptional(kopie);
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
  return mitAgentAufrufKontext({ principal: null, bezug: await leseAgentBezugModus() }, async () =>
    arbeit(await bereiteAgentToolAufrufVor(tool, eingabe, serverInstanceId, transportToken, erlaubteParameter, optionen)));
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
}
function feld(a: Record<string, unknown>, k: string): string | undefined {
  return typeof a[k] === 'string' && a[k] !== '' ? a[k] as string : undefined;
}
function bezeuge(a: Record<string, unknown>, k: string, v: unknown, erlaubt?: Set<string>): void {
  // Deklarierte Felder ueberleben Fachadapter-Spreads; interne Rollen bleiben nur fuer Hooks sichtbar.
  Object.defineProperty(a, k, { value: v, enumerable: Object.hasOwn(a, k) || (k !== 'role' && erlaubt?.has(k) === true), writable: true, configurable: true });
}
function zeigePrincipal(p: AgentTokenAnmeldung): Record<string, unknown> {
  return { identity_id: p.identitaet.id, agent_id: p.agent_id, project: p.project,
    rolle: p.rolle, modell: p.modell, context_epoch: p.context_epoch,
    ...('lauf_id' in p ? { lauf_id: p.lauf_id } : {}), ausweis: '[maskiert]' };
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
  const projektHinweis = feld(eingabe, 'project') ?? null;
  const alterSchalter = await leseTokenIdentitaetSchalter();
  const schalter: typeof alterSchalter = { ...alterSchalter, freigegeben: await ausweisTokenAktiv(projektHinweis, token) };
  const anmeldungAn = (): Promise<boolean> => ausweisAnmeldungAktiv(projektHinweis);

  delete args.token;
  const basis: AgentToolKontext = { aktiv: schalter.freigegeben, args };
  const action = feld(args, 'action');
  if (!schalter.freigegeben) {
    if (Object.hasOwn(eingabe, 'token') || !!transportToken || (tool === 'chat' && ['anmelden', 'identitaet'].includes(action ?? ''))) {
      basis.antwort = { success: false, error: 'token_identitaet_aus', schalter };
    }
    return basis;
  }
  // W12-B (P22-T25): Hinweisquellen registrieren, sobald der wirksame Schalter EIN ist (registriert/gedrosselt: sofort zurueck).
  await sichereW1bAnmeldungHinweise();
  const parameterBefund = erlaubteParameter ? pruefeUnbekannteParameter(tool, erlaubteParameter, eingabe) : null;
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
        principal: zeigePrincipal(p), agentOnboarding };
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
    const selbst = strikt ? sammleSelbstangaben(tool, action, explizit, erlaubteParameter) : undefined;
    const sitzungsSignal = tool === 'admin' && action === 'index_stats' && ['neu', 'fortsetzung'].includes(String(args.sitzung));
    const anmeldung = (tool === 'chat' && (action === 'anmelden' || action === 'register')) || sitzungsSignal;
    const p = anmeldung ? await meldeAgentMitTokenAn(token, feld(args, 'project'), bezug, selbst)
      : await pruefeAgentToken(token, feld(args, 'project'), bezug, selbst);
    // W12-B (P22-T25, V5): aktiven Lauf + Identitaets-Sitzung sichern (erster Token-Aufruf ohne anmelden -> 'implizit',
    // Legacy-Ursprung -> 'uebernahme' mit Bruecke). Nur bei wirksamem Ausweis-Kern; Fehler lassen den Aufruf unberuehrt.
    await sichereLaufFuerAufruf(p, !anmeldung ? null : sitzungsSignal && args.sitzung === 'fortsetzung' ? 'fortsetzung' : 'anmelden');
    basis.principal = p;
    setzeAufrufPrincipal(p);
    basis.bestaetigt = { identity_id: p.identitaet.id, agent_id: p.agent_id, project: p.project, rolle: p.rolle,
      modell: p.modell, context_epoch: p.context_epoch, lauf_id: p.lauf_id,
      token_herkunft: Object.hasOwn(eingabe, 'token') ? 'argument' : 'transport', strikt,
      vorbelegung_ignoriert: vorbelegungIgnoriert };
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
      bezeuge(args, 'agent_id', p.agent_id, erlaubteParameter); bezeuge(args, 'project', p.project, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
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
      bezeuge(args, 'project', p.project, erlaubteParameter); bezeuge(args, 'role', p.rolle, erlaubteParameter);
      if (Object.hasOwn(args, 'model') && feldBedeutung(tool, action, 'model') === 'selbst_beobachtung') args.model = p.modell;
      for (const f of actorAliasFelder(tool, action, erlaubteParameter)) args[f] = p.agent_id;
      bindeVerschachtelteActorFelder(tool, action, args, p.agent_id, erlaubteParameter);
    }
    if (anmeldung) {
      if (await anmeldungAn()) await merkeHerkunftsort(p.lauf_id, herkunftVon(optionen));
      // Auch nach Inaktivitaet die Lebensphase erhalten: offene Broadcasts bleiben adressiert.
      if (bezug.modus === 'alt') await getPool().query("UPDATE agent_sessions SET status='active', sitzung_seit=clock_timestamp() WHERE id=$1 AND project=$2 AND identity_id=$3", [p.agent_id, p.project, p.identitaet.id]);
      const agentOnboarding = await holeAgentOnboarding({ project: p.project, agentId: p.agent_id,
        role: p.rolle, serverInstanceId, explizit: true });
      if (sitzungsSignal) {
        // Die Fachantwort von index_stats bleibt erhalten. Kein 'neu' darf die Lebensphase ersetzen.
        args.sitzung = 'fortsetzung'; args.onboarding = true;
      } else {
        basis.antwort = { success: true, action: 'anmelden', principal: zeigePrincipal(p), agentOnboarding,
          ...(await fortsetzungFuerAntwort(agentPrincipalAusAnmeldung(p))) };
      }
    } else if (tool === 'chat' && action === 'identitaet') {
      basis.antwort = { success: true, action: 'identitaet', principal: zeigePrincipal(p), schalter };
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
