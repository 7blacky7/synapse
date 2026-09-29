#!/usr/bin/env node
// test-db-schutz.mjs — P10-T27
// Prueft die Schutzklausel fuer Tests mit echter DB (scripts/lib/test-db-schutz.mjs):
//   - ohne TEST_DATABASE_URL: "uebersprungen", Exit 0, keine Verbindung
//   - TEST_DATABASE_URL == Live-DB (URL, Name 'synapse', Live-Host): Abbruch Exit 2
//   - die drei betroffenen Tests und die ch6/ch8-Probes tragen keine Zugangsdaten mehr im Quelltext
// Ohne echte DB: die Kindprozesse bekommen DATABASE_URL auf 127.0.0.1:9 (nichts lauscht).

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const wurzel = new URL('../', import.meta.url)
const pfad = (p) => new URL(p, wurzel).pathname

let fehler = 0
let ok = 0
async function fall(name, fn) {
  try {
    await fn()
    ok++
  } catch (e) {
    fehler++
    console.error(`FEHLER: ${name}\n  ${e.message}`)
  }
}

const { bewerteTestDb, testDbOderSkip } = await import('./lib/test-db-schutz.mjs')

await fall('ohne TEST_DATABASE_URL -> skip', () => {
  assert.equal(bewerteTestDb({ DATABASE_URL: 'postgresql://a:b@127.0.0.1:9/x' }).modus, 'skip')
  assert.equal(bewerteTestDb({ TEST_DATABASE_URL: '  ' }).modus, 'skip')
})
await fall('gleiche URL wie DATABASE_URL -> abbruch', () => {
  const u = 'postgresql://a:b@10.0.0.5:5433/testdb'
  assert.equal(bewerteTestDb({ DATABASE_URL: u, TEST_DATABASE_URL: u }).modus, 'abbruch')
})
await fall('Live-Host 192.168.50.65:5432 -> abbruch', () => {
  assert.equal(bewerteTestDb({ TEST_DATABASE_URL: 'postgresql://a:b@192.168.50.65:5432/foo' }).modus, 'abbruch')
  // Standardport zaehlt auch
  assert.equal(bewerteTestDb({ TEST_DATABASE_URL: 'postgresql://a:b@192.168.50.65/foo' }).modus, 'abbruch')
})
await fall('Datenbankname synapse -> abbruch', () => {
  assert.equal(bewerteTestDb({ TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.5:5433/synapse' }).modus, 'abbruch')
})
await fall('Wegwerf-DB Port 5433 -> ok', () => {
  const r = bewerteTestDb({ DATABASE_URL: 'postgresql://a:b@192.168.50.65:5432/synapse', TEST_DATABASE_URL: 'postgresql://a:b@192.168.50.65:5433/jev_test' })
  assert.equal(r.modus, 'ok')
})
await fall('ungueltige URL -> abbruch', () => {
  assert.equal(bewerteTestDb({ TEST_DATABASE_URL: 'kein url' }).modus, 'abbruch')
})
await fall('testDbOderSkip setzt DATABASE_URL nur bei ok und beendet sonst', () => {
  const env = { TEST_DATABASE_URL: 'postgresql://a:b@10.0.0.5:5433/testdb', DATABASE_URL: 'postgresql://a:b@192.168.50.65:5432/synapse' }
  let code
  testDbOderSkip('t', env, (c) => { code = c })
  assert.equal(code, undefined)
  assert.equal(env.DATABASE_URL, env.TEST_DATABASE_URL)

  const skipEnv = { DATABASE_URL: 'postgresql://a:b@127.0.0.1:9/x' }
  testDbOderSkip('t', skipEnv, (c) => { code = c })
  assert.equal(code, 0)
  assert.equal(skipEnv.DATABASE_URL, 'postgresql://a:b@127.0.0.1:9/x')

  const bad = { TEST_DATABASE_URL: 'postgresql://a:b@192.168.50.65:5432/foo' }
  testDbOderSkip('t', bad, (c) => { code = c })
  assert.equal(code, 2)
})

const TESTS = [
  'scripts/test-pending-event-response-hooks.mjs',
  'scripts/test-channel-unread-integration.mjs',
  'scripts/test-embedding-claims-pg.mjs',
]

function starte(datei, extraEnv) {
  const env = { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgresql://niemand:nichts@127.0.0.1:9/keine_db', ...extraEnv }
  return spawnSync('node', [pfad(datei)], { env, encoding: 'utf8', timeout: 20_000, cwd: pfad('') })
}

for (const datei of TESTS) {
  await fall(`${datei}: ohne TEST_DATABASE_URL uebersprungen, Exit 0`, () => {
    const r = starte(datei, {})
    assert.equal(r.status, 0, `Exit ${r.status}: ${r.stderr.slice(0, 300)}`)
    assert.match(r.stderr, /uebersprungen/)
  })
  await fall(`${datei}: Live-Ziel -> Abbruch Exit 2`, () => {
    const r = starte(datei, { TEST_DATABASE_URL: 'postgresql://x:y@192.168.50.65:5432/synapse' })
    assert.equal(r.status, 2, `Exit ${r.status}: ${r.stderr.slice(0, 300)}`)
    assert.match(r.stderr, /ABBRUCH/)
  })
}

const PROBES = [
  'packages/core/scripts/ch6-feed-probe.mjs',
  'packages/core/scripts/ch8-nachrichten-archiv-probe.mjs',
  'packages/core/scripts/ci2-gegenmessung.mjs',
]
for (const datei of PROBES) {
  await fall(`${datei}: ohne DATABASE_URL Abbruch mit Meldung`, () => {
    const r = spawnSync('node', [pfad(datei)], {
      env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 20_000, cwd: pfad('packages/core'),
    })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr + r.stdout, /DATABASE_URL/)
  })
}

// Mock-URLs (127.0.0.1) sind harmlos; gesucht wird der Live-Host und URLs mit Zugangsdaten
// zu jedem anderen Host.
const MIT_CREDS = /postgres(ql)?:\/\/[^\s'"`:@/]+:[^\s'"`@]+@(?!127\.0\.0\.1\b|localhost\b)/i
const LIVE_HOST = /192\.168\.50\.65/
for (const datei of [...TESTS, ...PROBES, 'scripts/lib/test-db-schutz-aktiv.mjs']) {
  await fall(`${datei}: keine Zugangsdaten und kein Live-Host im Quelltext`, async () => {
    const text = await readFile(pfad(datei), 'utf8')
    assert.equal(MIT_CREDS.test(text), false, 'URL mit Zugangsdaten gefunden')
    assert.equal(LIVE_HOST.test(text), false, 'Live-Host im Quelltext')
  })
}
await fall('Helfer enthaelt keine URL mit Zugangsdaten', async () => {
  const text = await readFile(pfad('scripts/lib/test-db-schutz.mjs'), 'utf8')
  assert.equal(MIT_CREDS.test(text), false)
})

// Die Tests muessen den Schutz als ersten Import laden (vor core/dist).
for (const datei of TESTS) {
  await fall(`${datei}: bindet die Schutzklausel ein`, async () => {
    const text = await readFile(pfad(datei), 'utf8')
    assert.match(text, /lib\/test-db-schutz-aktiv\.mjs/)
    const erster = text.split('\n').find((z) => /^import\b/.test(z))
    assert.match(erster ?? '', /test-db-schutz-aktiv/, 'Schutz muss der erste Import sein')
  })
}

if (fehler) {
  console.error(`\n${fehler} FEHLER, ${ok} OK`)
  process.exit(1)
}
console.log(`test-db-schutz: ${ok} OK`)
