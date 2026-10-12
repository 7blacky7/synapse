import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const hook = resolve(root, 'packages/mcp-server/hooks/pre-synapse-onboarding.sh')
const fixture = mkdtempSync(join(tmpdir(), 'p7-t39-onboarding-'))
const projectRoot = join(fixture, 'project')
const synapseDir = join(projectRoot, '.synapse')
const markerPrefix = '/tmp/synapse-onboarded-p7-t39-test-koordinator-'
mkdirSync(synapseDir, { recursive: true })
writeFileSync(join(synapseDir, 'status.json'), JSON.stringify({ project: 'p7-t39-test', status: 'active' }))
writeFileSync(join(projectRoot, 'README.md'), 'test fixture')

function runHook(input, extraEnv = {}) {
  const output = execFileSync('bash', [hook], {
    cwd: projectRoot,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot, ...extraEnv },
    input: JSON.stringify(input),
    encoding: 'utf8',
  }).trim()
  return output ? JSON.parse(output) : null
}

try {
  const first = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'session-one',
    tool_input: { file_path: join(projectRoot, 'README.md') },
  })
  assert.match(first?.hookSpecificOutput?.additionalContext ?? '', /Du bist der KOORDINATOR/)
  assert.equal(
    runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-one',
      tool_input: { file_path: join(projectRoot, 'README.md') },
    }),
    null,
    'same session should only receive coordinator onboarding once',
  )

  const second = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'session-two',
    tool_input: { file_path: join(projectRoot, 'README.md') },
  })
  assert.match(second?.hookSpecificOutput?.additionalContext ?? '', /Du bist der KOORDINATOR/)

  const specialist = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'specialist-session',
    tool_input: { file_path: join(projectRoot, 'README.md') },
  }, { SYNAPSE_AGENT_NAME: 'luna-1' })
  assert.equal(specialist, null, 'specialist identity must suppress coordinator onboarding')

  const wrapperMode = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'wrapper-mode-session',
    tool_input: { file_path: join(projectRoot, 'README.md') },
  }, { SYNAPSE_WRAPPER_MODE: '1' })
  assert.equal(wrapperMode, null, 'wrapper mode without an agent name must also suppress coordinator onboarding')

  const coordinatorAfterSpecialist = runHook({
    hook_event_name: 'PreToolUse',
    session_id: 'specialist-session',
    tool_input: { file_path: join(projectRoot, 'README.md') },
  })
  assert.match(
    coordinatorAfterSpecialist?.hookSpecificOutput?.additionalContext ?? '',
    /Du bist der KOORDINATOR/,
    'specialist must not consume the coordinator session marker',
  )

  assert.equal(runHook({ hook_event_name: 'PostToolUse', session_id: 'unknown' }), null)

  const subagent = runHook({
    hook_event_name: 'SubagentStart',
    agent_id: 'sub-test',
    cwd: projectRoot,
    subagent_prompt: 'original task',
  })
  assert.match(subagent?.updatedPrompt ?? '', /Rolle: subagent/)
  assert.match(subagent?.updatedPrompt ?? '', /original task/)

  const { buildSpecialistPrompt } = await import(
    pathToFileURL(resolve(root, 'packages/agents/dist/prompts.js')).href
  )
  const prompt = buildSpecialistPrompt({
    name: 'luna-1',
    model: 'test-model',
    expertise: 'testing',
    task: 'verify onboarding',
    project: 'synapse',
  })
  const indexStatsCalls = prompt.match(/admin\(action: "index_stats"/g) ?? []
  assert.equal(indexStatsCalls.length, 1, 'specialist prompt must contain one index_stats call')
  assert.match(prompt, /admin\(action: "index_stats", project: "synapse", agent_id: "luna-1", role: "spezialist"\)/)
  assert.doesNotMatch(prompt, /admin\(action: "index_stats", project: "synapse", agent_id: "luna-1"\)/)
} finally {
  for (const session of ['session-one', 'session-two', 'specialist-session', 'wrapper-mode-session']) {
    rmSync(markerPrefix + session + '.marker', { force: true })
  }
  rmSync('/tmp/synapse-onboarded-p7-t39-test-koordinator.marker', { force: true })
  rmSync(fixture, { recursive: true, force: true })
}

console.log('P7-T39 onboarding regression tests passed')
