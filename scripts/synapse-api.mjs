import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function loadApiConfig({ home = homedir(), env = process.env } = {}) {
  let config = {};
  try {
    const parsed = JSON.parse(await readFile(join(home, '.synapse/file-watcher/config.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch (error) {
    // Fehlende/ungueltige optionale Konfiguration faellt auf bekannte API-Adressen zurueck.
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      console.error('[synapse-api] Konfiguration nicht lesbar:', error.message);
    }
  }

  const rawToken = env.SYNAPSE_API_TOKEN || config.synapse_api_token;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const fallback = env.SYNAPSE_API_FALLBACK_URL || config.synapse_api_fallback_url || 'http://192.168.50.65:3456'; // Nur Rückfall, Quelle ist config.json.
  const bases = [...new Set([
    env.SYNAPSE_API_URL,
    config.synapse_api_url,
    'https://synapse.moosynapse.org', // Nur Rückfall, Quelle ist config.json.
    fallback,
  ].map(value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '').filter(Boolean))];
  return { token, bases };
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  return value.error ? errorMessage(value.error) : '';
}

function parseResult(result) {
  if (result?.isError) throw new Error(errorMessage(result) || 'MCP-Aufruf fehlgeschlagen');
  if (result?.structuredContent) return result.structuredContent;
  if (Array.isArray(result?.content)) {
    const text = result.content.find(item => item.type === 'text')?.text;
    if (text) {
      try { return JSON.parse(text); } catch { return { success: false, error: text }; }
    }
  }
  return result;
}

export async function callMcpTool(config, name, args, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const attempts = [];
  for (const base of config.bases) {
    let response;
    try {
      response = await fetchImpl(`${base}/mcp/messages`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      attempts.push(`${base}: nicht erreichbar (${error.name})`);
      continue;
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      if (response.status >= 500) {
        attempts.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      throw new Error(`${base}: API-Antwort ist kein JSON (HTTP ${response.status})`);
    }
    if (response.status >= 500) {
      attempts.push(`${base}: HTTP ${response.status}`);
      continue;
    }
    if (!response.ok) {
      const detail = errorMessage(envelope.error);
      throw new Error(`${base}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    if (envelope.error) throw new Error(errorMessage(envelope.error) || 'MCP-API-Fehler');

    const result = parseResult(envelope.result);
    if (result?.success === false) throw new Error(errorMessage(result) || `${name} wurde von der MCP-API abgelehnt`);
    return result;
  }
  throw new Error(`Synapse-API nicht erreichbar: ${attempts.join('; ')}`);
}
