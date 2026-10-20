/**
 * P22-T66: Startfehler eines Wrappers (CLI startet nicht: Rechte als root, Projektordner fehlt, Programm fehlt) als eine
 * Zeile im Laufordner neben wrapper.log. Der Wrapper beendet sich danach; Spawn und Wake (mcp-server specialists.ts) lesen
 * den Grund und melden ihn weiter, statt nur "nicht verbunden". Ein neuer Spawn loescht die Datei vorher.
 * Ort: <agentLaufPfad>/logs/start-fehler.txt (Identitaets-Laeufe unter ~/.synapse/agent-runs/<id>, sonst im Projektordner).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { agentLaufPfad } from './agent-lauf.js'

export function startFehlerPfad(projectPath: string, name: string): string {
  return join(agentLaufPfad(projectPath, name), 'logs', 'start-fehler.txt')
}

/** Wirft nie: der Grund ist Zusatz, der Abbruch selbst darf nicht daran haengen. */
export async function merkeStartFehler(projectPath: string, name: string, grund: string): Promise<void> {
  try {
    const pfad = startFehlerPfad(projectPath, name)
    await mkdir(dirname(pfad), { recursive: true })
    await writeFile(pfad, `${new Date().toISOString()} ${grund.replace(/\s+/g, ' ').trim().slice(0, 500)}\n`, 'utf-8')
  } catch {
    // best effort
  }
}

export async function leseStartFehler(projectPath: string, name: string): Promise<string | null> {
  try {
    const text = (await readFile(startFehlerPfad(projectPath, name), 'utf-8')).trim()
    return text || null
  } catch {
    return null
  }
}

export async function loescheStartFehler(projectPath: string, name: string): Promise<void> {
  try {
    await rm(startFehlerPfad(projectPath, name), { force: true })
  } catch {
    // best effort
  }
}
