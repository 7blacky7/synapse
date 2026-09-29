// test-specialist-stop-prozess.mjs — P2-T386/T387: specialist(stop) meldet Erfolg nur,
// wenn der Wrapper-Prozess wirklich weg ist; purge/stop formulieren den Prozesstod gleich.
// Ohne echte DB: status.json in einem Temp-Verzeichnis, echte Kindprozesse.
// Voraussetzung: gebaute dists (pnpm build).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spec = await import('../packages/mcp-server/dist/tools/specialists.js')

let ok = 0
let fehler = 0
async function pruefe(name, fn) {
  try { await fn(); ok++; console.log('OK    ' + name) } catch (e) { fehler++; console.log('FEHLER ' + name + ': ' + e.message) }
}

async function projektMitSpezialist(name, pid) {
  const dir = await mkdtemp(join(tmpdir(), 'stop-test-'))
  await mkdir(join(dir, '.synapse', 'agents'), { recursive: true })
  const eintrag = { name, status: 'running', model: 'sonnet', ...(pid ? { wrapperPid: pid } : {}) }
  await writeFile(join(dir, '.synapse', 'agents', 'status.json'), JSON.stringify({ specialists: { [name]: eintrag }, maxSpecialists: 7, lastUpdate: new Date().toISOString() }))
  return dir
}
const statusVon = async (dir, name) => JSON.parse(await readFile(join(dir, '.synapse', 'agents', 'status.json'), 'utf-8')).specialists[name]
const ergebnis = (r) => JSON.parse(r.content[0].text)
const lebt = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

await pruefe('Hilfsfunktion prozessTodMeldung: bewiesen vs UNGEPRUEFT', () => {
  assert.equal(typeof spec.prozessTodMeldung, 'function')
  assert.match(spec.prozessTodMeldung({ prozess_beendet: true }), /nachweislich beendet/)
  const u = spec.prozessTodMeldung({ prozess_beendet: 'keine Wrapper-PID bekannt — Prozesstod UNGEPRUEFT' })
  assert.match(u, /UNGEPRUEFT/)
  assert.doesNotMatch(u, /nachweislich beendet/)
})

await pruefe('stop: normaler Prozess wird beendet, Erfolg + nachweislich', async () => {
  const kind = spawn('sleep', ['60'], { stdio: 'ignore' })
  const dir = await projektMitSpezialist('t-normal', kind.pid)
  const r = ergebnis(await spec.stopSpecialistTool('t-normal', dir))
  assert.equal(r.success, true)
  assert.match(r.message, /nachweislich beendet/)
  assert.equal(lebt(kind.pid), false)
  assert.equal((await statusVon(dir, 't-normal')).status, 'stopped')
  await rm(dir, { recursive: true, force: true })
})

await pruefe('stop: Prozess ignoriert SIGTERM -> SIGKILL-Eskalation, danach tot', async () => {
  const kind = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 400))
  const dir = await projektMitSpezialist('t-hartnaeckig', kind.pid)
  const r = ergebnis(await spec.stopSpecialistTool('t-hartnaeckig', dir))
  assert.equal(r.success, true)
  assert.equal(lebt(kind.pid), false)
  assert.equal((await statusVon(dir, 't-hartnaeckig')).status, 'stopped')
  await rm(dir, { recursive: true, force: true })
})

await pruefe('stop: Prozess nicht beendbar -> success:false, Status bleibt running', async () => {
  if (process.getuid && process.getuid() === 0) return // als root nie PID 1 anfassen
  const dir = await projektMitSpezialist('t-unkillbar', 1)
  const r = ergebnis(await spec.stopSpecialistTool('t-unkillbar', dir))
  assert.equal(r.success, false)
  assert.match(r.message, /lebt noch/)
  assert.equal((await statusVon(dir, 't-unkillbar')).status, 'running')
  await rm(dir, { recursive: true, force: true })
})

await pruefe('stop: keine PID bekannt -> ehrlich UNGEPRUEFT statt nachweislich', async () => {
  const dir = await projektMitSpezialist('t-ohnepid', null)
  const r = ergebnis(await spec.stopSpecialistTool('t-ohnepid', dir))
  assert.match(r.message, /UNGEPRUEFT/)
  assert.doesNotMatch(r.message, /nachweislich beendet/)
  assert.equal((await statusVon(dir, 't-ohnepid')).status, 'stopped')
  await rm(dir, { recursive: true, force: true })
})

console.log(`${ok} OK / ${fehler} FEHLER`)
process.exit(fehler ? 1 : 0)
