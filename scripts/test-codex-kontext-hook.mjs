#!/usr/bin/env node
// P7-T48: contract test for the Codex PostToolUse context hook.
// Run with: node scripts/test-codex-kontext-hook.mjs

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'codex-kontext-hook.mjs');
const root = mkdtempSync(join(tmpdir(), 'p7-t48-hook-test-'));
const home = join(root, 'codex-home');
const bin = join(root, 'bin');
const transcript = join(root, 'transcript.jsonl');
const fakeCcSend = join(bin, 'cc-send');
const fixture = (tokens) => JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { last_token_usage: { input_tokens: tokens }, model_context_window: 100 },
  },
});

mkdirSync(bin, { recursive: true });
writeFileSync(fakeCcSend, '#!/bin/sh\nif [ "$1" = "--list" ]; then printf "  PID %s disposable-wrapper\\n" "$P7_TEST_MATCH_PID"; fi\n');
chmodSync(fakeCcSend, 0o755);

function runHook({ session = 'probe-session', threshold, listedPid = process.pid } = {}) {
  const env = {
    ...process.env,
    CODEX_HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    P7_TEST_MATCH_PID: String(listedPid),
    CC_WRAP_PID: '999999', // deliberately stale: the hook must use the process ancestry
  };
  if (threshold !== undefined) env.CODEX_CONTEXT_THRESHOLD_PERCENT = String(threshold);
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env,
    input: JSON.stringify({
      session_id: session,
      transcript_path: transcript,
      cwd: root,
      hook_event_name: 'PostToolUse',
      model: 'test-model',
      permission_mode: 'default',
      tool_name: 'shell',
      tool_input: {},
      tool_use_id: 'tool-1',
      turn_id: 'turn-1',
    }),
  });
}

function setTokens(...values) {
  writeFileSync(transcript, values.map(fixture).join('\n') + '\n');
}

try {
  setTokens(95, 79);
  const below = runHook();
  assert.equal(below.status, 0, below.stderr);
  assert.equal(below.stdout, '', 'under 80% must produce no hook output');

  setTokens(79, 80);
  const crossed = runHook();
  assert.equal(crossed.status, 0, crossed.stderr);
  const result = JSON.parse(crossed.stdout);
  assert.deepEqual(Object.keys(result), ['hookSpecificOutput']);
  assert.equal(result.hookSpecificOutput.hookEventName, 'PostToolUse');
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /Schließe den gerade laufenden Schritt ab und committe/i);
  assert.match(context, /source/i);
  assert.match(context, /task_id/i);
  assert.match(context, /session-uebergabe/i);
  assert.match(context, /ERLEDIGT[\s\S]*OFFEN[\s\S]*NEXT[\s\S]*Dateien[\s\S]*Plan-IDs/i);
  assert.match(context, new RegExp(`CC_SEND_VON=.*cc-send ${process.pid} '\\/clear'`));
  assert.match(context, /thought get <8 Zeichen>/);
  assert.match(context, /index_stats sitzung fortsetzung onboarding true/);

  const duplicate = runHook();
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(duplicate.stdout, '', 'same session and threshold must emit only once');

  setTokens(50);
  const secondThreshold = runHook({ threshold: 50 });
  assert.equal(secondThreshold.status, 0, secondThreshold.stderr);
  assert.match(JSON.parse(secondThreshold.stdout).hookSpecificOutput.additionalContext, /cc-send/);

  setTokens(80);
  const noWrapper = runHook({ session: 'no-wrapper-session', listedPid: 999999 });
  assert.equal(noWrapper.status, 0, noWrapper.stderr);
  const fallback = JSON.parse(noWrapper.stdout).hookSpecificOutput.additionalContext;
  assert.match(fallback, /keine cc-wrap-PID/i);
  assert.match(fallback, /Koordinator/i);
  assert.doesNotMatch(fallback, /cc-send 999999/);

  console.log('5 Checks OK: unter Schwelle, Schwellen-Ausgabe, einmalig, zweite Schwelle, Fallback ohne Wrapper.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
