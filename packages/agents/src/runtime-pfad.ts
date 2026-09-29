/**
 * MODUL: runtime-pfad
 * ZWECK: Pfad der node-Runtime eines Providers (z. B. '@synapse/agents-gemini/runtime') aufloesen (P7-T13).
 *
 * agents hing nur deshalb per package.json an agents-gemini/agents-antigravity, damit
 * require.resolve() den Pfad findet — zur Laufzeit, kein Import. Die Runtimes importieren aber echte
 * Funktionen aus @synapse/agents: das war ein Abhaengigkeitskreis (pnpm baute beide parallel, neue
 * agents-Exporte fehlten dem Runtime-Build: TS2305).
 *
 * Jetzt: erst require.resolve (klappt, solange node_modules-Links bestehen); schlaegt das fehl,
 * Fallback auf den Workspace-Pfad RELATIV ZUR gebauten dist-Datei (nicht zu cwd):
 *   <packages>/agents/dist/  ->  <packages>/agents-gemini/dist/runtime.js
 * Reine Funktion, resolve/existsSync injizierbar.
 */

import { join } from 'node:path'

export interface RuntimePfadDeps {
  /** require.resolve */
  resolve: (spezifikation: string) => string
  existsSync: (pfad: string) => boolean
}

/** '@synapse/agents-gemini/runtime' -> { paket: 'agents-gemini', unterpfad: 'runtime' } */
export function zerlegeRuntimeSpezifikation(spez: string): { paket: string; unterpfad: string } | null {
  const m = /^@synapse\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(spez)
  return m ? { paket: m[1], unterpfad: m[2] } : null
}

/** Workspace-Pfad relativ zum Verzeichnis der gebauten dist-Datei (packages/agents/dist). */
export function workspaceRuntimePfad(spez: string, distVerzeichnis: string): string | null {
  const z = zerlegeRuntimeSpezifikation(spez)
  if (!z) return null
  return join(distVerzeichnis, '..', '..', z.paket, 'dist', `${z.unterpfad}.js`)
}

export function loeseRuntimePfad(spez: string, distVerzeichnis: string, deps: RuntimePfadDeps): string {
  let ersterFehler: unknown
  try {
    return deps.resolve(spez)
  } catch (err) {
    ersterFehler = err
  }
  const fallback = workspaceRuntimePfad(spez, distVerzeichnis)
  if (fallback && deps.existsSync(fallback)) return fallback
  const grund = ersterFehler instanceof Error ? ersterFehler.message : String(ersterFehler)
  throw new Error(
    `Runtime-Pfad nicht aufloesbar (${spez}): require.resolve: ${grund}` +
    (fallback ? `; Workspace-Pfad fehlt: ${fallback}` : '') +
    `. Stelle sicher dass das Runtime-Package gebaut ist (pnpm --filter <paket> build).`,
  )
}
