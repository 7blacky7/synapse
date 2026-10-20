/**
 * P22-T58 (Nachtrag 5045840e, Befund P22-T4): EINE Lesestelle fuer das Neuanlegen eines Runtime-Containers aus dem
 * Agent-Runtime-Image (P22-T4, synapse-agent-runtime). Exakt wie der U4-Ablauf (thought 791212a9 Schritt 2c):
 *   kein Cmd (das Image startet runtime-main als CMD), kein Hostname, Init, read-only rootfs, /tmp als exec-tmpfs,
 *   CapDrop ALL, no-new-privileges, PID-/Speichergrenze, json-file-Log 1g x3, restart no, workdir /projects,
 *   Labels inkl. synapse.runtime-image=agent-runtime, Mounts <root>/{home,projects,state,attachments},
 *   Env HOME, SSL_CERT_FILE, je Runtime CLAUDE_CONFIG_DIR+NODE_EXTRA_CA_CERTS bzw. CODEX_HOME, SYNAPSE_DAEMON_PROFIL=runtime,
 *   SYNAPSE_RUNTIME_NAME, SYNAPSE_RUNTIME_CLI_AUTOUPDATE (immer 0: Update aus der API, Nachtrag 2), SYNAPSE_RUNTIME_CLI_BEHALTEN.
 * Grenzwerte und CLI-Verhalten kommen aus den Einstellungen der Runtime-Ueberwachung (Code-Standard = U4-Werte, Regel 7).
 * Netzwerk bleibt Infrastruktur (Env AGENT_RUNTIME_DOCKER_NETWORK wie bisher). Das alte Image node:22-bookworm-slim behaelt in
 * den Drivern seinen bisherigen Weg (tail -f, Installation per setup).
 */
import type Docker from 'dockerode';
import { leseRuntimeUeberwachungWerte, type RuntimeUeberwachungWerte } from '@synapse/core';

export const AGENT_RUNTIME_IMAGE_NAME = 'synapse-agent-runtime';
export const AGENT_RUNTIME_IMAGE_LABEL = 'agent-runtime';

/** Image aus P22-T4 (Daemon im Container)? Registry-Praefix und Tag/Digest werden ignoriert. */
export function istAgentRuntimeImage(image: string | null | undefined): boolean {
  if (!image) return false;
  const letzter = image.split('/').pop() ?? '';
  return letzter.split(/[:@]/)[0] === AGENT_RUNTIME_IMAGE_NAME;
}

export type RuntimeContainerGrenzen = Pick<RuntimeUeberwachungWerte,
  'container_memory_mb' | 'container_pids_limit' | 'container_tmpfs_mb' | 'cli_behalten'>;

export async function leseRuntimeContainerGrenzen(): Promise<RuntimeContainerGrenzen> {
  return leseRuntimeUeberwachungWerte();
}

export function runtimeContainerSpez(
  runtime: 'claude' | 'codex',
  c: { containerName: string; image: string; root: string; binds: string[] },
  g: RuntimeContainerGrenzen,
): Docker.ContainerCreateOptions {
  const speicher = g.container_memory_mb * 1024 * 1024;
  return {
    name: c.containerName,
    Image: c.image,
    Labels: {
      'synapse.agent-runtime': 'true',
      'synapse.runtime': runtime,
      'synapse.agent-role': 'main',
      'synapse.runtime-root': c.root,
      'synapse.runtime-image': AGENT_RUNTIME_IMAGE_LABEL,
    },
    Env: [
      'HOME=/root',
      'SSL_CERT_FILE=/root/.local/share/ca-certificates.crt',
      ...(runtime === 'claude'
        ? ['CLAUDE_CONFIG_DIR=/root/.claude', 'NODE_EXTRA_CA_CERTS=/root/.local/share/ca-certificates.crt']
        : ['CODEX_HOME=/root/.codex']),
      'SYNAPSE_DAEMON_PROFIL=runtime',
      'SYNAPSE_RUNTIME_NAME=' + runtime,
      // F5 (User 9faa5c9f): das CLI-Update entscheidet die API (fuehreCliUpdatesAus), nicht der Daemon im Container.
      'SYNAPSE_RUNTIME_CLI_AUTOUPDATE=0',
      'SYNAPSE_RUNTIME_CLI_BEHALTEN=' + String(g.cli_behalten),
    ],
    WorkingDir: '/projects',
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      NetworkMode: process.env.AGENT_RUNTIME_DOCKER_NETWORK || 'proxynet',
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
      Init: true,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      Binds: c.binds,
      Memory: speicher,
      MemorySwap: speicher,
      PidsLimit: g.container_pids_limit,
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'size=' + String(g.container_tmpfs_mb) + 'm,exec' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1g', 'max-file': '3' } },
    },
  };
}
