/**
 * Synapse API - OAuth 2.0 / 2.1 Server (PLAN-002, AUTH-3)
 * ============================================================================
 * Fuer claude.ai- UND chatgpt.com-MCP-Connectors sowie Claude-Code (loopback).
 *
 * AENDERUNGEN ggue. der alten In-Memory-Variante:
 *  - KEINE In-Memory-Maps mehr. Clients -> auth_oauth_clients, Tokens/Codes ->
 *    auth_tokens (alles via services/auth.ts bzw. direktem getPool() fuer Clients).
 *  - /authorize: Auto-Authorize ENTFERNT. Stattdessen TOTP-Consent-Step
 *    (simple HTML-Seite, fragt 6-stelligen TOTP-Code ab -> verifyTotp ->
 *    issueAuthCode + redirect). PKCE code_challenge wird mit dem Code gespeichert.
 *  - /token: authorization_code -> verifyPkceS256(verifier vs gespeicherter
 *    challenge) -> issueAccessToken(24h)+issueRefreshToken(120d);
 *    refresh_token -> rotateRefresh (OAuth-2.1-Rotation). Akzeptiert
 *    application/x-www-form-urlencoded (Plugin-lokaler Body-Parser).
 *  - Discovery vervollstaendigt: code_challenge_methods_supported:["S256"],
 *    offline_access, registration_endpoint, token_endpoint_auth_methods_supported.
 *  - protected-resource: resource == exakte MCP-Server-URL (${baseUrl}/mcp),
 *    authorization_servers:[issuer].
 *  - resource-Parameter (RFC 8707) wird authorize+token durchgereicht/geechoet.
 *  - Redirect-Allowlist: claude.ai / chatgpt.com (+legacy) / loopback
 *    (http://localhost|127.0.0.1/callback, PORT-AGNOSTISCH).
 *
 * NICHT hier: globaler Auth-Hook (AUTH-4), Web-UI-Login (AUTH-6).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getPool } from '@synapse/core';
import {
  verifyTotp,
  isTotpConfirmed,
  verifyPkceS256,
  issueAccessToken,
  issueRefreshToken,
  issueAuthCode,
  getTokenRow,
  revokeToken,
  rotateRefresh,
  ACCESS_TTL_MS,
} from '../services/auth.js';

// ---------------------------------------------------------------------------
// Typen / Konstanten
// ---------------------------------------------------------------------------

interface OAuthClientRow {
  client_id: string;
  client_secret: string | null;
  redirect_uris: string[];
  client_name: string | null;
  created_at: Date;
}

/** Default-Scope wenn der Client keinen anfragt. */
const DEFAULT_SCOPE = 'mcp:tools';
/** Unterstuetzte Scopes (offline_access -> Refresh-Token, von claude verlangt). */
const SUPPORTED_SCOPES = ['mcp:tools', 'mcp:read', 'mcp:write', 'offline_access'];

/** Statische Redirect-URI-Allowlist (exakter Match). */
const STATIC_REDIRECT_ALLOWLIST = new Set<string>([
  // claude.ai hosted (Web/Desktop/Mobile/Cowork)
  'https://claude.ai/api/mcp/auth_callback',
  // ChatGPT legacy
  'https://chatgpt.com/connector_platform_oauth_redirect',
]);

/** Prefix-Allowlist (ChatGPT App-spezifische Callback-ID haengt hinten dran). */
const PREFIX_REDIRECT_ALLOWLIST = [
  'https://chatgpt.com/connector/oauth/',
];

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

/** Ermittelt die externe Base-URL (HTTPS hinter Reverse-Proxy beruecksichtigen). */
function getBaseUrl(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (forwardedProto) {
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${protocol}://${request.hostname}`;
  }
  const hostname = request.hostname;
  if (
    hostname.includes('.') &&
    !hostname.startsWith('localhost') &&
    !hostname.startsWith('127.') &&
    !hostname.startsWith('192.168.') &&
    !hostname.startsWith('172.') &&
    !hostname.startsWith('10.')
  ) {
    return `https://${hostname}`;
  }
  return `${request.protocol}://${hostname}`;
}

/**
 * Prueft eine Redirect-URI gegen die Allowlist + die beim Client registrierten
 * URIs. Claude-Code-Loopback (http://localhost|127.0.0.1/callback) wird
 * PORT-AGNOSTISCH gematcht (RFC 8252: Port-Komponente ignorieren).
 */
