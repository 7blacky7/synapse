/**
 * Synapse API - Web-UI-Auth-Routen (AUTH-5, PLAN-002)
 *
 * Endpunkte fuer den eigenen Web-UI-Login-Flow (kein OAuth — das ist routes/oauth.ts
 * fuer claude.ai/ChatGPT). Alle Routen liegen unter /api/auth/* und sind im
 * globalen Auth-Hook (middleware/auth-hook.ts) ALLOWLISTED, d.h. ohne Bearer-Token
 * erreichbar (Bootstrap: Weg zum ersten Token muss offen sein).
 *
 * ENDPUNKTE:
 *   GET    /api/auth/status            -> { totpConfigured, authenticated }
 *   POST   /api/auth/totp/setup        -> { otpauthUri, qrDataUrl }  (nur unconfirmed ODER localhost)
 *   POST   /api/auth/totp/confirm      { code } -> 200/400
 *   POST   /api/auth/verify            { code } = verify_2fa_session -> { token, expiresAt } + Set-Cookie
 *   POST   /api/auth/logout            -> revoke aktuellen Token + Cookie loeschen
 *   GET    /api/auth/sessions          -> listTokens() (nur Metadaten, KEIN token_hash-Klartext-Abgleich)
 *   DELETE /api/auth/sessions/:id      -> revoke per opaquer id (= token_hash)
 *
 * SESSION-COOKIE (fuer SSE, siehe AUTH-4):
 *   verify_2fa_session setzt den Session-Token ZUSAETZLICH als httpOnly-Cookie
 *   'synapse_session' (SameSite=Lax, Path=/, Max-Age=86400, Secure wenn https),
 *   damit der Browser-EventSource (Dashboard) den SSE-Stream same-origin ohne
 *   ?sse_token erreicht. logout loescht das Cookie (Max-Age=0).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '@synapse/core';
import {
  isTotpConfirmed,
  buildOtpauthUri,
  generateQrDataUrl,
  confirmTotp,
  verifyTotp,
  issueSessionToken,
  validateToken,
  revokeToken,
  listTokens,
  getTokenRow,
  SESSION_TTL_MS,
  type AuthTokenRow,
} from '../services/auth.js';

const SESSION_COOKIE = 'synapse_session';

/** Liest den Bearer-Token aus dem Authorization-Header (oder null). */
function extractBearer(request: FastifyRequest): string | null {
  const auth = request.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

/** Simpler Cookie-Parser (identisch zur Logik im Auth-Hook). */
function getCookie(request: FastifyRequest, key: string): string | null {
  const raw = request.headers['cookie'];
  if (!raw || typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === key) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Aktueller Token aus Bearer-Header ODER Session-Cookie (Bearer hat Vorrang). */
function currentToken(request: FastifyRequest): string | null {
  return extractBearer(request) || getCookie(request, SESSION_COOKIE);
}

/** Laeuft der Request ueber eine sichere (https) Verbindung? -> Secure-Cookie-Flag. */
function isSecureRequest(request: FastifyRequest): boolean {
  const fwd = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(fwd) ? fwd[0] : fwd;
  if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';
  return request.protocol === 'https';
}

/**
 * Kommt der Request von localhost? Bootstrap-Ausnahme fuer /totp/setup,
 * damit der erste TOTP-QR auch dann noch gezogen werden kann, wenn bereits
 * confirmed ist (z.B. Recovery am Host). request.ip beruecksichtigt die von
 * Fastify ermittelte Remote-Adresse.
 */
function isLocalhost(request: FastifyRequest): boolean {
  const ip = request.ip;
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

/** Setzt das httpOnly-Session-Cookie (Max-Age in Sekunden). */
function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string, maxAgeSec: number): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(request)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

/** Loescht das Session-Cookie (Max-Age=0). */
function clearSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (isSecureRequest(request)) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

/** Eine auth_tokens-Zeile auf ein nach aussen sicheres Metadaten-Objekt mappen. */
function toSessionMeta(row: AuthTokenRow): Record<string, unknown> {
  return {
    // Opaque, stabile id fuer DELETE /sessions/:id — der token_hash ist der
    // Primaerschluessel in auth_tokens und gibt KEIN Klartext-Token preis.
    id: row.token_hash,
    kind: row.kind,
    label: row.label,
    clientId: row.client_id,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/auth/status
   * Liefert ob TOTP konfiguriert (confirmed) ist und ob der aktuelle Request
   * (Bearer ODER Session-Cookie) ein gueltiges Token traegt.
   */
  fastify.get('/api/auth/status', async (request, reply) => {
    const totpConfigured = await isTotpConfirmed();

    let authenticated = false;
    const token = currentToken(request);
    if (token) {
      const row = await validateToken(token);
      // Fuer die Web-UI gelten access/session/service als "eingeloggt".
      authenticated =
        !!row && (row.kind === 'access' || row.kind === 'session' || row.kind === 'service');
    }

    return reply.send({ success: true, totpConfigured, authenticated });
  });

  /**
   * POST /api/auth/totp/setup
   * Liefert otpauth-URI + QR-Data-URL fuer die Authenticator-App.
   * ERLAUBT nur wenn TOTP noch NICHT confirmed ist ODER der Request von
   * localhost kommt (Bootstrap/Recovery am Host). Sonst 403 — sonst koennte
   * jeder ohne Token das Secret abgreifen.
   */
  fastify.post('/api/auth/totp/setup', async (request, reply) => {
    const confirmed = await isTotpConfirmed();
    if (confirmed && !isLocalhost(request)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'forbidden', message: 'TOTP ist bereits eingerichtet.' },
      });
    }

    const otpauthUri = await buildOtpauthUri('Synapse', 'Synapse');
    const qrDataUrl = await generateQrDataUrl(otpauthUri);
    return reply.send({ success: true, otpauthUri, qrDataUrl });
  });

  /**
   * POST /api/auth/totp/confirm { code }
   * Bestaetigt das TOTP-Setup mit dem ersten gueltigen Code (setzt confirmed_at).
   */
  fastify.post<{ Body: { code?: string } }>('/api/auth/totp/confirm', async (request, reply) => {
    const code = (request.body?.code ?? '').toString().trim();
    if (!code) {
      return reply.code(400).send({
        success: false,
        error: { code: 'invalid_request', message: 'code fehlt' },
      });
    }
    const ok = await confirmTotp(code);
    if (!ok) {
      return reply.code(400).send({
        success: false,
        error: { code: 'invalid_code', message: 'TOTP-Code ungueltig' },
      });
    }
    return reply.send({ success: true, confirmed: true });
  });

  /**
   * POST /api/auth/verify { code }   (= verify_2fa_session)
   * Verifiziert den TOTP-Code und stellt bei Erfolg ein 24h-Session-Token aus.
   * Rueckgabe: { token, expiresAt }. ZUSAETZLICH wird der Token als httpOnly-
   * Cookie 'synapse_session' gesetzt, damit der Browser-EventSource den SSE-
   * Stream same-origin (ohne ?sse_token) erreicht (siehe AUTH-4).
   */
  fastify.post<{ Body: { code?: string } }>('/api/auth/verify', async (request, reply) => {
    const code = (request.body?.code ?? '').toString().trim();
    if (!code) {
      return reply.code(400).send({
        success: false,
        error: { code: 'invalid_request', message: 'code fehlt' },
      });
    }

    const valid = await verifyTotp(code);
    if (!valid) {
      return reply.code(401).send({
        success: false,
        error: { code: 'invalid_code', message: 'TOTP-Code ungueltig' },
      });
    }

    const issued = await issueSessionToken(null, SESSION_TTL_MS);
    setSessionCookie(reply, request, issued.token, Math.floor(SESSION_TTL_MS / 1000));

    return reply.send({
      success: true,
      token: issued.token,
      expiresAt: issued.expiresAt,
    });
  });

  /**
   * POST /api/auth/logout
   * Revoked das aktuelle Token (aus Bearer ODER Session-Cookie) und loescht
   * das Session-Cookie. Idempotent — auch ohne gueltiges Token 200.
   */
  fastify.post('/api/auth/logout', async (request, reply) => {
    const token = currentToken(request);
    if (token) {
      await revokeToken(token);
    }
    clearSessionCookie(reply, request);
    return reply.send({ success: true });
  });

  /**
   * GET /api/auth/sessions
   * Listet aktive Tokens als Metadaten (KEIN Klartext-Token, token_hash nur als
   * opaque id). Fuer die Session-/Geraete-Verwaltung im Web-UI.
   */
  fastify.get('/api/auth/sessions', async (_request, reply) => {
    const rows = await listTokens();
    return reply.send({
      success: true,
      sessions: rows.map(toSessionMeta),
    });
  });

  /**
   * DELETE /api/auth/sessions/:id
   * Revoked ein Token per opaquer id (= token_hash). Da revokeToken() das
   * Klartext-Token braucht (das hier nicht vorliegt), wird direkt per token_hash
   * in auth_tokens geloescht. Falls die widerrufene Session die aktuelle ist,
   * wird zusaetzlich das Cookie geloescht.
   */
  fastify.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (request, reply) => {
    const id = (request.params?.id ?? '').trim();
    if (!id) {
      return reply.code(400).send({
        success: false,
        error: { code: 'invalid_request', message: 'id fehlt' },
      });
    }

    const pool = getPool();
    const result = await pool.query('DELETE FROM auth_tokens WHERE token_hash = $1', [id]);
    const removed = result.rowCount ?? 0;

    if (removed === 0) {
      return reply.code(404).send({
        success: false,
        error: { code: 'not_found', message: 'Session nicht gefunden' },
      });
    }

    // Wenn die aktuelle Session widerrufen wurde -> Cookie loeschen.
    const token = currentToken(request);
    if (token) {
      const row = await getTokenRow(token);
      if (!row) clearSessionCookie(reply, request);
    }

    return reply.send({ success: true, revoked: removed });
  });
}
