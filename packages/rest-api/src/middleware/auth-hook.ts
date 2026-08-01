/**
 * Synapse API - Globaler Auth-Hook (AUTH-4, PLAN-002)
 *
 * Ein einziger Fastify onRequest-Hook gated /api/* UND /mcp/* gegen einen
 * gueltigen Bearer-Access-Token (validateToken aus services/auth.ts, prueft PG).
 *
 * WICHTIG (Selbst-Aussperr-Schutz):
 *  - SYNAPSE_AUTH_DISABLED=1 -> Hook komplett aus (Generalschluessel/Bootstrap).
 *  - Allowlist laesst Bootstrap-Wege offen: OAuth-Flow (/.well-known, /authorize,
 *    /token, /register), Web-UI-Auth (/api/auth/*), /health, /api-Info, statische
 *    Web-UI-Assets + SPA-Fallback. So bleibt der Weg zum ERSTEN Token immer offen.
 *
 * SSE-Sonderbehandlung:
 *  - GET /api/projects/:name/events ist ein EventSource-Stream. Browser-EventSource
 *    KANN KEINEN Authorization-Header setzen. Diese Route wird daher NICHT ueber den
 *    Bearer-Zwang gegated, sondern via kurzlebigem ?sse_token=<token> ODER
 *    httpOnly-Session-Cookie (synapse_session) authentifiziert. Ungueltig -> 401.
 *
 * MCP-Spec: 401 auf /mcp/* MUSS den Header
 *   WWW-Authenticate: Bearer resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"
 * setzen, sonst findet claude.ai den AuthServer nicht.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateToken } from '../services/auth.js';

/**
 * Ermittelt die externe Basis-URL (HTTPS hinter Reverse-Proxy beachten) —
 * identisch zur Logik in routes/oauth.ts / routes/mcp.ts, damit resource_metadata
 * exakt zur Discovery-URL passt.
 */
function getBaseUrl(request: FastifyRequest): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (forwardedProto) {
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${protocol}://${request.hostname}`;
  }
  // Fallback: HTTPS annehmen wenn ein bekannter externer Host, sonst request-Protokoll.
  const proto = request.protocol || 'https';
  return `${proto}://${request.hostname}`;
}

