import type { Register } from 'claude-code'
import {runtimeCacheStart,runtimeCacheRequest,cacheWaechterAktiv,merkeCacheTranscript,leseCacheTranscript,cacheModellGewechselt,beobachteCacheKontext,beobachteCacheRequest,aktualisiereCacheFreigabe} from './cache-waechter'

// P22-T134 Mod-Inbox: wartet am lokalen Synapse-Daemon (mod-inbox.ts) auf Nachrichten an den Ausweis dieser Sitzung und
// startet damit einen Turn. Den Ausweis kennt nur der Daemon (aus dem Transcript); die Mod meldet nur ihre Sitzungs-ID.
// P22-T151 (Doppelzustellung inbox:1100): Die Abrufschleife wartet nie auf $.prompt.submit (sonst gilt die Sitzung im Daemon nach
// 60 s ohne Abruf als beendet und die Nachricht kommt erneut), meldet 'angenommen' sofort und reiht selbst ein. Dieselbe Nachricht
// (id) geht nie zweimal an $.prompt.submit, auch wenn der Daemon sie nach einem Neustart erneut uebergibt.
// P22-T212 (User 31.10.2026: quittierte Nachrichten kamen trotzdem als Turns): $.prompt.submit loest schon auf, sobald der Prompt
// HINTER dem laufenden Turn eingereiht ist (PromptSubmitResult), und die CLI reicht eingereihte Prompts nach jedem Tool-Aufruf in den
// laufenden Turn nach. Mit vorpruefung.aktiv (Schalter mod_inbox_vorpruefung der API, Stand aus /warte) haelt die Mod Nachrichten
// deshalb selbst: erst wenn die Hauptschleife frei ist (kein Turn, Ruhezeit seit dem Turnende um), fragt sie /mod-inbox/pruefe,
// verwirft vom Agenten schon quittierte (Quittung gestartet:true, verworfen:'quittiert') bzw. verfallene (gestartet:false) und reicht
// genau eine ein. Nicht pruefbar (alter Daemon, Fehler) -> die Nachricht gilt als offen, es geht keine verloren. Ohne vorpruefung
// bleibt der Weg von P22-T151 (Kette je Nachricht). Kein Buendeln: die Web-UI (agent-chat-logik zerlegeZustellHuelle) und der
// CLI-Verlauf kennen genau einen Kopf je Eingabe.
const PAUSE_BEI_FEHLER_MS = 10_000
/** So viele Nachrichten-IDs merkt sich die Mod fuer die Dedup (aelteste fallen heraus). */
const GEMERKT_MAX = 500
/** P22-T212: so oft schaut die Mod nach, solange ein Turn laeuft. */
const FREI_TAKT_MS = 250
/** P22-T212: Code-Standards, bis die API Werte nennt (Einstellwerte mod_inbox_ruhe_ms, mod_inbox_verfall_minuten). */
const RUHE_MS_STANDARD = 1500
const VERFALL_MS_STANDARD = 30 * 60_000

interface ModNachricht { id: string; text: string }
interface Vorpruefung { aktiv: boolean; ruhe_ms: number; verfall_ms: number }
interface WarteAntwort { nachricht?: ModNachricht | null; aktiv?: boolean; grund?: string | null;cache_waechter?:unknown; vorpruefung?: Vorpruefung | null }

/** P22-T212: Hauptschleife dieser Sitzung aus turn.start/turn.complete ohne agentId; ende = Zeitpunkt des letzten Turnendes. */
const hauptschleife = { laeuft: false, ende: 0 }

