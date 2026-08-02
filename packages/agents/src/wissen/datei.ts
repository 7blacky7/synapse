/**
 * MODUL: datei-Umsetzung der Wissensschicht (VORGABE)
 * ZWECK: Das heutige Verhalten, unveraendert.
 *
 * ⚠️ HIER STEHT ABSICHTLICH FAST KEINE LOGIK. Jede Faehigkeit ruft genau die
 * Funktion aus skills.ts, die der Aufrufer bisher direkt gerufen hat. Ein
 * Nachbau waere die naheliegende Fehlerquelle: er saehe gleich aus und waere es
 * nicht — und weil der Vorgabe-Weg der Massstab ist, an dem der api-Weg gemessen
 * wird, wuerde ein Fehler hier BEIDE Wege gleichzeitig verfaelschen.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createInitialAgent,
  readMeta,
  readSkill,
  readSkillFile,
  writeSkillFile,
  appendToSkillFile,
  purgeAgentDir,
  ensureAgentDir,
  type SkillFile,
} from '../skills.js'
import type {
  AgentWissen,
  AnlegeErgebnis,
  WissensUmgebung,
  WissensZugriff,
} from './typen.js'

export class DateiWissen implements WissensZugriff {
  readonly art = 'datei' as const

  constructor(private readonly umgebung: WissensUmgebung) {}

  private promptDatei(agent: string): string {
    return (
      this.umgebung.promptPfad ??
      join(this.umgebung.projektPfad, '.synapse', 'agents', agent, 'system-prompt.txt')
    )
  }

  async liesAlles(agent: string): Promise<AgentWissen | null> {
    // readSkill ist genau die Funktion, die der Spawner heute ruft — inklusive
    // ihres Rueckfalls auf eine alte SKILL.md. null heisst unbekannt.
    const text = await readSkill(this.umgebung.projektPfad, agent)
    if (text === null) return null
    const meta = await readMeta(this.umgebung.projektPfad, agent)

    // ⚠️ GEFUNDEN IM SELBSTTEST, 02.08.2026: hier stand zuerst
    // text.trim().length === 0. Das konnte NIE zutreffen — der gerenderte Text
    // traegt immer die Kopfzeile und die vier Ueberschriften, ein frisch
    // angelegter Agent kommt so auf ueber hundert Zeichen. Das Feld haette also
    // dauerhaft 'nicht leer' gemeldet, ohne je etwas geprueft zu haben: genau
    // die Art Auskunft, die beruhigt und nichts weiss.
    // Jetzt zaehlen die INHALTE. Beim Rueckfall auf eine alte SKILL.md (kein
    // meta.yaml, also auch keine vier Dateien) bleibt es beim Text — dort ist er
    // der Inhalt.
    let leer: boolean
    if (meta === null) {
      leer = text.trim().length === 0
    } else {
      const arten: SkillFile[] = ['rules', 'errors', 'patterns', 'context']
      const inhalte = await Promise.all(
        arten.map(art => readSkillFile(this.umgebung.projektPfad, agent, art)),
      )
      leer = inhalte.every(inhalt => (inhalt ?? '').trim().length === 0)
    }

    return { meta, text, leer }
  }

  async legeAn(agent: string, model: string, expertise: string): Promise<AnlegeErgebnis> {
    // Dieselbe Bedingung wie heute im Spawner: nur anlegen, wenn readSkill
    // nichts findet. Damit kann auch dieser Weg vorhandenes Wissen nicht
    // ueberschreiben.
    const vorhanden = await readSkill(this.umgebung.projektPfad, agent)
    if (vorhanden !== null) {
      return { angelegt: false, grund: 'Agent hat bereits Wissen — nichts angefasst.' }
    }
    await createInitialAgent(this.umgebung.projektPfad, agent, model, expertise)
    return { angelegt: true, grund: 'meta + vier leere Dateien angelegt.' }
  }

  async liesArt(agent: string, art: SkillFile): Promise<string | null> {
    return readSkillFile(this.umgebung.projektPfad, agent, art)
  }

  async schreibeArt(agent: string, art: SkillFile, inhalt: string): Promise<void> {
    await writeSkillFile(this.umgebung.projektPfad, agent, art, inhalt)
  }

  async haengeAn(agent: string, art: SkillFile, eintrag: string): Promise<void> {
    await appendToSkillFile(this.umgebung.projektPfad, agent, art, eintrag)
  }

  async entferneEintraege(agent: string, art: SkillFile, enthaelt: string): Promise<number> {
    // Wortgleich zum heutigen remove-Zweig in specialists.ts: zeilenweise
    // filtern, dann ganz zurueckschreiben. Die ZAHL ist neu — sie war vorher
    // nur ein Vergleich zweier Laengen und ging danach verloren.
    const bestand = await readSkillFile(this.umgebung.projektPfad, agent, art)
    if (bestand === null) return 0
    const zeilen = bestand.split('\n')
    const gefiltert = zeilen.filter(z => !z.includes(enthaelt))
    const entfernt = zeilen.length - gefiltert.length
    if (entfernt === 0) return 0
    await writeSkillFile(this.umgebung.projektPfad, agent, art, gefiltert.join('\n'))
    return entfernt
  }

  async loescheAlles(agent: string): Promise<number> {
    // Der Dateiweg kann keine Tabellenzeilen zaehlen — er zaehlt die DATEIEN, die
    // es vor dem Loeschen gab. Andere Einheit als im api-Weg, aber dieselbe Frage:
    // war ueberhaupt etwas da? Gezaehlt wird VOR purgeAgentDir, danach ist nichts
    // mehr zu zaehlen.
    const verzeichnis = join(this.umgebung.projektPfad, '.synapse', 'agents', agent)
    let vorher = 0
    try {
      const eintraege = await readdir(verzeichnis, { recursive: true, withFileTypes: true })
      vorher = eintraege.filter((e) => e.isFile()).length
    } catch {
      // Kein Verzeichnis = nichts da. Die 0 ist hier eine Aussage, kein Fehler.
    }
    await purgeAgentDir(this.umgebung.projektPfad, agent)
    return vorher
  }

  async legeSystemPromptAb(agent: string, inhalt: string): Promise<void> {
    // Verzeichnis sicherstellen wie bisher (der Spawner tut es vor dem Schreiben
    // ebenfalls), dann die Datei an genau den Platz von heute.
    await ensureAgentDir(this.umgebung.projektPfad, agent)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(this.promptDatei(agent), inhalt, 'utf-8')
  }

  async holeSystemPrompt(agent: string): Promise<string> {
    // Ein Lesefehler wirft hier von selbst — genau wie heute im Wrapper, wo ein
    // fehlgeschlagenes readFile den Start abbricht.
    return readFile(this.promptDatei(agent), 'utf-8')
  }
}