function isRedirectAllowed(redirectUri: string, client: OAuthClientRow): boolean {
  if (!redirectUri) return false;

  // 1. Beim Client registrierte exakte URIs.
  if (client.redirect_uris && client.redirect_uris.includes(redirectUri)) return true;

  // 2. Statische Plattform-Allowlist (exakt).
  if (STATIC_REDIRECT_ALLOWLIST.has(redirectUri)) return true;

  // 3. Prefix-Allowlist (ChatGPT /connector/oauth/{id}).
  if (PREFIX_REDIRECT_ALLOWLIST.some((p) => redirectUri.startsWith(p))) return true;

  // 4. Loopback port-agnostisch (Claude Code, RFC 8252).
  try {
    const u = new URL(redirectUri);
    const isLoopbackHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'http:' && isLoopbackHost && u.pathname === '/callback') {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

/** Liest einen OAuth-Client aus Postgres. */
async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  if (!clientId) return null;
  const pool = getPool();
  const res = await pool.query<OAuthClientRow>(
    `SELECT client_id, client_secret, redirect_uris, client_name, created_at
       FROM auth_oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return res.rows[0] ?? null;
}

/** TTL in Sekunden bis expiresAt (fuer OAuth expires_in). */
function expiresInSeconds(expiresAt: Date | null): number {
  if (!expiresAt) return Math.floor(ACCESS_TTL_MS / 1000);
  return Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
}

/** HTML-Escape fuer Werte die in die Consent-Seite eingebettet werden. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Rendert die TOTP-Consent-Seite. error optional (rote Fehlermeldung). */
function renderConsentPage(params: {
  clientName: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  resource: string;
  error?: string;
}): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`;
  const errorBlock = params.error
    ? `<p style="color:#c0392b;margin:0 0 12px;font-size:14px;">${escapeHtml(params.error)}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Synapse — Zugriff bestaetigen</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background:#0d1117; color:#e6edf3;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:32px;
          width:100%; max-width:380px; box-shadow:0 8px 24px rgba(0,0,0,.4); }
  h1 { font-size:18px; margin:0 0 4px; }
  p.sub { color:#8b949e; font-size:13px; margin:0 0 20px; }
  label { display:block; font-size:13px; margin:0 0 6px; color:#8b949e; }
  input[type=text] { width:100%; box-sizing:border-box; padding:12px; font-size:20px;
          letter-spacing:6px; text-align:center; background:#0d1117; color:#e6edf3;
          border:1px solid #30363d; border-radius:8px; }
  button { width:100%; margin-top:16px; padding:12px; font-size:15px; font-weight:600;
          background:#238636; color:#fff; border:0; border-radius:8px; cursor:pointer; }
  button:hover { background:#2ea043; }
  .client { font-weight:600; color:#e6edf3; }
</style>
</head>
<body>
  <div class="card">
    <h1>Zugriff bestaetigen</h1>
    <p class="sub"><span class="client">${escapeHtml(params.clientName)}</span> moechte sich mit deinem Synapse-Server verbinden. Gib deinen 6-stelligen Code aus der Authenticator-App ein.</p>
    ${errorBlock}
    <form method="POST" action="/authorize">
      <label for="totp_code">Authenticator-Code</label>
      <input id="totp_code" name="totp_code" type="text" inputmode="numeric" autocomplete="one-time-code"
             pattern="[0-9]*" maxlength="6" autofocus placeholder="000000" />
      ${hidden('client_id', params.client_id)}
      ${hidden('redirect_uri', params.redirect_uri)}
      ${hidden('scope', params.scope)}
      ${hidden('state', params.state)}
      ${hidden('code_challenge', params.code_challenge)}
      ${hidden('resource', params.resource)}
      <button type="submit">Verbinden</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------

export async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * Plugin-lokaler Body-Parser fuer application/x-www-form-urlencoded.
   * claude.ai/ChatGPT senden /token (und unser /authorize-POST) so. Fastify
   * bringt von Haus aus nur JSON/Text mit. Scope ist dieses Plugin -> global
   * (server.ts) bleibt unveraendert.
   */
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const obj: Record<string, string> = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        done(null, obj);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /**
   * OAuth Authorization Server Metadata (RFC 8414).
   */
  fastify.get('/.well-known/oauth-authorization-server', async (request) => {
    const baseUrl = getBaseUrl(request);
    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'none',
      ],
      scopes_supported: SUPPORTED_SCOPES,
      code_challenge_methods_supported: ['S256'],
    };
  });

  /**
   * OAuth Protected Resource Metadata (RFC 9728).
   * resource MUSS exakt die MCP-Server-URL sein (hier: ${baseUrl}/mcp).
   */
  fastify.get('/.well-known/oauth-protected-resource', async (request) => {
    const baseUrl = getBaseUrl(request);
    return {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    };
  });

  /**
   * Dynamic Client Registration (RFC 7591). Body = application/json.
   * Clients werden persistent in auth_oauth_clients gespeichert.
   */
  fastify.post<{
    Body: {
      redirect_uris?: string[];
      client_name?: string;
      grant_types?: string[];
      response_types?: string[];
      token_endpoint_auth_method?: string;
    };
  }>('/register', async (request, reply) => {
    const { redirect_uris = [], client_name, grant_types, response_types } =
      request.body || {};

    const client_id = `synapse_${randomUUID().replace(/-/g, '')}`;
    // Public clients (PKCE) brauchen kein Secret; wir vergeben dennoch eins
    // fuer confidential-Faelle (client_secret_basic/post).
    const client_secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

    const pool = getPool();
    await pool.query(
      `INSERT INTO auth_oauth_clients (client_id, client_secret, redirect_uris, client_name)
       VALUES ($1, $2, $3, $4)`,
      [client_id, client_secret, redirect_uris, client_name ?? null],
    );

    request.log.info(`[OAuth] Client registriert (persistent): ${client_id}`);

    return reply.status(201).send({
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0, // niemals
      redirect_uris,
      client_name,
      grant_types: grant_types || ['authorization_code', 'refresh_token'],
      response_types: response_types || ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  /**
   * Authorization Endpoint — GET zeigt die TOTP-Consent-Seite.
   * KEIN Auto-Authorize mehr. PKCE S256 ist Pflicht (code_challenge erforderlich).
   */
  fastify.get<{
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      resource?: string;
    };
  }>('/authorize', async (request, reply) => {
    const {
      response_type,
      client_id = '',
      redirect_uri = '',
      scope = DEFAULT_SCOPE,
      state = '',
      code_challenge = '',
      code_challenge_method,
      resource = '',
    } = request.query;

    if (response_type !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }

    const client = await getClient(client_id);
    if (!client) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    // PKCE S256 Pflicht (claude.ai + ChatGPT senden immer code_challenge).
    if (!code_challenge) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'code_challenge required (PKCE S256)',
      });
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'only code_challenge_method=S256 supported',
      });
    }

    const effectiveRedirect = redirect_uri || client.redirect_uris[0] || '';
    if (!isRedirectAllowed(effectiveRedirect, client)) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri not allowed' });
    }

    // TOTP muss eingerichtet+bestaetigt sein, sonst kann niemand zustimmen.
    if (!(await isTotpConfirmed())) {
      return reply
        .status(503)
        .send({ error: 'temporarily_unavailable', error_description: 'TOTP not configured yet' });
    }

    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(
      renderConsentPage({
        clientName: client.client_name || client.client_id,
        client_id,
        redirect_uri: effectiveRedirect,
        scope,
        state,
        code_challenge,
        resource,
      }),
    );
  });

  /**
   * Authorization Consent — POST verifiziert den TOTP-Code (verify_2fa_session)
   * und stellt bei Erfolg den Auth-Code aus (PKCE-Challenge + redirect_uri werden
   * mitgespeichert), dann Redirect mit code (+state).
   */
  fastify.post<{
    Body: {
      totp_code?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      resource?: string;
    };
  }>('/authorize', async (request, reply) => {
    const {
      totp_code = '',
      client_id = '',
      redirect_uri = '',
      scope = DEFAULT_SCOPE,
      state = '',
      code_challenge = '',
      resource = '',
    } = request.body || {};

    const client = await getClient(client_id);
    if (!client) {
      return reply.status(400).send({ error: 'invalid_client' });
    }
    if (!code_challenge) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'code_challenge required' });
    }
    if (!isRedirectAllowed(redirect_uri, client)) {
      return reply.status(400).send({ error: 'invalid_request', error_description: 'redirect_uri not allowed' });
    }

    // TOTP-Gate.
    const ok = await verifyTotp(totp_code);
    if (!ok) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.status(401).send(
        renderConsentPage({
          clientName: client.client_name || client.client_id,
          client_id,
          redirect_uri,
          scope,
          state,
          code_challenge,
          resource,
          error: 'Code ungueltig oder abgelaufen. Bitte erneut versuchen.',
        }),
      );
    }

    // Auth-Code ausstellen (speichert code_challenge + redirect_uri).
    const issued = await issueAuthCode(client_id, redirect_uri, scope, code_challenge);

    request.log.info(`[OAuth] Auth-Code (TOTP-bestaetigt) fuer ${client_id}`);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', issued.token);
    if (state) redirectUrl.searchParams.set('state', state);
    // resource (RFC 8707) zuruecksenden falls vom Client mitgegeben.
    if (resource) redirectUrl.searchParams.set('resource', resource);

    return reply.redirect(redirectUrl.toString(), 302);
  });

  /**
   * Token Endpoint. Akzeptiert application/x-www-form-urlencoded (Plugin-Parser
   * oben) UND application/json. Grants: authorization_code, refresh_token.
   */
  fastify.post<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      client_secret?: string;
      code_verifier?: string;
      refresh_token?: string;
      resource?: string;
    };
  }>('/token', async (request, reply) => {
    const body = request.body || {};
    let client_id = body.client_id;
    let client_secret = body.client_secret;

    // Basic-Auth-Header parsen (client_secret_basic).
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
      const idx = credentials.indexOf(':');
      if (idx >= 0) {
        client_id = client_id || decodeURIComponent(credentials.slice(0, idx));
        client_secret = client_secret || decodeURIComponent(credentials.slice(idx + 1));
      }
    }

    const { grant_type, code, code_verifier, refresh_token, resource } = body;

    // -------------------- refresh_token grant --------------------
    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'refresh_token required' });
      }
      const rotated = await rotateRefresh(refresh_token);
      if (!rotated) {
        // RFC 6749: abgelaufen/ungueltig -> invalid_grant.
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'refresh token invalid or expired' });
      }
      const out: Record<string, unknown> = {
        access_token: rotated.access.token,
        token_type: 'Bearer',
        expires_in: expiresInSeconds(rotated.access.expiresAt),
        refresh_token: rotated.refresh.token,
        scope: rotated.access.scope ?? DEFAULT_SCOPE,
      };
      if (resource) out.resource = resource;
      return reply.send(out);
    }

    // -------------------- authorization_code grant --------------------
    if (grant_type === 'authorization_code') {
      if (!code) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'code required' });
      }

      // Client validieren (existiert; falls Secret mitgegeben -> muss passen).
      const client = client_id ? await getClient(client_id) : null;
      if (!client) {
        return reply.status(401).send({ error: 'invalid_client' });
      }
      if (client_secret && client.client_secret && client.client_secret !== client_secret) {
        return reply.status(401).send({ error: 'invalid_client' });
      }

      // Auth-Code laden (ohne Ablauf-Filter; wir pruefen selbst + single-use).
      const codeRow = await getTokenRow(code);
      if (
        !codeRow ||
        codeRow.kind !== 'authcode' ||
        codeRow.client_id !== client_id
      ) {
        return reply.status(400).send({ error: 'invalid_grant' });
      }
      // Single-use: Code sofort entwerten (egal ob folgende Checks passen).
      await revokeToken(code);

      if (codeRow.expires_at && codeRow.expires_at.getTime() < Date.now()) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired' });
      }

      // PKCE S256 ECHT pruefen.
      if (!codeRow.code_challenge) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'missing PKCE challenge' });
      }
      if (!code_verifier || !verifyPkceS256(code_verifier, codeRow.code_challenge)) {
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      const scope = codeRow.scope ?? DEFAULT_SCOPE;

      // Access (24h) + Refresh (120d absolut) ausstellen.
      const access = await issueAccessToken(client_id!, scope);
      const refresh = await issueRefreshToken(client_id!, scope);

      request.log.info(`[OAuth] Access+Refresh ausgestellt fuer ${client_id}`);

      const out: Record<string, unknown> = {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: expiresInSeconds(access.expiresAt),
        refresh_token: refresh.token,
        scope,
      };
      if (resource) out.resource = resource;
      return reply.send(out);
    }

    return reply.status(400).send({ error: 'unsupported_grant_type' });
  });
}
