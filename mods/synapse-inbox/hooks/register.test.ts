import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// P22-T151: Mod-Logik gegen einen Fake-Daemon (http.fetch) und eine Fake-Sitzung (prompt.submit haengt bis zum Turnende).
// P22-T212: Vorpruefung (Schalter mod_inbox_vorpruefung, Stand in /warte vorpruefung): die Mod haelt Nachrichten, bis die
//   Hauptschleife frei ist (turn.start/turn.complete + Ruhezeit), fragt /mod-inbox/pruefe und verwirft vorher quittierte bzw.
//   verfallene. Geprueft: register.ts arbeiteAb/warteBisFrei/pruefe/nimmAn; Daemon-Route siehe file-watcher-daemon-ts mod-inbox.ts.
//   Ohne vorpruefung in /warte laufen die Tests von P22-T151 unveraendert (Altweg).
//   claude plugin test mods/synapse-inbox
const SITZUNG = '6eaf8c05-0000-4000-8000-000000000151'

interface Aufruf { pfad: string; body: Record<string, unknown> | null }

/** Fake-Daemon und Fake-Sitzung; turnEnde() beendet den laufenden Turn (alle wartenden submits starten nacheinander). */
interface Vorpruefung { aktiv: boolean; ruhe_ms: number; verfall_ms: number }

function aufbau(on: On, opt: { annahmeRoute?: boolean; dropText?: string; vorpruefung?: Vorpruefung; pruefeRoute?: boolean } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/t151' })
  const schlange: Array<{ id: string; text: string }> = []
  const aufrufe: Aufruf[] = []
  const submits: string[] = []
  let beschaeftigt = true
  const freigeben: Array<() => void> = []
  let dropNaechste: string | undefined = opt.dropText
  // P22-T212: vom Agenten quittierte Schluessel (Antwort von /pruefe).
  const quittiert = new Set<string>()
  const antwort = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: SITZUNG }))
  on('fs.read', () => ({ value: '47999\n' }))
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', (_$, e) => {
    const pfad = e.url.replace('http://127.0.0.1:47999/mod-inbox', '').replace(/\?.*$/, '')
    const roh = e.init?.body
    const body = typeof roh === 'string' ? JSON.parse(roh) as Record<string, unknown> : null
    aufrufe.push({ pfad, body })
    if (pfad === '/warte') return antwort(200, JSON.stringify({ success: true, nachricht: schlange.shift() ?? null, aktiv: true, grund: null,
      ...(opt.vorpruefung ? { vorpruefung: opt.vorpruefung } : {}) }))
    if (pfad === '/angenommen' && opt.annahmeRoute === false) return antwort(404, '{}')
    if (pfad === '/pruefe') {
      if (opt.pruefeRoute === false) return antwort(404, '{}')
      const ids = (body?.ids ?? []) as string[]
      return antwort(200, JSON.stringify({ success: true, aktiv: true, erledigt: ids.filter((i) => quittiert.has(i)), offen: ids.filter((i) => !quittiert.has(i)) }))
    }
    return antwort(200, '{"success":true,"bekannt":true}')
  })
  on('prompt.submit', async (_$, e) => {
    if (beschaeftigt) await new Promise<void>((r) => { freigeben.push(r) })
    if (dropNaechste !== undefined) { const d = dropNaechste; dropNaechste = undefined; return { drop: d } }
    submits.push(e.text)
    return { text: e.text }
  })
  return {
    clock, schlange, submits, quittiert,
    abrufe: () => aufrufe.filter((a) => a.pfad === '/warte').length,
    meldungen: (pfad: string) => aufrufe.filter((a) => a.pfad === pfad).map((a) => a.body),
    turnEnde: () => { beschaeftigt = false; for (const f of freigeben.splice(0)) f() },
  }
}

async function takte(clock: { advance: (ms: number) => Promise<void> }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await clock.advance(1)
}

