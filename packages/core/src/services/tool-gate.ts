/**
 * P22-T13 Phase V (K16.2): EINZIGER gemeinsamer Entscheidungskern fuer tools/list und tools/call,
 * transportunabhaengig (REST und stdio). Rein funktional: keine DB, keine Env, keine Seiteneffekte.
 *
 * Zwei Eingaenge, dieselbe Entscheidung:
 *  - transport: bestehender Hauptagenten-Zugang (P22-T2, main-tool-profile.ts). Semantik exakt wie
 *    bisher mainToolListe/mainToolAblehnung - main-tool-profile.ts delegiert hierher.
 *  - zuschnitt: individueller Tool-/Aktionszuschnitt eines bestaetigten Token-Profils (Paket C
 *    liefert ihn ueber loeseToolZuschnitt). Ohne Zuschnitt = exakt heutiges Verhalten.
 *
 * intern (b930e4af): Bei SYNAPSE_INTERN_TOOL=1 fuer ALLE. Ein Profil-Zuschnitt gilt fuer intern
 * NUR, wenn der USER das fuer dieses Profil festgelegt hat (intern_user_festgelegt). Allgemeine
 * Typ-/Allowlist-/Standardregeln greifen fuer intern nicht. Der Kern schaltet intern nie EIN: ist
 * das Tool nicht im Inventar (Startparameter AUS), bleibt es weg. Die Ausnahme 'main-synapse ohne
 * intern' ist bestehende Transportregel des Hauptagenten, keine Rollen-Sperre.
 * Fachliche Rollen-/Objektpruefungen bleiben in den Handlern; ein Zuschnitt erweitert keine Rechte.
 */
export type ZugriffsRegel = 'erlaubt' | 'verweigert';

export interface ToolZuschnitt {
  /** Profil-/Typrevision, aus der der Zuschnitt stammt (Diagnose, revisionsadressierter Cache). */
  revision: string;
  quelle?: string;
  /** Grundeinstellung fuer nicht genannte Tools; Standard 'erlaubt'. */
  standard?: ZugriffsRegel;
  tools?: Record<string, ZugriffsRegel>;
  /** Schluessel '<tool>.<action>'; praezisiert die Toolregel. */
  aktionen?: Record<string, ZugriffsRegel>;
  /** b930e4af: nur bei ausdruecklicher User-Festlegung gilt der Zuschnitt auch fuer intern. */
  intern_user_festgelegt?: boolean;
}

/** Strukturell identisch zu MainToolAccess (rest-api), damit der Kern ohne REST-Abhaengigkeit bleibt. */
export interface TransportZugang {
  profile: 'artefakt-only' | 'main-synapse';
  sessionId: string | null;
  agentId: string | null;
  error?: string;
}

export interface ToolGateEingabe {
  transport?: TransportZugang | null;
  zuschnitt?: ToolZuschnitt | null;
  /** K16.1: Token-Aufruf unter W1b-Durchsetzung - keine synthetische Main-ID als Selbstanspruch vergleichen. */
  tokenAufruf?: boolean;
}

export interface ToolGateAblehnung {
  code: string;
  message: string;
  quelle: 'transport' | 'profil';
  revision?: string;
}

type ToolDef = { name: string; inputSchema?: { properties?: Record<string, unknown> } };

/**
 * P22-T13 Paket C, Auflage C1: Anmeldung, Identitaetsauskunft, tokenfreie Koordinatorliste und das
 * Sitzungssignal (admin.index_stats) sind NICHT SPERRBARE Pflichtaktionen. Sie bleiben in jeder
 * identitaetsgebundenen Liste und jeder Aufruf ist erlaubt - Liste und Call sind konsistent, und kein
 * Profil-Gate kann nach einer bereits erfolgten Epoch-Erhoehung (anmelden/register/Sitzungssignal) ablehnen.
 * Gilt nur fuer den Profilzuschnitt; Transportregeln (Hauptagent) bleiben unveraendert.
 */
export const NICHT_SPERRBARE_AKTIONEN: ReadonlySet<string> = new Set([
  'chat.register', 'chat.anmelden', 'chat.identitaet', 'chat.koordinator_liste', 'admin.index_stats',
  // P22-T144: eigene Zustellungen quittieren darf kein Profil sperren (sonst kaeme nach jedem Neustart die Erinnerung).
  'chat.quittieren',
]);

export function istNichtSperrbareAktion(name: string, action: string | undefined): boolean {
  return action !== undefined && NICHT_SPERRBARE_AKTIONEN.has(name + '.' + action);
}

function transportErlaubt(name: string, t: TransportZugang): boolean {
  if (!t.sessionId) return true;
  return t.profile === 'main-synapse' ? name !== 'intern' : name === 'artefakt';
}

