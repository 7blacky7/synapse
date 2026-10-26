/**
 * P22-T197: gemeinsamer Claude-Start ohne grossen Prompt in argv/env.
 * Datei im bestehenden Laufordner, exklusiv 0600; bis Child-close behalten:
 * das OS-spawn-Event bestaetigt noch NICHT, dass Claude die Datei gelesen hat.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, unlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { agentLaufPfad } from './agent-lauf.js'

interface ClaudePromptStart {
  agentName: string
  sessionId: string
  systemPrompt: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  projectPath: string
}

export async function starteClaudeMitPromptdatei(e: ClaudePromptStart): Promise<ChildProcess> {
  const laufPfad = agentLaufPfad(e.projectPath, e.agentName)
  const promptPfad = join(laufPfad, `claude-system-prompt-${e.sessionId}.txt`)
  const args = [...e.args, '--system-prompt-file', promptPfad]
  const argGroessen = ['claude', ...args].map(s => Buffer.byteLength(s, 'utf8') + 1)
  const envGroessen = Object.entries(e.env)
    .filter(([, wert]) => wert !== undefined)
    .map(([name, wert]) => Buffer.byteLength(`${name}=${wert}`, 'utf8') + 1)
  const summe = (werte: number[]) => werte.reduce((a, b) => a + b, 0)
  const diagnose = {
    session_id: e.sessionId,
    prompt_bytes: Buffer.byteLength(e.systemPrompt, 'utf8'),
    argv_bytes: summe(argGroessen),
    argv_max_bytes: Math.max(0, ...argGroessen),
    env_bytes: summe(envGroessen),
    env_max_bytes: Math.max(0, ...envGroessen),
    // argv/env enthalten je Zeichenkette das abschliessende NUL, keine Pointer.
    argv_env_bytes: summe(argGroessen) + summe(envGroessen),
    prompt_transport: 'datei',
  }
  console.error('[claude-start] ' + JSON.stringify(diagnose))
  await mkdir(laufPfad, { recursive: true, mode: 0o700 })
  // wx verhindert Überschreiben eines vorhandenen Pfads/Symlinks.
  // Erst nach erfolgreichem exklusivem Anlegen darf Cleanup diese Datei loeschen.
  let eigeneDatei = false
  const aufraeumen = async () => {
    if (!eigeneDatei) return
    try {
      await unlink(promptPfad)
      eigeneDatei = false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') eigeneDatei = false
      else console.error('[claude-start] ' + JSON.stringify({
        session_id: e.sessionId, phase: 'prompt_cleanup',
        code: (error as NodeJS.ErrnoException).code ?? 'unbekannt',
      }))
    }
  }

  try {
    // FileHandle erlaubt Cleanup auch bei einem partiell fehlgeschlagenen Write.
    const datei = await open(promptPfad, 'wx', 0o600)
    eigeneDatei = true
    try { await datei.writeFile(e.systemPrompt, 'utf8') }
    finally { await datei.close() }

    const proc = spawn('claude', args, {
      env: e.env, cwd: e.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    })
    proc.once('close', () => { void aufraeumen() })
    // Nicht schon vor dem OS-spawn als gestartet melden. Asynchrone Fehler
    // (z.B. ENOENT) bleiben damit im selben Fehler-/Cleanup-Pfad wie E2BIG.
    await new Promise<void>((resolve, reject) => {
      const gestartet = () => { proc.off('error', fehlgeschlagen); resolve() }
      const fehlgeschlagen = (error: Error) => { proc.off('spawn', gestartet); reject(error) }
      proc.once('error', fehlgeschlagen)
      proc.once('spawn', gestartet)
    })
    return proc
  } catch (error) {
    await aufraeumen()
    const code = (error as NodeJS.ErrnoException).code ?? 'unbekannt'
    const grund = code === 'E2BIG'
      ? 'Argument-/Environment-Groessenlimit ueberschritten; Systemprompt bereits per Datei, verbleibende argv/env pruefen'
      : 'Promptdatei oder CLI-Prozess konnte nicht gestartet werden'
    // Keine Argumente, Environment-Werte oder Prompttexte im Fehler.
    throw Object.assign(new Error(`Claude-Start fehlgeschlagen (${code}): ${grund}; ${JSON.stringify(diagnose)}`), { code })
  }
}
