/**
 * P22-T66: Modell-Registry fuer einen Wrapper ohne Datenbank (Transport api, z. B. im Runtime-Container). Ohne diese Quelle
 * versucht loadFromDb eine lokale PG (ECONNREFUSED 127.0.0.1:5432) und rechnet mit STATIC_FALLBACK statt mit der Registry.
 * Weg wie der Daemon (spezialisten-datenweg-api holeModelleApi): POST /api/daemon/specialist/daten, aktion 'modelle', mit dem
 * Daemon-Zugang, den der Spawner dem Wrapper mitgibt (SYNAPSE_API_URL + SYNAPSE_API_TOKEN). host wie der Daemon selbst
 * (daemon-jobs-api daemonHost): synapse-runtime-<SYNAPSE_RUNTIME_NAME> im Container, sonst der Hostname; die API prueft bei
 * 'modelle' nur die Hostbindung des Zugangs und die Form daemon-<host>-<pid>.
 */
import os from 'node:os'
import type { ModellRegistryZeilen } from './models.js'

const ZEITLIMIT_MS = 10_000

/** Quelle fuer setzeModellQuelle oder null, wenn der Wrapper keinen API-Zugang hat. */
export function modellQuelleUeberApi(env: NodeJS.ProcessEnv = process.env): (() => Promise<ModellRegistryZeilen>) | null {
  const url = (env.SYNAPSE_API_URL ?? '').trim().replace(/\/+$/, '')
  const token = (env.SYNAPSE_API_TOKEN ?? '').trim()
  if (!url || !token) return null
  const runtime = (env.SYNAPSE_RUNTIME_NAME ?? '').trim()
  const host = runtime ? `synapse-runtime-${runtime}` : os.hostname()
  return async () => {
    const antwort = await fetch(`${url}/api/daemon/specialist/daten`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ host, daemon_id: `daemon-${host}-${process.pid}`, aktion: 'modelle' }),
      signal: AbortSignal.timeout(ZEITLIMIT_MS),
    })
    if (!antwort.ok) throw new Error(`Modell-Registry der API: HTTP ${antwort.status}`)
    const daten = (await antwort.json()) as { modelle?: ModellRegistryZeilen }
    if (!Array.isArray(daten.modelle)) throw new Error('Modell-Registry der API ohne Liste')
    return daten.modelle
  }
}
