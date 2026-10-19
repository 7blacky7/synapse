/**
 * P22-T2 / W0b: Variante A. Kein Supervisor und keine neue Agentenverwaltung.
 * Produktionsbasis: SYNAPSE_MAIN_SYNAPSE=1, sonst artefakt-only.
 * Testoverride: intern/main_synapse (freigegeben), frisch gelesen; Fehler -> Basis.
 * Der Scope ist nur die minimale W2-Sessionbindung; W1 ersetzt ihn durch Run-Principals.
 */
import { alleSchalter, getPool, entscheideToolListe, entscheideToolAufruf, gateToolListe, type InternSchalterStand } from '@synapse/core';
import { leseHauptagentSchalter, HAUPTAGENT_PROJEKT, HAUPTAGENT_AGENT_ID, HAUPTAGENT_ROLLE } from '@synapse/core';
import { getTokenRow, type AuthTokenRow } from '../auth.js';

export type MainToolProfile = 'artefakt-only' | 'main-synapse';
export const MAIN_SYNAPSE_SCOPE = 'hauptagent:main-synapse:';
export const MAIN_PROFILE_HEADER = 'x-synapse-werkzeugprofil';
/**
 * P22-T36 (W2-P1): Identitaetsweg bei Schalter hauptagent EIN. Der Bearer ist an die Main-IDENTITAET gebunden (nicht an
 * die Chat-Session); der Agenten-Ausweis kommt per Header x-synapse-agent-token. Schalter AUS = Session-Weg unveraendert.
 */
export const HAUPTAGENT_IDENTITAET_SCOPE = 'hauptagent:identitaet:';

export function hauptagentIdentitaetScope(identityId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(identityId)) throw new Error('Ungueltige Hauptagenten-Identitaet');
  return HAUPTAGENT_IDENTITAET_SCOPE + identityId;
}

export interface MainProfileStand {
  profile: MainToolProfile;
  quelle: 'standard' | 'intern';
  bis: string | null;
  revision: string | null;
  letzterFehler: string | null;
}

export function entscheideMainProfil(
  env: NodeJS.ProcessEnv,
  override?: InternSchalterStand,
  jetzt = Date.now(),
): MainProfileStand {
  const basis: MainProfileStand = {
    profile: env.SYNAPSE_MAIN_SYNAPSE === '1' ? 'main-synapse' : 'artefakt-only',
    quelle: 'standard', bis: null, revision: null, letzterFehler: null,
  };
  if (env.SYNAPSE_INTERN_TOOL !== '1' || !override || override.name !== 'main_synapse'
    || override.modus !== 'freigegeben' || !override.gesetzt_am
    || (override.bis === null ? !override.dauerhaft
      : !Number.isFinite(Date.parse(override.bis)) || Date.parse(override.bis) <= jetzt)) return basis;
  return {
    profile: override.gesetzt ? 'main-synapse' : 'artefakt-only',
    quelle: 'intern', bis: override.bis, revision: override.gesetzt_am, letzterFehler: null,
  };
}

