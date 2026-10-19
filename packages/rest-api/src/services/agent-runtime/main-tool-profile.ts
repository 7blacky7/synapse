/**
 * P22-T2 / W0b: Variante A. Kein Supervisor und keine neue Agentenverwaltung.
 * Produktionsbasis: SYNAPSE_MAIN_SYNAPSE=1, sonst artefakt-only.
 * Testoverride: intern/main_synapse (freigegeben), frisch gelesen; Fehler -> Basis.
 * Der Scope ist nur die minimale W2-Sessionbindung; W1 ersetzt ihn durch Run-Principals.
 */
import { alleSchalter, getPool, entscheideToolListe, entscheideToolAufruf, gateToolListe, type InternSchalterStand } from '@synapse/core';
import { getTokenRow, type AuthTokenRow } from '../auth.js';

export type MainToolProfile = 'artefakt-only' | 'main-synapse';
export const MAIN_SYNAPSE_SCOPE = 'hauptagent:main-synapse:';
export const MAIN_PROFILE_HEADER = 'x-synapse-werkzeugprofil';

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
}

interface ProfileDeps {
  stand(): Promise<MainProfileStand>;
  token(value: string): Promise<AuthTokenRow | null>;
  session(id: string): Promise<boolean>;
}
const deps: ProfileDeps = {
  stand: leseMainProfil,
  token: getTokenRow,
  session: async id => (await getPool().query(
    'SELECT id FROM agent_runtime_sessions WHERE id = $1 AND runtime = $2', [id, 'claude'],
  )).rows.length === 1,
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
