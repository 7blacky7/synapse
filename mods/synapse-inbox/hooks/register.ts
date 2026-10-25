import type { Register } from 'claude-code'

// P22-T134 Mod-Inbox: wartet am lokalen Synapse-Daemon (mod-inbox.ts) auf Nachrichten an den Ausweis dieser Sitzung und
// startet damit einen Turn. Den Ausweis kennt nur der Daemon (aus dem Transcript); die Mod meldet nur ihre Sitzungs-ID.
// P22-T151 (Doppelzustellung inbox:1100): $.prompt.submit wartet, bis die Sitzung untaetig ist. Die Abrufschleife wartet deshalb
// nicht mehr darauf (sonst gilt die Sitzung im Daemon nach 60 s ohne Abruf als beendet und die Nachricht kommt erneut), meldet
// 'angenommen' sofort und reiht in eine eigene Kette ein (submits nacheinander, in Reihenfolge). Dieselbe Nachricht (id) geht nie
// zweimal an $.prompt.submit, auch wenn der Daemon sie nach einem Neustart erneut uebergibt.
const PAUSE_BEI_FEHLER_MS = 10_000
/** So viele Nachrichten-IDs merkt sich die Mod fuer die Dedup (aelteste fallen heraus). */
const GEMERKT_MAX = 500

interface ModNachricht { id: string; text: string }
interface WarteAntwort { nachricht?: ModNachricht | null; aktiv?: boolean; grund?: string | null }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const sitzung = await $.session.id()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const portDatei = `${home}/.synapse/file-watcher/daemon.port`
    let aktivAngezeigt: boolean | null = null
    // id -> 'wartet' (eingereiht bzw. submit laeuft) | 'gestartet'
    const gemerkt = new Map<string, 'wartet' | 'gestartet'>()
    let kette: Promise<void> = Promise.resolve()

    const merke = (id: string, stand: 'wartet' | 'gestartet'): void => {
      gemerkt.delete(id)
      gemerkt.set(id, stand)
      while (gemerkt.size > GEMERKT_MAX) gemerkt.delete(gemerkt.keys().next().value as string)
    }

    // Meldung an den Daemon; ein Fehler oder 404 (Daemon vor P22-T151 kennt /angenommen nicht) hat keine Folgen fuer die Schleife.
    const melde = async (basis: string, pfad: 'angenommen' | 'quittung', body: Record<string, unknown>): Promise<void> => {
      try {
        await $.http.fetch(`${basis}/${pfad}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sitzung, ...body }),
        })
      } catch { /* der naechste Job derselben Nachricht fragt erneut, die Antwort kommt dann aus gemerkt */ }
    }

    const nimmAn = (basis: string, n: ModNachricht): void => {
      const stand = gemerkt.get(n.id)
      if (stand === 'gestartet') { void melde(basis, 'quittung', { id: n.id, gestartet: true, grund: null }); return }
      void melde(basis, 'angenommen', { id: n.id })
      if (stand === 'wartet') return
      merke(n.id, 'wartet')
      kette = kette.then(async () => {
        // submit wartet, bis die Sitzung untaetig ist, und loest mit dem Turnstart auf. P22-T142: asUser ohne Claude-Code-Rahmen;
        // die Herkunft nennt der Kopf aus API/Daemon ('[Synapse-Nachricht] ... Von:'), Hooks sehen weiter kind 'plugin'.
        let drop: string | undefined
        try { drop = (await $.prompt.submit({ text: n.text, asUser: true })).drop } catch (err) { drop = String(err).slice(0, 200) }
        // drop: vergessen, damit ein erneuter Versuch der API wieder einen submit ausloest.
        if (drop === undefined) merke(n.id, 'gestartet')
        else gemerkt.delete(n.id)
        await melde(basis, 'quittung', { id: n.id, gestartet: drop === undefined, grund: drop ?? null })
      })
    }

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
        if (j.nachricht) nimmAn(basis, j.nachricht)
      } catch {
        pause = PAUSE_BEI_FEHLER_MS
      }
      $.clock.after(pause, () => { void runde() })
    }
    void runde()
    return next(e)
  })
}
