#!/usr/bin/env node
// chat-send.mjs — Sendet eine Nachricht in den Synapse-Agenten-Chat ueber die MCP-API
// Args: <project> <sender> <content> [recipient]

import { callMcpTool, loadApiConfig } from './synapse-api.mjs';

const [,, project, sender, content, recipient] = process.argv;
if (!project || !sender || !content) {
  console.error('Nutzung: chat-send.mjs <project> <sender> <content> [recipient]');
  process.exit(2);
}

try {
  const config = await loadApiConfig();
  const result = await callMcpTool(config, 'chat', {
    action: 'send',
    project,
    sender_id: sender,
    content,
    ...(recipient ? { recipient_id: recipient } : {}),
  });
  const messageId = result?.message_id ?? result?.messageId ?? result?.id;
  if (!messageId) throw new Error('chat(send) wurde von der MCP-API abgelehnt');
  console.log(`Nachricht #${messageId} gesendet (${sender} → ${recipient || 'alle'})`);
} catch (error) {
  console.error(`Fehler: ${error.message}`);
  process.exitCode = 1;
}
