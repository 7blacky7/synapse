/**
 * MODUL: channel-push
 * ZWECK: Baut den Channel-Push des Wrappers (P7-T17, 29.09.2026): adressierte Nachrichten
 *        im Volltext, fremde nur als Vorschau — reine Funktion, ohne Seiteneffekte.
 *
 * Vorher schickte der Wrapper JEDE neue Channel-Nachricht (bis 500 Zeichen) und weckte
 * den Agenten dafuer; Tabellen und Gespraeche anderer Agenten kosteten Kontext und
 * einen Turn je Push. Jetzt:
 *   - adressiert   = Volltext (Deckel 2000 Zeichen, mit Abrufhinweis)
 *   - fremd        = 200 Zeichen + id + Groesse + Abrufhinweis; hoechstens die letzten 10,
 *                    der Rest als "N weitere ab id X"
 *   - alles fremd  = wecken:false — der Aufrufer rueckt nur den Wasserstand vor und haengt
 *                    die Vorschauen an den naechsten Wake
 *   - eigene Nachrichten kommen nicht vor
 *
 * ADRESSIERT ist eine Nachricht, wenn
 *   1. sie mit "<x> -> <empfaenger>:" beginnt und der Agent (oder ALLE) unter den
 *      Empfaengern steht — nennt die Liste nur andere, ist sie fremd; oder
 *   2. sie keinen Pfeil hat und vom Koordinator kommt (allgemeine Ansage an alle); oder
 *   3. sie keinen Pfeil hat und den Agenten-Namen nennt (Wortgrenze, auch "@name").
 *
 * MENSCH (PRAXIS-FEEDBACK) ist nur ein Absender, der weder koordinator/coordinator noch
 * agent-* noch ein bekannter Agent (istBekannterAgent) noch der Agent selbst ist.
 */
export interface ChannelPushNachricht {
  id: number
  channelName: string
  sender: string
  content: string
}

export interface ChannelPushOptionen {
  /** Name dieses Agenten (SYNAPSE_AGENT_NAME) */
  agentName: string
  /** Kennt der Wrapper diesen Absender als Agenten? Fehlt = niemand ausser den Koordinator-Namen. */
  istBekannterAgent?: (name: string) => boolean
}

export interface ChannelPushErgebnis {
  /** true = mindestens eine Nachricht ist an diesen Agenten adressiert */
  wecken: boolean
  /** fertiger Textblock fuer den Prompt ('' = nichts anzuzeigen) */
  text: string
  /** mindestens eine angezeigte Nachricht kommt von einem Menschen */
  hatMensch: boolean
  adressiert: number
  fremd: number
}

export const VOLLTEXT_DECKEL = 2000
export const VORSCHAU_ZEICHEN = 200
export const MAX_VORSCHAUEN = 10

const KOORDINATOR = /^(koordinator|coordinator)$/i
const PFEIL = /^\s*[\w.-]+\s*->\s*([^:\n]{1,160}):/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nenntName(content: string, name: string): boolean {
  const n = escapeRegex(name)
  return new RegExp(`(^|[^\\w-])@?${n}($|[^\\w-])`, 'i').test(content)
}

export function istAdressiert(m: ChannelPushNachricht, agentName: string): boolean {
  const pfeil = PFEIL.exec(m.content)
  if (pfeil) {
    const ziele = pfeil[1].split(/[,&/+]|\bund\b|\band\b/i).map((z) => z.trim().toLowerCase()).filter(Boolean)
    return ziele.includes(agentName.toLowerCase()) || ziele.includes('alle') || ziele.includes('all')
  }
  if (KOORDINATOR.test(m.sender)) return true
  return nenntName(m.content, agentName)
}

function istMensch(sender: string, o: ChannelPushOptionen): boolean {
  if (KOORDINATOR.test(sender)) return false
  if (sender.startsWith('agent-')) return false
  if (sender === o.agentName) return false
  if (o.istBekannterAgent?.(sender)) return false
  return true
}

function abrufHinweis(m: ChannelPushNachricht): string {
  return `[Volltext: channel(feed, channel_name:"${m.channelName}", since_id:${m.id - 1}, limit:1)]`
}

export function baueChannelPush(
  nachrichten: ChannelPushNachricht[],
  o: ChannelPushOptionen,
): ChannelPushErgebnis {
  const fremde = nachrichten.filter((m) => m.sender !== o.agentName)
  if (fremde.length === 0) return { wecken: false, text: '', hatMensch: false, adressiert: 0, fremd: 0 }

  const adressiertFlags = fremde.map((m) => istAdressiert(m, o.agentName))
  const anzahlFremd = adressiertFlags.filter((a) => !a).length
  const anzahlAdressiert = fremde.length - anzahlFremd

  // Nur die letzten MAX_VORSCHAUEN fremden Nachrichten werden gezeigt, adressierte immer.
  const zuZeigendeFremde = new Set<number>()
  const fremdeIndizes = fremde.map((_, i) => i).filter((i) => !adressiertFlags[i])
  for (const i of fremdeIndizes.slice(-MAX_VORSCHAUEN)) zuZeigendeFremde.add(i)
  const weggefallen = fremdeIndizes.filter((i) => !zuZeigendeFremde.has(i))

  let hatMensch = false
  const zeilen: string[] = []
  if (weggefallen.length > 0) {
    zeilen.push(`${weggefallen.length} weitere ab id ${fremde[weggefallen[0]].id} nicht angezeigt (fremde Nachrichten).`)
  }
  fremde.forEach((m, i) => {
    const adressiert = adressiertFlags[i]
    if (!adressiert && !zuZeigendeFremde.has(i)) return
    const mensch = istMensch(m.sender, o)
    if (mensch) hatMensch = true
    const tag = mensch ? '[PRAXIS-FEEDBACK] ' : ''
    if (adressiert) {
      const gekuerzt = m.content.length > VOLLTEXT_DECKEL
      const inhalt = gekuerzt ? `${m.content.slice(0, VOLLTEXT_DECKEL)}… ${abrufHinweis(m)}` : m.content
      zeilen.push(`${tag}[#${m.channelName}] ${m.sender}: ${inhalt}`)
    } else {
      const flach = m.content.replace(/\s+/g, ' ').trim()
      const vorschau = flach.length > VORSCHAU_ZEICHEN ? `${flach.slice(0, VORSCHAU_ZEICHEN)}… ${abrufHinweis(m)}` : flach
      zeilen.push(`${tag}[#${m.channelName}] ${m.sender} (id ${m.id}, ${m.content.length} Z.): ${vorschau}`)
    }
  })

  return {
    wecken: anzahlAdressiert > 0,
    text: zeilen.join('\n\n'),
    hatMensch,
    adressiert: anzahlAdressiert,
    fremd: anzahlFremd,
  }
}
