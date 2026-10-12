#!/usr/bin/env node
// chat-send.mjs — Sendet eine Nachricht in den Synapse-Agenten-Chat ueber die MCP-API
// Args: <project> <sender> <content> [recipient]

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [,, project, sender, content, recipient] = process.argv;
if (!project || !sender || !content) {
  console.error('Nutzung: chat-send.mjs <project> <sender> <content> [recipient]');
  process.exit(2);
}

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), '.synapse/file-watcher/config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function apiBases(config) {
  const fallback = process.env.SYNAPSE_API_FALLBACK_URL || 'http://192.168.50.65:3456';
  return [...new Set([
    config.synapse_api_url,
    'https://synapse.moosynapse.org',
    fallback,
  ].map(value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '').filter(Boolean))];
}

function errorMessage(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  return value.error ? errorMessage(value.error) : '';
}

async function callApi(config, token) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'chat',
      arguments: {
        action: 'send',
        project,
        sender_id: sender,
        content,
        ...(recipient ? { recipient_id: recipient } : {}),
      },
    },
  };
  const attempts = [];
  for (const base of apiBases(config)) {
    let response;
    try {
      response = await fetch(`${base}/mcp/messages`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
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
    if (envelope.error) {
      throw new Error(errorMessage(envelope.error) || 'MCP-API-Fehler');
    }

    const result = envelope.result;
    let data = result?.structuredContent;
    if (!data && Array.isArray(result?.content)) {
      const text = result.content.find(item => item.type === 'text')?.text;
      if (text) {
        try { data = JSON.parse(text); } catch { data = { success: false, error: text }; }
      }
    }
    const messageId = data?.message_id ?? data?.messageId ?? data?.id;
    if (!result || result.isError || data?.success === false || !messageId) {
      throw new Error(errorMessage(data) || 'chat(send) wurde von der MCP-API abgelehnt');
    }

    console.log(`Nachricht #${messageId} gesendet (${sender} → ${recipient || 'alle'})`);
    return;
  }
  throw new Error(`Synapse-API nicht erreichbar: ${attempts.join('; ')}`);
}

try {
  const config = await readConfig();
  const rawToken = process.env.SYNAPSE_API_TOKEN || config.synapse_api_token;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  await callApi(config, token);
} catch (error) {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
}
