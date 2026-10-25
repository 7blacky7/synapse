import type { Register } from 'claude-code'

// P22-T134 Mod-Inbox: wartet am lokalen Synapse-Daemon (mod-inbox.ts) auf Nachrichten an den Ausweis dieser Sitzung und
// startet damit einen Turn. Den Ausweis kennt nur der Daemon (aus dem Transcript); die Mod meldet nur ihre Sitzungs-ID.
const PAUSE_BEI_FEHLER_MS = 10_000

interface WarteAntwort { nachricht?: { id: string; text: string } | null; aktiv?: boolean; grund?: string | null }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const sitzung = await $.session.id()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const portDatei = `${home}/.synapse/file-watcher/daemon.port`
    let aktivAngezeigt: boolean | null = null

    // Laeuft ueber das Ende des Hooks hinaus: ein Abruf haelt am Daemon bis zu 25 s, danach sofort der naechste.
    const runde = async (): Promise<void> => {
      let pause = 1
      try {
        const basis = `http://127.0.0.1:${(await $.fs.read(portDatei)).trim()}/mod-inbox`
        const r = await $.http.fetch(`${basis}/warte?sitzung=${sitzung}`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = JSON.parse(r.text) as WarteAntwort
        if ((j.aktiv === true) !== aktivAngezeigt) {
          aktivAngezeigt = j.aktiv === true
          $.ui.status(aktivAngezeigt ? 'Synapse-Inbox aktiv' : undefined)
        }
        if (j.nachricht) {
          // submit wartet, bis die Sitzung untaetig ist, und loest mit dem Turnstart auf. P22-T142: asUser ohne Claude-Code-Rahmen;
          // die Herkunft nennt der Kopf aus API/Daemon ('[Synapse-Nachricht] ... Von:'), Hooks sehen weiter kind 'plugin'.
          const s = await $.prompt.submit({ text: j.nachricht.text, asUser: true })
          await $.http.fetch(`${basis}/quittung`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sitzung, id: j.nachricht.id, gestartet: s.drop === undefined, grund: s.drop ?? null }),
          })
        }
      } catch {
        pause = PAUSE_BEI_FEHLER_MS
      }
      $.clock.after(pause, () => { void runde() })
    }
    void runde()
    return next(e)
  })
}
