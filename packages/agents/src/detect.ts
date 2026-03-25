// packages/agents/src/detect.ts
import { execSync } from 'node:child_process'

export interface ClaudeCliInfo {
  available: boolean
  path: string | null
  version: string | null
  models: string[]
}

export function detectClaudeCli(): ClaudeCliInfo {
  try {
    const path = execSync('which claude', { encoding: 'utf-8' }).trim()
    if (!path) {
      return { available: false, path: null, version: null, models: [] }
    }

    let version: string | null = null
    try {
      version = execSync('claude --version', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
    } catch {
      // Version nicht ermittelbar, CLI aber vorhanden
    }

    return {
      available: true,
      path,
      version,
      models: ['opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'],
    }
  } catch {
    return { available: false, path: null, version: null, models: [] }
  }
}