export const register: Register = on => {
  // P22-T194: nur passive Telemetrie nach Freigabe der API, Hauptloop getrennt von nativen Subagenten.
  on('classic.SessionStart',async($,e,next)=>{merkeCacheTranscript(e.transcript_path);return next(e);});
  on('classic.Stop',async($,e,next)=>{const r=await next(e);merkeCacheTranscript(e.transcript_path);void leseCacheTranscript($);return r;});
  on('classic.PostModelSwitch',async($,e,next)=>{const r=await next(e);void cacheModellGewechselt($,e.to_model);return r;});
  on('session.measure',async($,e,next)=>{void beobachteCacheKontext($,e.context.tokens);return next(e);});
  on('turn.step',async function*($,e,next){
    if(e.agentId)return yield* next(e);
    const at=await $.clock.now(),r=yield* next(e);
    void runtimeCacheRequest($,e,r.usage,at);return r;
  });
  // P22-T212: Untaetigkeit selbst verfolgen, nicht auf das Warteverhalten von $.prompt.submit verlassen.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) hauptschleife.laeuft = true
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) { hauptschleife.laeuft = false; hauptschleife.ende = await $.clock.now() }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    // P22-T194: Container-Mod ist ausschliesslich Telemetrie; niemals Inbox-Poll/$.prompt.submit starten.
    if (await runtimeCacheStart($)) return next(e)
    // P22-T212: frische Sitzung bzw. neu geladene Mod beginnt untaetig (kein Stand eines frueheren Laufs).
    hauptschleife.laeuft = false
    hauptschleife.ende = 0
    const sitzung = await $.session.id()
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const portDatei = `${home}/.synapse/file-watcher/daemon.port`
    let aktivAngezeigt: boolean | null = null
    // id -> 'wartet' (eingereiht bzw. submit laeuft) | 'gestartet'
    const gemerkt = new Map<string, 'wartet' | 'gestartet'>()
    let kette: Promise<void> = Promise.resolve()
    // P22-T212: Stand der Vorpruefung (letzte gueltige Werte bleiben, auch wenn der Schalter wieder AUS geht).
    let vorpruefungAktiv = false
    let ruheMs = RUHE_MS_STANDARD
    let verfallMs = VERFALL_MS_STANDARD
    // P22-T212: in der Mod wartende Nachrichten (Einfuegereihenfolge = Reihenfolge der Zustellung).
    const wartend = new Map<string, { text: string; seit: number }>()
    let arbeitet = false

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

    const reicheEin = async (basis: string, n: ModNachricht): Promise<void> => {
      // P22-T142: asUser ohne Claude-Code-Rahmen; die Herkunft nennt der Kopf aus API/Daemon ('[Synapse-Nachricht] ... Von:'),
      // Hooks sehen weiter kind 'plugin'. P22-T212: submit loest beim Turnstart ODER beim Einreihen hinter einem laufenden Turn auf.
      let drop: string | undefined
      try { drop = (await $.prompt.submit({ text: n.text, asUser: true })).drop } catch (err) { drop = String(err).slice(0, 200) }
      // drop: vergessen, damit ein erneuter Versuch der API wieder einen submit ausloest.
      if (drop === undefined) merke(n.id, 'gestartet')
      else gemerkt.delete(n.id)
      await melde(basis, 'quittung', { id: n.id, gestartet: drop === undefined, grund: drop ?? null })
    }

    const schlafe = (ms: number): Promise<void> => new Promise((r) => { $.clock.after(ms, () => { r() }) })

    /** P22-T212: kehrt zurueck, sobald kein Turn der Hauptschleife laeuft und die Ruhezeit seit dem letzten Turnende um ist. */
    const warteBisFrei = async (): Promise<void> => {
      for (;;) {
        if (hauptschleife.laeuft) { await schlafe(FREI_TAKT_MS); continue }
        const rest = hauptschleife.ende + ruheMs - (await $.clock.now())
        if (rest <= 0) return
        await schlafe(rest)
      }
    }

    /** P22-T212: schon quittierte IDs laut Daemon; null = nicht pruefbar (Daemon vor P22-T212, Fehler) -> alle gelten als offen. */
    const pruefe = async (basis: string, ids: string[]): Promise<Set<string> | null> => {
      try {
        const r = await $.http.fetch(`${basis}/pruefe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sitzung, ids }),
        })
        if (!r.ok) return null
        const j = JSON.parse(r.text) as { erledigt?: unknown }
        return new Set(Array.isArray(j.erledigt) ? j.erledigt.filter((x): x is string => typeof x === 'string') : [])
      } catch { return null }
    }

    /** P22-T212: wartende Nachrichten einzeln abarbeiten, jede erst bei freier Sitzung und direkt nach der Vorpruefung. */
    const arbeiteAb = async (basis: string): Promise<void> => {
      if (arbeitet) return
      arbeitet = true
      try {
        while (wartend.size > 0) {
          await warteBisFrei()
          const jetzt = await $.clock.now()
          for (const [id, w] of [...wartend]) {
            if (jetzt - w.seit <= verfallMs) continue
            // Verfallen: nicht starten; die API stellt nach ihrer Logik erneut zu (dann wieder als neue wartende Nachricht).
            wartend.delete(id)
            gemerkt.delete(id)
            await melde(basis, 'quittung', { id, gestartet: false, grund: 'verfallen', verworfen: 'verfallen' })
          }
          if (wartend.size === 0) break
          const erledigt = await pruefe(basis, [...wartend.keys()])
          for (const id of erledigt ?? []) {
            if (!wartend.delete(id)) continue
            // Vom Agenten schon quittiert: gilt als zugestellt, kein Turn.
            merke(id, 'gestartet')
            await melde(basis, 'quittung', { id, gestartet: true, grund: null, verworfen: 'quittiert' })
          }
          // Waehrend der Pruefung kann ein Turn begonnen haben: dann erneut warten und erneut pruefen.
          if (wartend.size === 0 || hauptschleife.laeuft) continue
          const [id, w] = wartend.entries().next().value as [string, { text: string; seit: number }]
          wartend.delete(id)
          await reicheEin(basis, { id, text: w.text })
          // Auch wenn turn.start (noch) nicht kam: die naechste erst nach erneuter Ruhezeit.
          hauptschleife.ende = Math.max(hauptschleife.ende, await $.clock.now())
        }
      } finally { arbeitet = false }
    }

    const nimmAn = async (basis: string, n: ModNachricht): Promise<void> => {
      const stand = gemerkt.get(n.id)
      if (stand === 'gestartet') { void melde(basis, 'quittung', { id: n.id, gestartet: true, grund: null }); return }
      void melde(basis, 'angenommen', { id: n.id })
      if (stand === 'wartet') return
      merke(n.id, 'wartet')
      if (vorpruefungAktiv) {
        wartend.set(n.id, { text: n.text, seit: await $.clock.now() })
        void arbeiteAb(basis)
        return
      }
      // Altweg (P22-T151): Kette je Nachricht, submit nacheinander in Reihenfolge.
      kette = kette.then(() => reicheEin(basis, n))
    }

    // Laeuft ueber das Ende des Hooks hinaus: ein Abruf haelt am Daemon bis zu 25 s, danach sofort der naechste.
    const runde = async (): Promise<void> => {
      let pause = 1
      try {
        const basis = `http://127.0.0.1:${(await $.fs.read(portDatei)).trim()}/mod-inbox`
        const r = await $.http.fetch(`${basis}/warte?sitzung=${sitzung}&wartend=${wartend.size}`)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = JSON.parse(r.text) as WarteAntwort
        await aktualisiereCacheFreigabe($,j.cache_waechter)
        if ((j.aktiv === true) !== aktivAngezeigt) {
          aktivAngezeigt = j.aktiv === true
          $.ui.status(aktivAngezeigt ? 'Synapse-Inbox aktiv' : undefined)
        }
        // P22-T212: ohne gueltige vorpruefung (Daemon/API vor P22-T212) bleibt der Altweg.
        const v = j.vorpruefung
        if (v && typeof v.aktiv === 'boolean' && typeof v.ruhe_ms === 'number' && typeof v.verfall_ms === 'number') {
          vorpruefungAktiv = v.aktiv
          ruheMs = v.ruhe_ms
          verfallMs = v.verfall_ms
        } else vorpruefungAktiv = false
        if (j.nachricht) void nimmAn(basis, j.nachricht)
      } catch {
        await aktualisiereCacheFreigabe($,{aktiv:false})
        pause = PAUSE_BEI_FEHLER_MS
      }
      $.clock.after(pause, () => { void runde() })
    }
    void runde()
    return next(e)
  })
}
