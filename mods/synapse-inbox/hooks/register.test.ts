import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// P22-T151: Mod-Logik gegen einen Fake-Daemon (http.fetch) und eine Fake-Sitzung (prompt.submit haengt bis zum Turnende).
//   claude plugin test mods/synapse-inbox
const SITZUNG = '6eaf8c05-0000-4000-8000-000000000151'

interface Aufruf { pfad: string; body: Record<string, unknown> | null }

/** Fake-Daemon und Fake-Sitzung; turnEnde() beendet den laufenden Turn (alle wartenden submits starten nacheinander). */
function aufbau(on: On, opt: { annahmeRoute?: boolean; dropText?: string } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/t151' })
  const schlange: Array<{ id: string; text: string }> = []
  const aufrufe: Aufruf[] = []
  const submits: string[] = []
  let beschaeftigt = true
  const freigeben: Array<() => void> = []
  let dropNaechste: string | undefined = opt.dropText
  const antwort = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SITZUNG }))
  on('fs.read', () => ({ value: '47999\n' }))
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', (_$, e) => {
    const pfad = e.url.replace('http://127.0.0.1:47999/mod-inbox', '').replace(/\?.*$/, '')
    const roh = e.init?.body
    const body = typeof roh === 'string' ? JSON.parse(roh) as Record<string, unknown> : null
    aufrufe.push({ pfad, body })
    if (pfad === '/warte') return antwort(200, JSON.stringify({ success: true, nachricht: schlange.shift() ?? null, aktiv: true, grund: null }))
    if (pfad === '/angenommen' && opt.annahmeRoute === false) return antwort(404, '{}')
    return antwort(200, '{"success":true,"bekannt":true}')
  })
  on('prompt.submit', async (_$, e) => {
    if (beschaeftigt) await new Promise<void>((r) => { freigeben.push(r) })
    if (dropNaechste !== undefined) { const d = dropNaechste; dropNaechste = undefined; return { drop: d } }
    submits.push(e.text)
    return { text: e.text }
  })
  return {
    clock, schlange, submits,
    abrufe: () => aufrufe.filter((a) => a.pfad === '/warte').length,
    meldungen: (pfad: string) => aufrufe.filter((a) => a.pfad === pfad).map((a) => a.body),
    turnEnde: () => { beschaeftigt = false; for (const f of freigeben.splice(0)) f() },
  }
}

async function takte(clock: { advance: (ms: number) => Promise<void> }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await clock.advance(1)
}

test('Abruf laeuft waehrend submit weiter, angenommen sofort, ein submit je Nachricht', async ($, on) => {
  const f = aufbau(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  f.schlange.push({ id: 'inbox:1100', text: 'N1100' })
  await takte(f.clock, 3)
  expect(f.meldungen('/angenommen')).toEqual([{ sitzung: SITZUNG, id: 'inbox:1100' }])
  // Der Turn laeuft noch: die Mod fragt weiter ab (die Sitzung bleibt im Daemon lebendig) und startet nichts.
  const vorher = f.abrufe()
  await takte(f.clock, 20)
  expect(f.abrufe() - vorher).toBe(20)
  expect(f.submits).toEqual([])
  // Der Daemon uebergibt dieselbe Nachricht erneut (z. B. nach seinem Neustart): kein zweiter submit.
  f.schlange.push({ id: 'inbox:1100', text: 'N1100' })
  await takte(f.clock, 3)
  expect(f.meldungen('/angenommen').length).toBe(2)
  f.turnEnde()
  await f.clock.settle()
  expect(f.submits).toEqual(['N1100'])
  expect(f.meldungen('/quittung')).toEqual([{ sitzung: SITZUNG, id: 'inbox:1100', gestartet: true, grund: null }])
  // Nach dem Start erneut uebergeben: sofort 'gestartet' quittiert, wieder kein submit.
  f.schlange.push({ id: 'inbox:1100', text: 'N1100' })
  await takte(f.clock, 3)
  expect(f.submits).toEqual(['N1100'])
  expect(f.meldungen('/quittung').length).toBe(2)
})

test('mehrere Nachrichten waehrend eines Turns: Kette in Reihenfolge, je einmal', async ($, on) => {
  const f = aufbau(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  f.schlange.push({ id: 'inbox:1', text: 'A' }, { id: 'inbox:2', text: 'B' }, { id: 'inbox:3', text: 'C' })
  await takte(f.clock, 6)
  expect(f.meldungen('/angenommen').map((b) => b?.id)).toEqual(['inbox:1', 'inbox:2', 'inbox:3'])
  expect(f.submits).toEqual([])
  f.turnEnde()
  await f.clock.settle()
  expect(f.submits).toEqual(['A', 'B', 'C'])
  expect(f.meldungen('/quittung').map((b) => b?.id)).toEqual(['inbox:1', 'inbox:2', 'inbox:3'])
})

test('drop: quittiert als nicht gestartet, ein erneuter Versuch startet', async ($, on) => {
  const f = aufbau(on, { dropText: 'Stop steht' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  f.schlange.push({ id: 'inbox:7', text: 'N7' })
  await takte(f.clock, 3)
  expect(f.meldungen('/quittung')).toEqual([{ sitzung: SITZUNG, id: 'inbox:7', gestartet: false, grund: 'Stop steht' }])
  f.schlange.push({ id: 'inbox:7', text: 'N7' })
  await takte(f.clock, 3)
  expect(f.submits).toEqual(['N7'])
})

test('Daemon vor P22-T151 (404 auf /angenommen): keine Fehlerpause, Ablauf wie sonst', async ($, on) => {
  const f = aufbau(on, { annahmeRoute: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await f.clock.settle()
  f.schlange.push({ id: 'inbox:9', text: 'N9' })
  await takte(f.clock, 3)
  const vorher = f.abrufe()
  await takte(f.clock, 5)
  expect(f.abrufe() - vorher).toBe(5)
  f.turnEnde()
  await f.clock.settle()
  expect(f.submits).toEqual(['N9'])
})
