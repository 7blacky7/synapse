#!/usr/bin/env node
// Codex-PostToolUse-Hook: Handoff-Hinweis ab einer einmaligen Kontextschwelle.
// CODEX_CONTEXT_THRESHOLD_PERCENT ändert die Schwelle (Standard: 80).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function readInput() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}

function tokenCountFromLine(line) {
  try {
    const row = JSON.parse(line);
    const event = row.type === 'event_msg' ? row.payload : row;
    if (event?.type !== 'token_count' || !event.info) return null;
    const tokens = event.info.last_token_usage?.input_tokens;
    const window = event.info.model_context_window;
    if (Number.isFinite(tokens) && Number.isFinite(window) && tokens >= 0 && window > 0) {
      return { tokens, window };
    }
  } catch {
    // Unvollständige JSONL-Zeilen während eines Schreibvorgangs überspringen.
  }
  return null;
}

async function readLastTokenCount(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;

  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const fileSize = fstatSync(fd).size;
    let windowSize = Math.min(256 * 1024, fileSize);

    while (windowSize > 0) {
      const start = fileSize - windowSize;
      const buffer = Buffer.allocUnsafe(windowSize);
      let bytesRead = 0;
      while (bytesRead < windowSize) {
        const count = readSync(fd, buffer, bytesRead, windowSize - bytesRead, start + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }

      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
      // Die erste Zeile kann am Fensteranfang abgeschnitten sein.
      if (start > 0) lines.shift();
      for (let index = lines.length - 1; index >= 0; index--) {
        const usage = tokenCountFromLine(lines[index]);
        if (usage) return usage;
      }

      if (start === 0) break;
      windowSize = Math.min(fileSize, windowSize * 2);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  return null;
}

function getParentPid(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const parent = Number(fields[1]); // fields[0] ist Status, fields[1] die Eltern-PID.
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

function findWrapperPid() {
  let output;
  try {
    output = execFileSync('cc-send', ['--list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }

  const listed = new Set([...output.matchAll(/\bPID\s+(\d+)\b/g)].map((match) => Number(match[1])));
  let pid = process.pid;
  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < 64; depth++) {
    if (listed.has(pid)) return pid;
    pid = getParentPid(pid);
  }
  return null;
}

function claimOnce(sessionId, thresholdPercent) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const stateDir = join(codexHome, 'codex-kontext-hook-state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sessionHash = createHash('sha256').update(sessionId).digest('hex');
  const file = join(stateDir, sessionHash + '-' + thresholdPercent + '.json');
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ session_id: sessionId, threshold_percent: thresholdPercent, emitted_at: new Date().toISOString() }));
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function buildContext(wrapperPid, tokens, window, thresholdPercent) {
  const thresholdLabel = thresholdPercent + '% (' + tokens.toLocaleString('en-US') + '/' + window.toLocaleString('en-US') + ' tokens)';
  const handoff = [
    'Kontext-Handoff-Schwelle erreicht: ' + thresholdLabel + '.',
    'Schließe den gerade laufenden Schritt ab und committe die eigenen Änderungen.',
    'Schreibe danach ein Synapse-Thought im aktuellen Projekt mit source = deiner Agent-ID, task_id = der aktuellen Task und tags = [session-uebergabe].',
    'Der Thought-Inhalt muss die Abschnitte ERLEDIGT, OFFEN, NEXT, DATEIEN und PLAN-IDs enthalten.',
  ];

  if (wrapperPid === null) {
    handoff.push('Keine cc-wrap-PID in deiner Prozess-Elternkette gefunden: Schreibe nur das Handoff-Thought und melde dich danach beim Koordinator. Sende kein /clear.');
  } else {
    handoff.push('Sende danach diese beiden Zeilen an deine eigene cc-wrap-Sitzung:');
    handoff.push("CC_SEND_VON=<eigene Agent-ID> cc-send " + wrapperPid + " '/clear'");
    handoff.push("CC_SEND_VON=<eigene Agent-ID> cc-send " + wrapperPid + " 'Du bist <eigene Agent-ID>. thought get <8 Zeichen> lesen, dann löschen, als <eigene Agent-ID> weiterarbeiten: project status per Pfad, admin index_stats sitzung fortsetzung onboarding true.'");
    handoff.push('Beende diese Runde unmittelbar nach dem zweiten cc-send.');
  }

  return handoff.join('\n');
}

async function main() {
  const input = await readInput();
  if (input.hook_event_name !== 'PostToolUse' || typeof input.session_id !== 'string' || !input.session_id) return;

  let thresholdPercent = 80;
  if (process.env.CODEX_CONTEXT_THRESHOLD_PERCENT !== undefined) {
    thresholdPercent = Number(process.env.CODEX_CONTEXT_THRESHOLD_PERCENT);
    if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) return;
  }

  const usage = await readLastTokenCount(input.transcript_path);
  if (!usage || usage.tokens * 100 < usage.window * thresholdPercent) return;
  if (!claimOnce(input.session_id, thresholdPercent)) return;

  const context = buildContext(findWrapperPid(), usage.tokens, usage.window, thresholdPercent);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }) + '\n');
}

main().catch((error) => {
  // Fehler beim Lesen oder Parsen dürfen den Agenten nicht anhalten.
  process.stderr.write('codex-kontext-hook: ' + (error instanceof Error ? error.message : String(error)) + '\n');
});