export async function leseMainProfil(): Promise<MainProfileStand> {
  if (process.env.SYNAPSE_INTERN_TOOL !== '1') return entscheideMainProfil(process.env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Kein leseSchalter-Cache: dessen Fehlerfall behaelt absichtlich den alten Stand.
    const staende = await Promise.race([
      alleSchalter(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Intern-Lesezeitlimit')), 2000);
        timer.unref?.();
      }),
    ]);
    return entscheideMainProfil(process.env, staende.find(s => s.name === 'main_synapse'));
  } catch {
    return { ...entscheideMainProfil(process.env), letzterFehler: 'Intern-Schalter nicht lesbar; Produktionsbasis gilt.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function mainProfileScope(sessionId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) throw new Error('Ungueltige Hauptagenten-Session');
  return MAIN_SYNAPSE_SCOPE + sessionId;
}

/** Selbst ein entfernter Profil-/Sessionheader darf den Ausweis nicht zum Legacy-Token machen. */
export function mainScopePasst(
  scope: string | null,
  method: string,
  pathname: string,
  headers: Record<string, unknown>,
): boolean {
  // P22-T36: der Identitaets-Bearer gilt nur fuer den MCP-Weg mit Werkzeugprofil und Ausweis.
  if (scope?.startsWith(HAUPTAGENT_IDENTITAET_SCOPE)) {
    return method === 'POST' && (pathname === '/' || pathname === '/mcp/messages')
      && headers[MAIN_PROFILE_HEADER] === 'main-synapse'
      && typeof headers['x-synapse-agent-token'] === 'string';
  }
  if (!scope?.startsWith(MAIN_SYNAPSE_SCOPE)) return true;
  return method === 'POST' && (pathname === '/' || pathname === '/mcp/messages')
    && headers[MAIN_PROFILE_HEADER] === 'main-synapse'
    && headers['x-synapse-hauptagent-session'] === scope.slice(MAIN_SYNAPSE_SCOPE.length);
}

export interface MainToolAccess {
  profile: MainToolProfile;
  sessionId: string | null;
  agentId: string | null;
  stand?: MainProfileStand;
  error?: string;
  /** P22-T36: gesetzt nur auf dem Identitaetsweg (Schalter hauptagent EIN). */
  identityId?: string | null;
}

interface ProfileDeps {
  stand(): Promise<MainProfileStand>;
  token(value: string): Promise<AuthTokenRow | null>;
  session(id: string): Promise<boolean>;
  /** P22-T36: optional (Bestandstests liefern sie nicht) - ohne beide gilt nur der Session-Weg. */
  hauptagent?(): Promise<{ aktiv: boolean }>;
  identitaet?(identityId: string, sessionId: string | null, ausweis: string): Promise<boolean>;
}
const deps: ProfileDeps = {
  stand: leseMainProfil,
  token: getTokenRow,
  session: async id => (await getPool().query(
    'SELECT id FROM agent_runtime_sessions WHERE id = $1 AND runtime = $2', [id, 'claude'],
  )).rows.length === 1,
  hauptagent: leseHauptagentSchalter,
  // Ausweis gehoert zur aktiven Main-Identitaet (Rolle main im reservierten Bereich) und ist gueltig; Session (falls genannt) gehoert ihr.
  identitaet: async (identityId, sessionId, ausweis) => {
    const r = await getPool().query(
      `SELECT 1 FROM agent_identitaeten i JOIN agent_identitaet_tokens t ON t.identity_id = i.id
        WHERE i.id = $1 AND i.project = $2 AND i.rolle = $3 AND i.status = 'aktiv' AND t.token_offen = $4
          AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis > NOW()) LIMIT 1`,
      [identityId, HAUPTAGENT_PROJEKT, HAUPTAGENT_ROLLE, ausweis]);
    if (r.rows.length !== 1) return false;
    if (!sessionId) return true;
    return (await getPool().query('SELECT 1 FROM agent_runtime_sessions WHERE id::text = $1 AND identity_id = $2', [sessionId, identityId])).rows.length === 1;
  },
};

/** Ein Header waehlt nur einen Kandidaten; Freigabe und Ausweis bestaetigt der Server. */
export async function mainToolAccess(
  headers: Record<string, unknown>,
  d: ProfileDeps = deps,
): Promise<MainToolAccess> {
  const sessionId = typeof headers['x-synapse-hauptagent-session'] === 'string'
    ? (headers['x-synapse-hauptagent-session'] as string).trim() || null : null;
  const legacy: MainToolAccess = { profile: 'artefakt-only', sessionId, agentId: null };
  if (headers[MAIN_PROFILE_HEADER] !== 'main-synapse') return legacy;
  const denied = (error: string): MainToolAccess => ({ ...legacy, error });
  // P22-T36: Identitaetsweg nur mit Ausweis-Header UND Identitaets-Bearer; alles andere bleibt der Session-Weg.
  const ausweis = typeof headers['x-synapse-agent-token'] === 'string' ? (headers['x-synapse-agent-token'] as string).trim() : '';
  if (ausweis && d.hauptagent && d.identitaet) {
    const bearerI = typeof headers.authorization === 'string'
      ? /^Bearer\s+(.+)$/i.exec(headers.authorization)?.[1]?.trim() : null;
    let rowI: AuthTokenRow | null = null;
    try { rowI = bearerI ? await d.token(bearerI) : null; } catch { return denied('main_profil_nicht_pruefbar'); }
    if (rowI?.scope?.startsWith(HAUPTAGENT_IDENTITAET_SCOPE)) {
      const identityId = rowI.scope.slice(HAUPTAGENT_IDENTITAET_SCOPE.length);
      if (sessionId && !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) return denied('main_session_fehlt');
      try {
        if (!(await d.hauptagent()).aktiv) return denied('hauptagent_aus');
        if (rowI.kind !== 'service' || (rowI.expires_at && rowI.expires_at.getTime() <= Date.now())
          || !await d.identitaet(identityId, sessionId, ausweis)) return denied('main_identitaet_nicht_autorisiert');
        return { profile: 'main-synapse', sessionId: sessionId ?? 'identitaet-' + identityId, agentId: HAUPTAGENT_AGENT_ID, identityId };
      } catch {
        return denied('main_profil_nicht_pruefbar');
      }
    }
  }
  if (!sessionId || !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId)) return denied('main_session_fehlt');
  try {
    const stand = await d.stand();
    if (stand.profile !== 'main-synapse') return { ...denied('main_synapse_aus'), stand };
    const bearer = typeof headers.authorization === 'string'
      ? /^Bearer\s+(.+)$/i.exec(headers.authorization)?.[1]?.trim() : null;
    const row = bearer ? await d.token(bearer) : null;
    if (!row || row.kind !== 'service' || row.scope !== mainProfileScope(sessionId)
      || (row.expires_at && row.expires_at.getTime() <= Date.now())
      || !await d.session(sessionId)) return denied('main_session_nicht_autorisiert');
    return { profile: 'main-synapse', sessionId, agentId: 'main-' + sessionId, stand };
  } catch {
    return denied('main_profil_nicht_pruefbar');
  }
}

/** Reguläres Inventar kommt unverändert aus dem bestehenden MCP-Dispatcher.
 * P22-T13 K16.2: REST-Adapter des EINEN Gate-Kerns (core tool-gate.ts); Semantik unveraendert. */
export function mainToolListe<T extends { name: string }>(tools: T[], access: MainToolAccess): T[] {
  return entscheideToolListe(tools, { transport: access });
}

/** tools/list mit Profilteil (nur bei W1b-Durchsetzung und identitaetsgebundenem Transporttoken). */
export async function mainToolListeMitProfil<T extends { name: string; inputSchema?: { properties?: Record<string, unknown> } }>(
  tools: T[], access: MainToolAccess, transportToken?: string,
): Promise<T[]> {
  return gateToolListe(tools, { transport: access, transportToken });
}

/** tokenAufruf (nur unter W1b-Durchsetzung): Akteur kommt aus dem Token, keine synthetische Main-ID vergleichen (K16.1). */
export function mainToolAblehnung(
  name: string, args: Record<string, unknown>, access: MainToolAccess, tools: { name: string }[],
  optionen: { tokenAufruf?: boolean } = {},
): string | null {
  return entscheideToolAufruf(name, args, { transport: access, tokenAufruf: optionen.tokenAufruf === true }, tools)?.code ?? null;
}