// P22-T212: Turns der Hauptschleife, wie die CLI sie meldet (ohne agentId).
const turnStart = ($: Parameters<Parameters<typeof test>[1]>[0], id: string) => $.turn.start({ text: '', turnId: id })
const turnEnde = ($: Parameters<Parameters<typeof test>[1]>[0], id: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
const VORPRUEFUNG: Vorpruefung = { aktiv: true, ruhe_ms: 100, verfall_ms: 60_000 }
/** Nach einem Turnende: Schlaftakt der Mod (FREI_TAKT_MS 250) plus Ruhezeit (100) plus Luft. */
const NACH_TURNENDE = 400
/** Debugzeile mit Herkunft bei Fehlschlag (regel-tests-mit-herkunft-kommentieren). */
const herkunft = (label: string, ist: unknown) => `${label} | ist: ${JSON.stringify(ist).slice(0, 300)}`

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

// User 31.10.2026 (moo-Koordinator): quittierte Nachrichten kamen trotzdem als Turns, weil sie schon in der CLI-Warteschlange standen.
test('P22-T212 register.ts arbeiteAb: beschaeftigte Sitzung, 2 von 3 vorher quittiert -> 1 submit, 2 verworfen', async ($, on) => {
  const f = aufbau(on, { vorpruefung: VORPRUEFUNG })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  await turnStart($, 't1')
  f.schlange.push({ id: 'inbox:1', text: 'A' }, { id: 'inbox:2', text: 'B' }, { id: 'inbox:3', text: 'C' })
  await takte(f.clock, 6)
  expect(f.meldungen('/angenommen').map((b) => b?.id)).toEqual(['inbox:1', 'inbox:2', 'inbox:3'])
  // Turn laeuft: nichts eingereicht, auch nach langer Zeit nicht (vorher ging submit sofort in die CLI-Warteschlange).
  await takte(f.clock, 500)
  expect(f.submits, herkunft('P22-T212 warteBisFrei: kein submit waehrend des Turns', f.submits)).toEqual([])
  f.quittiert.add('inbox:1').add('inbox:2')
  await turnEnde($, 't1')
  await takte(f.clock, NACH_TURNENDE)
  expect(f.submits, herkunft('P22-T212 pruefe: nur die offene Nachricht', f.submits)).toEqual(['C'])
  const q = f.meldungen('/quittung')
  expect(q, herkunft('P22-T212 Quittungen verworfen/gestartet', q)).toEqual([
    { sitzung: SITZUNG, id: 'inbox:1', gestartet: true, grund: null, verworfen: 'quittiert' },
    { sitzung: SITZUNG, id: 'inbox:2', gestartet: true, grund: null, verworfen: 'quittiert' },
    { sitzung: SITZUNG, id: 'inbox:3', gestartet: true, grund: null },
  ])
})

test('P22-T212 register.ts warteBisFrei: turn.start in der Ruhezeit -> erst nach dem naechsten Turnende', async ($, on) => {
  const f = aufbau(on, { vorpruefung: VORPRUEFUNG })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  await turnStart($, 't1')
  f.schlange.push({ id: 'inbox:5', text: 'N5' })
  await takte(f.clock, 3)
  await turnEnde($, 't1')
  await takte(f.clock, 50)
  // Ein vom User eingereihter Prompt startet direkt nach dem Turnende: die Mod wartet weiter.
  await turnStart($, 't2')
  await takte(f.clock, 300)
  expect(f.submits, herkunft('P22-T212 Ruhezeit: kein submit bei neuem Turn', f.submits)).toEqual([])
  await turnEnde($, 't2')
  await takte(f.clock, NACH_TURNENDE)
  expect(f.submits, herkunft('P22-T212 nach dem Turnende eingereicht', f.submits)).toEqual(['N5'])
})

test('P22-T212 register.ts arbeiteAb: mehrere offene einzeln, die naechste erst nach dem Turn der vorigen und erneuter Pruefung', async ($, on) => {
  const f = aufbau(on, { vorpruefung: VORPRUEFUNG })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  await turnStart($, 't1')
  f.schlange.push({ id: 'chat:1', text: 'X' }, { id: 'chat:2', text: 'Y' })
  await takte(f.clock, 4)
  await turnEnde($, 't1')
  // Wie in echt: der submit der ersten startet sofort ihren Turn (hier im ersten Takt danach).
  for (let i = 0; i < NACH_TURNENDE && f.submits.length === 0; i++) await f.clock.advance(1)
  expect(f.submits, herkunft('P22-T212 erste allein', f.submits)).toEqual(['X'])
  await turnStart($, 't2')
  // Der Turn der ersten laeuft: die zweite wartet und wird vorher erneut geprueft (inzwischen quittiert -> verworfen).
  f.quittiert.add('chat:2')
  await takte(f.clock, 200)
  expect(f.submits, herkunft('P22-T212 zweite wartet waehrend des Turns', f.submits)).toEqual(['X'])
  await turnEnde($, 't2')
  await takte(f.clock, NACH_TURNENDE)
  expect(f.submits, herkunft('P22-T212 zweite verworfen', f.submits)).toEqual(['X'])
  expect(f.meldungen('/quittung').map((b) => [b?.id, b?.verworfen ?? null])).toEqual([['chat:1', null], ['chat:2', 'quittiert']])
})

test('P22-T212 register.ts pruefe: Daemon ohne /pruefe (404) -> Nachricht gilt als offen, wird eingereicht', async ($, on) => {
  const f = aufbau(on, { vorpruefung: VORPRUEFUNG, pruefeRoute: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  f.schlange.push({ id: 'inbox:8', text: 'N8' })
  await takte(f.clock, 150)
  expect(f.submits, herkunft('P22-T212 404 -> eingereicht', f.submits)).toEqual(['N8'])
})

test('P22-T212 register.ts arbeiteAb: verfallene Nachricht wird nicht eingereicht, als nicht gestartet quittiert', async ($, on) => {
  const f = aufbau(on, { vorpruefung: { aktiv: true, ruhe_ms: 100, verfall_ms: 1000 } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  f.turnEnde()
  await f.clock.settle()
  await turnStart($, 't1')
  f.schlange.push({ id: 'event:4', text: 'E4' })
  await takte(f.clock, 3)
  await f.clock.advance(1500)
  await turnEnde($, 't1')
  await takte(f.clock, NACH_TURNENDE)
  expect(f.submits, herkunft('P22-T212 Verfall: kein submit', f.submits)).toEqual([])
  expect(f.meldungen('/quittung')).toEqual([{ sitzung: SITZUNG, id: 'event:4', gestartet: false, grund: 'verfallen', verworfen: 'verfallen' }])
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