function zuschnittGilt(name: string, z: ToolZuschnitt): boolean {
  return name !== 'intern' || z.intern_user_festgelegt === true;
}

function toolRegel(name: string, z: ToolZuschnitt): ZugriffsRegel {
  return z.tools?.[name] ?? z.standard ?? 'erlaubt';
}

/** Wirksame Regel fuer Tool + Aktion (Aktion praezisiert Tool, Tool praezisiert Standard). */
export function aktionRegel(name: string, action: string | undefined, z: ToolZuschnitt): ZugriffsRegel {
  if (istNichtSperrbareAktion(name, action)) return 'erlaubt';
  if (!zuschnittGilt(name, z)) return 'erlaubt';
  const a = action !== undefined ? z.aktionen?.[name + '.' + action] : undefined;
  return a ?? toolRegel(name, z);
}

/** Aktionen aus der vorhandenen Definition (inputSchema.properties.action.enum), sonst null. */
export function definitionsAktionen(def: ToolDef): string[] | null {
  const action = def.inputSchema?.properties?.action as { enum?: unknown[] } | undefined;
  return Array.isArray(action?.enum) ? action.enum.filter((a): a is string => typeof a === 'string') : null;
}

/**
 * tools/list: verweigerte Tools verschwinden; bei einzelnen gesperrten Aktionen wird das
 * Aktionenschema einer KOPIE eingeschraenkt; ein Tool ohne erlaubte Aktion wird verborgen.
 * Geteilte Definitionen werden nie mutiert.
 */
export function entscheideToolListe<T extends ToolDef>(tools: T[], e: ToolGateEingabe): T[] {
  const t = e.transport;
  if (t?.error) return [];
  const liste = t && t.sessionId ? tools.filter(d => transportErlaubt(d.name, t)) : tools;
  const z = e.zuschnitt;
  if (!z) return liste;
  const out: T[] = [];
  for (const d of liste) {
    if (!zuschnittGilt(d.name, z)) { out.push(d); continue; }
    const aktionen = definitionsAktionen(d);
    if (!aktionen) {
      if (toolRegel(d.name, z) === 'erlaubt') out.push(d);
      continue;
    }
    const erlaubt = aktionen.filter(a => aktionRegel(d.name, a, z) === 'erlaubt');
    if (!erlaubt.length) continue;
    if (erlaubt.length === aktionen.length) { out.push(d); continue; }
    const kopie = structuredClone(d);
    (kopie.inputSchema!.properties!.action as { enum: string[] }).enum = erlaubt;
    out.push(kopie);
  }
  return out;
}

/**
 * tools/call: Pflichtpruefung VOR dem Handler. inventar = das im Transport angebotene Inventar
 * (fuer den Transportteil wie bisher mainToolAblehnung). Liefert null = erlaubt.
 */
export function entscheideToolAufruf(
  name: string, args: Record<string, unknown>, e: ToolGateEingabe, inventar?: { name: string }[],
): ToolGateAblehnung | null {
  const t = e.transport;
  if (t?.error) return { code: t.error, message: 'Werkzeug durch Hauptagenten-Profil oder Sessionbindung abgelehnt.', quelle: 'transport' };
  if (t?.sessionId) {
    if ((inventar && !inventar.some(x => x.name === name)) || !transportErlaubt(name, t)) {
      return { code: t.profile === 'artefakt-only' ? 'hauptagent_nur_artefakt' : 'main_werkzeug_nicht_freigegeben',
        message: 'Werkzeug durch Hauptagenten-Profil oder Sessionbindung abgelehnt.', quelle: 'transport' };
    }
    if (t.agentId && !e.tokenAufruf && args.agent_id !== undefined && args.agent_id !== t.agentId) {
      return { code: 'main_agent_id_abweichend', message: 'Werkzeug durch Hauptagenten-Profil oder Sessionbindung abgelehnt.', quelle: 'transport' };
    }
  }
  const z = e.zuschnitt;
  if (!z || !zuschnittGilt(name, z)) return null;
  const action = typeof args.action === 'string' ? args.action : undefined;
  if (aktionRegel(name, action, z) === 'erlaubt') return null;
  const aktionGesperrt = action !== undefined && z.aktionen?.[name + '.' + action] === 'verweigert';
  return {
    code: aktionGesperrt ? 'profil_aktion_gesperrt' : 'profil_werkzeug_gesperrt',
    message: aktionGesperrt
      ? `Die Aktion "${name}.${action}" ist fuer dieses Agentenprofil nicht freigegeben.`
      : `Das Werkzeug "${name}" ist fuer dieses Agentenprofil nicht freigegeben.`,
    quelle: 'profil', revision: z.revision,
  };
}
