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

// ---- P9-T29: pruefeTestDbUrl (DATABASE_URL kommt automatisch aus der Projekt-DB, keine test-db.env) ----
const { bewerteTestDbUrl, pruefeTestDbUrl } = await import('./lib/test-db-schutz.mjs')
const TEST_OK = 'postgresql://u:p@10.0.0.5:5433/synapse_test'
await fall('P9-T29 bewerteTestDbUrl: nur Port 5433 + synapse_test ok', () => {
  assert.equal(bewerteTestDbUrl(TEST_OK).ok, true)
  assert.equal(bewerteTestDbUrl(TEST_OK + '?sslmode=disable').ok, true)
  assert.equal(bewerteTestDbUrl('postgres://u:p@10.0.0.5:5433/synapse_test').ok, true)
  for (const [url, teil] of [
    [undefined, 'fehlt'], ['', 'fehlt'], ['kein url', 'gueltige'],
    ['http://u:p@10.0.0.5:5433/synapse_test', 'Protokoll'],
    ['postgresql://u:p@192.168.50.65:5432/synapse', 'System-DB'],
    ['postgresql://u:p@10.0.0.5/synapse_test', 'System-DB'],
    ['postgresql://u:p@10.0.0.5:5433/synapse', 'System-DB'],
    ['postgresql://u:p@10.0.0.5:5434/synapse_test', 'Port 5434'],
    ['postgresql://u:p@10.0.0.5:5433/anderes_projekt', "Datenbank 'anderes_projekt'"],
  ]) {
    const r = bewerteTestDbUrl(url)
    assert.equal(r.ok, false, String(url))
    assert.ok(r.grund.includes(teil), `${url}: ${r.grund}`)
    assert.ok(!r.grund.includes('u:p@'), 'keine Zugangsdaten in der Meldung')
  }
  // andere registrierte Projekt-DB nur ausdruecklich, System-Name nie
  assert.equal(bewerteTestDbUrl('postgresql://u:p@10.0.0.5:5433/anderes_projekt', { datenbank: 'anderes_projekt' }).ok, true)
  assert.equal(bewerteTestDbUrl('postgresql://u:p@10.0.0.5:5433/synapse', { datenbank: 'synapse' }).ok, false)
})
await fall('P9-T29 pruefeTestDbUrl: Exit 2 bei falscher URL, URL zurueck bei ok', () => {
  let code
  const alt = console.error
  const meldungen = []
  console.error = (m) => meldungen.push(String(m))
  try {
    assert.equal(pruefeTestDbUrl('t', { env: { DATABASE_URL: TEST_OK }, beende: (c) => { code = c } }), TEST_OK)
    assert.equal(code, undefined)
    assert.equal(pruefeTestDbUrl('t', { env: { DATABASE_URL: 'postgresql://u:geheim@192.168.50.65:5432/synapse' }, beende: (c) => { code = c } }), undefined)
    assert.equal(code, 2)
  } finally { console.error = alt }
  assert.match(meldungen.join('\n'), /ABBRUCH t: DATABASE_URL zeigt auf die System-DB.*project\(action:'projekt_db'\).*keine test-db\.env/s)
  assert.ok(!meldungen.join('\n').includes('geheim'), 'Passwort nie in der Meldung')
})
const UMGESTELLT = [
  'packages/core/tests/erklaerung-hinweis-status.test.mjs', 'packages/core/tests/jev-schalter.test.mjs',
  'scripts/test-fehlermuster-rest.mjs', 'scripts/test-intern-daemon-bruecke.mjs', 'scripts/erklaerungen/messung-sprache.mjs',
]
for (const datei of UMGESTELLT.slice(0, 1).concat(['scripts/test-intern-daemon-bruecke.mjs'])) {
  for (const [fallname, url] of [['ohne DATABASE_URL', undefined], ['System-DB', 'postgresql://x:y@192.168.50.65:5432/synapse'], ['fremde DB auf 5433', 'postgresql://x:y@127.0.0.1:5433/andere']]) {
    await fall(`P9-T29 ${datei}: ${fallname} -> Abbruch Exit 2 vor jeder Verbindung`, () => {
      const env = { PATH: process.env.PATH ?? '' }
      if (url) env.DATABASE_URL = url
      const r = spawnSync('node', [pfad(datei)], { env, encoding: 'utf8', timeout: 20_000, cwd: pfad('') })
      assert.equal(r.status, 2, `Exit ${r.status}: ${r.stderr.slice(0, 300)}`)
      assert.match(r.stderr, /ABBRUCH .*Projekt-DB/)
    })
  }
}
for (const datei of UMGESTELLT) {
  await fall(`P9-T29 ${datei}: nutzt pruefeTestDbUrl, laedt keine test-db.env`, async () => {
    const text = await readFile(pfad(datei), 'utf8')
    assert.match(text, /^import \{ pruefeTestDbUrl \} from '[./]+(?:\/[.]{2})*(?:\/scripts)?\/lib\/test-db-schutz\.mjs';$/m)
    assert.match(text, /^pruefeTestDbUrl\('[^']+'\);$/m)
    assert.equal(/\. <?test-db\.env|source test-db\.env/.test(text), false, 'kein Laden einer test-db.env')
  })
}

if (fehler) {
  console.error(`\n${fehler} FEHLER, ${ok} OK`)
  process.exit(1)
}
console.log(`test-db-schutz: ${ok} OK`)
