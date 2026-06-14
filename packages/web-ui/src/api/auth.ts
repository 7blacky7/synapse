/**
 * Synapse Web-UI Auth-Modul (AUTH-6)
 *
 * Zentrale Stelle fuer:
 *  - Token-Storage (localStorage, Key 'synapse_session_token')
 *  - apiFetch(): Wrapper um fetch der an ALLE /api-Requests den
 *    Authorization: Bearer <token> Header haengt + 401 abfaengt.
 *  - Auth-Endpunkt-Helfer (status/setup/confirm/verify/logout) gemaess AUTH-5.
 *
 * Cookie (synapse_session, httpOnly) wird vom Server selbst gesetzt (fuer SSE);
 * hier verwalten wir nur den Bearer-Token fuer normale /api-Requests.
 */

const TOKEN_KEY = 'synapse_session_token';

/** Event das gefeuert wird, wenn der Token ungueltig ist (401) -> App geht zum Login. */
export const AUTH_UNAUTHORIZED_EVENT = 'synapse:unauthorized';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Feuert das Unauthorized-Event. App.tsx lauscht darauf und zeigt den Login-Screen.
 */
function emitUnauthorized(): void {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/**
 * ZENTRALER fetch-Wrapper.
 * - Haengt Authorization: Bearer <token> an, sofern ein Token vorliegt.
 * - Bei 401: Token loeschen + Unauthorized-Event -> zurueck zum Login.
 *
 * Alle Funktionen in synapse-client.ts MUESSEN ueber apiFetch laufen,
 * damit jeder /api-Request authentifiziert ist.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers || {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(input, { ...init, headers });

  if (response.status === 401) {
    // Token abgelaufen/ungueltig -> raus damit + App zum Login schicken.
    clearToken();
    emitUnauthorized();
  }

  return response;
}

// ---------------------------------------------------------------------------
// Auth-Endpunkte (AUTH-5: alle unter /api/auth/*, im Hook allowlisted)
// ---------------------------------------------------------------------------

export interface AuthStatus {
  /** TOTP wurde bereits eingerichtet+bestaetigt -> Login-Modus, sonst Setup-Modus. */
  totpConfigured: boolean;
  /** Aktueller Token/Cookie ist gueltig -> App darf direkt laden. */
  authenticated: boolean;
}

export interface TotpSetup {
  otpauthUri: string;
  qrDataUrl: string;
}

export interface VerifyResult {
  token: string;
  expiresAt: string;
}

/**
 * GET /api/auth/status — steuert das Login-Gate (Setup vs. Login vs. App).
 */
export async function getAuthStatus(): Promise<AuthStatus> {
  // Bewusst apiFetch: schickt den (evtl. vorhandenen) Bearer mit, damit
  // authenticated korrekt zurueckkommt. 401 hier ist unkritisch (allowlisted).
  const response = await apiFetch('/api/auth/status');
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/auth/totp/setup — liefert otpauthUri + qrDataUrl fuer den Setup-Screen.
 */
export async function setupTotp(): Promise<TotpSetup> {
  const response = await apiFetch('/api/auth/totp/setup', { method: 'POST' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * POST /api/auth/totp/confirm — bestaetigt den ersten TOTP-Code (Setup abschliessen).
 */
export async function confirmTotp(code: string): Promise<void> {
  const response = await apiFetch('/api/auth/totp/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.error || 'Code ungueltig');
  }
}

/**
 * POST /api/auth/verify (= verify_2fa_session) — Login.
 * Server setzt zugleich das httpOnly-Cookie synapse_session (fuer SSE).
 * Den zurueckgegebenen Token speichern wir in localStorage (Bearer).
 */
export async function verifySession(code: string): Promise<VerifyResult> {
  const response = await apiFetch('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.error || 'Code ungueltig');
  }
  const data: VerifyResult = await response.json();
  setToken(data.token);
  return data;
}

/**
 * POST /api/auth/logout — Server-seitiges Revoke + Cookie loeschen.
 * Lokal raeumen wir den localStorage-Token in jedem Fall ab.
 */
export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    clearToken();
  }
}
