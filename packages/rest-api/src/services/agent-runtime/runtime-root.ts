/**
 * EINE Quelle fuer das Basis-Verzeichnis der Agent-Runtimes — vorher stand
 * derselbe String an vier Stellen (repository.ts, beide Driver).
 *
 * ⚠️ WARUM KONFIGURIERBAR UND WARUM DIE WACHE (GEMESSEN 26.08.2026, Channel
 * 19208): auf dem Unraid-Host ist /mnt/user KEIN Share-Overlay, sondern ein
 * Ordner auf rootfs — also RAM. 927 MB Runtime-Installation samt
 * claude.ai-Anmeldung haetten einen Neustart nicht ueberlebt, und zehn Tage
 * lang hat es niemand gemerkt. Neu angelegte Runtimes duerfen deshalb NIE
 * wieder still auf einem fluechtigen Dateisystem landen.
 */
import type Docker from 'dockerode';

/**
 * Vorgabe: echter ZFS-Pool. Der Umzug ist am 26.08.2026 nach
 * /mnt/z/dockdata/synapse-agent-runtime passiert (live bestaetigt, Channel
 * 19210/19211) — beide Runtimes laufen von dort. Per ENV aenderbar.
 */
export function agentRuntimeBasisRoot(): string {
  return (process.env.SYNAPSE_AGENT_RUNTIME_ROOT || '/mnt/z/dockdata/synapse-agent-runtime').replace(/\/+$/, '');
}

/** Dateisystemtypen, die einen Neustart nicht ueberleben. */
export const FLUECHTIGE_DATEISYSTEME = new Set(['tmpfs', 'ramfs', 'rootfs']);

/**
 * Ermittelt den Dateisystemtyp eines HOST-Pfads. Der API-Container hat den
 * Host nicht gemountet — ein direktes stat saehe nur das eigene Overlay.
 * Deshalb ein Wegwerf-Container mit dem (ohnehin gezogenen) Runtime-Image,
 * der Pfad read-only eingebunden, `stat -f -c %T`, ohne Netz.
 */
export async function ermittleHostDateisystemTyp(docker: Docker, image: string, hostPfad: string): Promise<string> {
  const container = await docker.createContainer({
    Image: image,
    Cmd: ['stat', '-f', '-c', '%T', '/synapse-persistenz-probe'],
    Tty: true,
    HostConfig: {
      Binds: [hostPfad + ':/synapse-persistenz-probe:ro'],
      NetworkMode: 'none',
      AutoRemove: false,
    },
  });
  try {
    await container.start();
    await container.wait();
    const logs = await container.logs({ stdout: true, stderr: true }) as unknown as Buffer;
    return logs.toString('utf8').trim().split('\n').pop()?.trim() ?? '';
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

/**
 * ⭐ Persistenz-Wache: wirft LAUT, wenn das Ziel im RAM liegt. Ist der Typ
 * nicht messbar (Docker-Fehler), wird gewarnt statt blockiert — aber nie still.
 */
export async function pruefeRuntimeRootPersistenz(docker: Docker, image: string, root: string): Promise<void> {
  let typ = '';
  try {
    typ = await ermittleHostDateisystemTyp(docker, image, root);
  } catch (error) {
    console.warn('[AgentRuntime] Persistenz-Pruefung fuer ' + root + ' nicht moeglich: ' + (error instanceof Error ? error.message : String(error)));
    return;
  }
  if (FLUECHTIGE_DATEISYSTEME.has(typ)) {
    throw new Error(
      'Runtime-Verzeichnis ' + root + ' liegt auf einem FLUECHTIGEN Dateisystem (' + typ + ' = RAM) '
      + 'und wuerde einen Neustart nicht ueberleben. Zielpfad aendern (SYNAPSE_AGENT_RUNTIME_ROOT bzw. rootPath) '
      + 'oder den Speicherort als echten Pool/Share anlegen. (Hintergrund: Channel 19208, 26.08.2026)',
    );
  }
  if (!typ) {
    console.warn('[AgentRuntime] Persistenz-Pruefung fuer ' + root + ': Dateisystemtyp leer — bitte manuell pruefen.');
  }
}
