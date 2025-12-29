/**
 * Synapse API - OAuth 2.0 Server
 * Für Claude.ai MCP Connectors
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID, randomBytes } from 'crypto';

// Einfacher In-Memory Store für Clients und Tokens
const registeredClients = new Map<string, {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
}>();

const accessTokens = new Map<string, {
  client_id: string;
  scope: string;
  expires_at: number;
}>();

const authCodes = new Map<string, {
  client_id: string;
  redirect_uri: string;
  scope: string;
  expires_at: number;
}>();

/**
 * Generiert einen sicheren Random String
 */
function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Ermittelt das richtige Protokoll (HTTPS hinter Reverse Proxy)
 */
function getBaseUrl(request: FastifyRequest): string {
  // X-Forwarded-Proto Header prüfen
  const forwardedProto = request.headers['x-forwarded-proto'];
  if (forwardedProto) {
    const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    return `${protocol}://${request.hostname}`;
  }

  // Fallback: HTTPS erzwingen für öffentliche Domains
  const hostname = request.hostname;
  if (hostname.includes('.') && !hostname.startsWith('localhost') && !hostname.startsWith('127.') && !hostname.startsWith('192.168.') && !hostname.startsWith('172.') && !hostname.startsWith('10.')) {
    return `https://${hostname}`;
  }

  return `${request.protocol}://${hostname}`;
}

export async function oauthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * OAuth Authorization Server Metadata
   * RFC 8414
   */
  fastify.get('/.well-known/oauth-authorization-server', async (request) => {
    const baseUrl = getBaseUrl(request);

    return {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: ['mcp:tools', 'mcp:read', 'mcp:write'],
      code_challenge_methods_supported: ['S256', 'plain'],
    };
  });

  /**
   * OAuth Protected Resource Metadata
   * RFC 9728
   */
  fastify.get('/.well-known/oauth-protected-resource', async (request) => {
    const baseUrl = getBaseUrl(request);

    return {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      scopes_supported: ['mcp:tools', 'mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    };
  });

  /**
   * Dynamic Client Registration
   * RFC 7591
   */
  fastify.post<{
    Body: {
      redirect_uris?: string[];
      client_name?: string;
      grant_types?: string[];
      response_types?: string[];
    };
  }>('/register', async (request, reply) => {
    const { redirect_uris = [], client_name, grant_types, response_types } = request.body || {};

    const client_id = `synapse_${randomUUID().replace(/-/g, '')}`;
    const client_secret = generateSecret();

    const client = {
      client_id,
      client_secret,
      redirect_uris,
      client_name,
      created_at: Date.now(),
    };

    registeredClients.set(client_id, client);

    console.log(`[OAuth] Client registriert: ${client_id}`);

    return reply.status(201).send({
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0, // Niemals ablaufen
      redirect_uris,
      client_name,
      grant_types: grant_types || ['authorization_code', 'client_credentials'],
      response_types: response_types || ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
  });

  /**
   * Authorization Endpoint
   * Für Authorization Code Flow
   */
  fastify.get<{
    Querystring: {
      response_type: string;
      client_id: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
    };
  }>('/authorize', async (request, reply) => {
    const { response_type, client_id, redirect_uri, scope = 'mcp:tools', state, code_challenge } = request.query;

    // Validierung
    if (response_type !== 'code') {
      return reply.status(400).send({ error: 'unsupported_response_type' });
    }

    const client = registeredClients.get(client_id);
    if (!client) {
      return reply.status(400).send({ error: 'invalid_client' });
    }

    // Für MCP Connectors: Auto-Authorize (kein User-Consent nötig)
    const code = generateSecret(16);

    authCodes.set(code, {
      client_id,
      redirect_uri: redirect_uri || client.redirect_uris[0] || '',
      scope,
      expires_at: Date.now() + 600000, // 10 Minuten
    });

    console.log(`[OAuth] Auth Code erstellt für: ${client_id}`);

    // Redirect mit Code
    const redirectUrl = new URL(redirect_uri || client.redirect_uris[0]);
    redirectUrl.searchParams.set('code', code);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    return reply.redirect(302, redirectUrl.toString());
  });

  /**
   * Token Endpoint
   */
  fastify.post<{
    Body: {
      grant_type: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      client_secret?: string;
      code_verifier?: string;
    };
  }>('/token', async (request, reply) => {
    let client_id = request.body?.client_id;
    let client_secret = request.body?.client_secret;

    // Basic Auth Header parsen
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
      const [id, secret] = credentials.split(':');
      client_id = client_id || id;
      client_secret = client_secret || secret;
    }

    const { grant_type, code, redirect_uri, code_verifier } = request.body || {};

    // Client validieren
    const client = client_id ? registeredClients.get(client_id) : null;
    if (!client || (client_secret && client.client_secret !== client_secret)) {
      return reply.status(401).send({ error: 'invalid_client' });
    }

    let scope = 'mcp:tools';

    if (grant_type === 'authorization_code') {
      // Auth Code Flow
      if (!code) {
        return reply.status(400).send({ error: 'invalid_request', error_description: 'code required' });
      }

      const authCode = authCodes.get(code);
      if (!authCode || authCode.client_id !== client_id) {
        return reply.status(400).send({ error: 'invalid_grant' });
      }

      if (authCode.expires_at < Date.now()) {
        authCodes.delete(code);
        return reply.status(400).send({ error: 'invalid_grant', error_description: 'code expired' });
      }

      scope = authCode.scope;
      authCodes.delete(code);

    } else if (grant_type === 'client_credentials') {
      // Client Credentials Flow - direkt Token ausstellen
      scope = 'mcp:tools';

    } else {
      return reply.status(400).send({ error: 'unsupported_grant_type' });
    }

    // Access Token erstellen
    const access_token = generateSecret();
    const expires_in = 86400; // 24 Stunden

    accessTokens.set(access_token, {
      client_id: client_id!,
      scope,
      expires_at: Date.now() + (expires_in * 1000),
    });

    console.log(`[OAuth] Access Token erstellt für: ${client_id}`);

    return {
      access_token,
      token_type: 'Bearer',
      expires_in,
      scope,
    };
  });

  /**
   * Token Validation Middleware Helper
   */
  fastify.decorate('validateToken', (request: FastifyRequest): boolean => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.slice(7);
    const tokenData = accessTokens.get(token);

    if (!tokenData) {
      return false;
    }

    if (tokenData.expires_at < Date.now()) {
      accessTokens.delete(token);
      return false;
    }

    return true;
  });
}

/**
 * Token Validation für andere Routes
 */
export function validateBearerToken(request: FastifyRequest): boolean {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    // Kein Token = auch OK (für lokale Nutzung ohne Auth)
    return true;
  }

  const token = authHeader.slice(7);
  const tokenData = accessTokens.get(token);

  if (!tokenData) {
    return false;
  }

  if (tokenData.expires_at < Date.now()) {
    accessTokens.delete(token);
    return false;
  }

  return true;
}