/** Liest den Bearer-Token aus dem Authorization-Header (oder null). */
function extractBearer(request: FastifyRequest): string | null {
  const auth = request.headers['authorization'];
  if (!auth || typeof auth !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

/** Sehr simpler Cookie-Parser (nur fuer synapse_session noetig). */
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

/**
 * Pfad ist Teil der Allowlist (KEIN Auth noetig)?
 * Bekommt den reinen Pfad (ohne Query-String).
 */
function isAllowlisted(method: string, pathname: string): boolean {
  // Health-Check
  if (pathname === '/health') return true;

  // API-Info (exakt /api) — die Unterrouten /api/* sind gegated.
  if (pathname === '/api') return true;

  // Web-UI-Auth-Endpunkte (AUTH-5) — MUESSEN offen sein (Weg zum ersten Token).
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) return true;

  // GPU-3 Bootstrap: Modellvertrag und offizielle Downloadlinks sind oeffentliche
  // Metadaten. Der Tray muss sie vor dem ersten lokalen GPU-/Token-Setup anzeigen.
  if (method === 'GET' && pathname === '/api/embedding-nodes/reference') return true;

  // OAuth-Flow (AUTH-3) — Discovery + Authorize + Token + Dynamic Client Registration.
  if (pathname.startsWith('/.well-known/')) return true;
  if (pathname === '/authorize' || pathname.startsWith('/authorize')) return true;
  if (pathname === '/token') return true;
  if (pathname === '/register') return true;

  // Statische Web-UI-Assets + SPA-Fallback:
  // jede GET-Route die NICHT /api, /mcp oder /.well-known ist -> Web-UI.
  if (
    method === 'GET' &&
    !pathname.startsWith('/api') &&
    !pathname.startsWith('/mcp') &&
    !pathname.startsWith('/.well-known')
  ) {
    return true;
  }

  return false;
}

/** Ist das die SSE-EventSource-Route (Cookie/Query statt Bearer)? */
function isSseRoute(method: string, pathname: string): boolean {
  // GET /api/projects/:name/events  (der einzige echte SSE-Stream mit PG LISTEN)
  return method === 'GET' && /^\/api\/projects\/[^/]+\/events\/?$/.test(pathname);
}

/** Pfad faellt unter den Bearer-Zwang (/api/* , /mcp/* oder MCP-Root POST /)? */
function requiresBearer(method: string, pathname: string): boolean {
  if (pathname.startsWith('/api') || pathname.startsWith('/mcp')) return true;
  // MCP "Streamable HTTP"-Transport laeuft auf POST / (Root). GET / (Web-UI) und
  // OPTIONS / (CORS-Preflight) bleiben offen; alle Mutationen auf / werden gegated.
  if (pathname === '/' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return true;
  return false;
}

function send401(
  reply: FastifyReply,
  request: FastifyRequest,
  pathname: string,
  message: string,
): FastifyReply {
  // MCP-Spec-PFLICHT: /mcp/* braucht WWW-Authenticate mit resource_metadata,
  // sonst findet claude.ai den AuthServer nicht.
  if (pathname.startsWith('/mcp') || pathname === '/') {
    const baseUrl = getBaseUrl(request);
    reply.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
    );
  } else {
    reply.header('WWW-Authenticate', 'Bearer');
  }
  return reply.code(401).send({
    success: false,
    error: { code: 'unauthorized', message },
  });
}

/**
 * Registriert den globalen Bearer-Auth-Hook. MUSS frueh in createServer
 * registriert werden (vor den Routen-Handlern wirkt onRequest ohnehin global).
 */
export function registerAuthHook(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request, reply) => {
    // ENV-Notausgang / Bootstrap-Generalschluessel.
    if (process.env.SYNAPSE_AUTH_DISABLED === '1') return;

    const method = request.method.toUpperCase();
    // request.url enthaelt evtl. Query-String -> Pfad isolieren.
    const pathname = request.url.split('?')[0];

    // 1) Allowlist (kein Auth) -> durchlassen.
    if (isAllowlisted(method, pathname)) return;

    // 2) SSE-Sonderbehandlung: EventSource kann keinen Bearer setzen.
    //    -> ?sse_token= ODER httpOnly-Cookie synapse_session. Validiert via PG.
    if (isSseRoute(method, pathname)) {
      const q = request.query as Record<string, unknown> | undefined;
      const sseToken =
        (q && typeof q.sse_token === 'string' ? q.sse_token : null) ||
        getCookie(request, 'synapse_session');
      if (!sseToken) {
        return send401(reply, request, pathname, 'SSE: sse_token oder Session-Cookie erforderlich');
      }
      const row = await validateToken(sseToken);
      if (!row || (row.kind !== 'access' && row.kind !== 'session' && row.kind !== 'service')) {
        return send401(reply, request, pathname, 'SSE: ungueltiges/abgelaufenes Token');
      }
      return; // SSE authentifiziert -> Handler laeuft (setzt selbst SSE-Header).
    }

    // 3) Bearer-Zwang nur fuer /api/* + /mcp/*. Alles andere ist via Allowlist
    //    schon raus; defensiv hier durchlassen wenn es kein gated-Prefix ist.
    if (!requiresBearer(method, pathname)) return;

    const token = extractBearer(request);
    if (!token) {
      return send401(reply, request, pathname, 'Bearer-Token fehlt');
    }
    const row = await validateToken(token);
    if (!row) {
      return send401(reply, request, pathname, 'Token ungueltig oder abgelaufen');
    }
    // Nur echte Zugriffstoken duerfen API/MCP nutzen — NICHT authcode/refresh.
    // /mcp/* (claude.ai/ChatGPT-Connector): strikt nur access|service.
    // /api/*  (auch Web-UI): zusaetzlich 'session' (Token aus verify_2fa_session,
    //         AUTH-5), damit das Web-UI-Dashboard nach Login /api/*-Daten laden kann
    //         (Review 865580af). authcode/refresh bleiben ueberall ausgeschlossen.
    const isApi = pathname.startsWith('/api');
    const allowedKinds = isApi
      ? row.kind === 'access' || row.kind === 'service' || row.kind === 'session'
      : row.kind === 'access' || row.kind === 'service';
    if (!allowedKinds) {
      return send401(reply, request, pathname, 'Token-Typ nicht fuer API/MCP zugelassen');
    }
    // Gueltig -> next (request.authToken anhaengen waere optional; nicht noetig).
  });
}
