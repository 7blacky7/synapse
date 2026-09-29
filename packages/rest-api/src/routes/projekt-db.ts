/**
 * Synapse API — Projekt-DB-Route
 *
 * POST /api/projects/:name/projekt-db legt die Projekt-DB auf der Unraid-Projekt-
 * Instanz an (192.168.50.65:5433): docker exec psql im Container postgresql16_2 ueber
 * den gemounteten docker.sock — lokaler Socket, kein Passwort, kein SSH. Konfig aus
 * /run/secrets/projektdb.env (SYNAPSE_PROJEKTDB_ENV). Fehlt sie: "nicht_konfiguriert".
 *
 * Die Zugangsdaten liegen in projekt_datenbanken (Spielwiese, Klartext gewollt); die
 * Antwort liefert sie als "zugang", damit der Daemon DATABASE_URL in <projekt>/.env
 * schreiben kann. project init (REST) ruft stelleProjektDbSicher direkt auf — die
 * Anlage haengt also nicht am Daemon. Auth: /api/* ist Bearer-gated.
 */

import { FastifyInstance } from 'fastify';
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import {
  isValidProjectName,
  ladeProjektDbKonfig,
  legeProjektDbAn,
  leseProjektDbZugang,
  type ProjektDbAnlage,
  type ProjektDbKonfig,
  type PsqlAusfuehrer,
} from '@synapse/core';

const PSQL_TIMEOUT_MS = 60_000;

let dockerClient: Docker | null = null;
function getDocker(): Docker {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }
  return dockerClient;
}

/** psql per docker exec im Projekt-DB-Container; SQL ueber stdin, nie in der Kommandozeile. */
export function dockerPsqlAusfuehrer(konfig: ProjektDbKonfig): PsqlAusfuehrer {
  return async (sql, datenbank) => {
    const docker = getDocker();
    const exec = await docker.getContainer(konfig.container).exec({
      Cmd: ['psql', '-X', '-q', '-tA', '-U', konfig.adminUser, '-d', datenbank, '-v', 'ON_ERROR_STOP=1'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);
    let aus = '';
    let fehler = '';
    stdout.on('data', (chunk: Buffer) => { aus += chunk.toString('utf8'); });
    stderr.on('data', (chunk: Buffer) => { fehler += chunk.toString('utf8'); });
    stream.end(sql);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('psql-Timeout nach ' + PSQL_TIMEOUT_MS + ' ms')), PSQL_TIMEOUT_MS);
      stream.once('end', () => { clearTimeout(timer); resolve(); });
      stream.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
    });
    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      throw new Error('psql Exit ' + String(info.ExitCode) + (fehler ? ': ' + fehler.slice(0, 300) : ''));
    }
    return aus;
  };
}

const nichtKonfiguriert: PsqlAusfuehrer = async () => {
  throw new Error('Projekt-DB nicht konfiguriert.');
};

/** Legt die Projekt-DB an, falls noch keine existiert. Wirft nie; Ergebnis ohne Passwort. */
export async function stelleProjektDbSicher(name: string, projektPfad?: string): Promise<ProjektDbAnlage> {
  const konfig = ladeProjektDbKonfig();
  const { passwort: _passwort, ...ergebnis } = await legeProjektDbAn(
    name,
    konfig ? dockerPsqlAusfuehrer(konfig) : nichtKonfiguriert,
    { konfig, projektPfad },
  );
  return ergebnis;
}

export async function projektDbRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { name: string }; Body: { projekt_pfad?: string } | undefined }>(
    '/api/projects/:name/projekt-db',
    async (request, reply) => {
      const { name } = request.params;
      if (!isValidProjectName(name)) {
        return reply.status(400).send({ success: false, error: { message: `Projekt-Name "${name}" ist ungueltig.` } });
      }
      const projektPfad = typeof request.body?.projekt_pfad === 'string' ? request.body.projekt_pfad : undefined;
      const ergebnis = await stelleProjektDbSicher(name, projektPfad);
      const zugang = await leseProjektDbZugang(name).catch(() => null);
      reply.header('Cache-Control', 'no-store');
      return { success: ergebnis.status === 'angelegt' || ergebnis.status === 'vorhanden', projekt_db: ergebnis, zugang };
    },
  );
}
