/**
 * P22-T5 (W2b): Runtime-Daemon-Zugang ausstellen/widerrufen (Vertrag thought 462ccb13).
 *
 * WIE LOKAL: Der PC-Daemon liest seinen Zugang (synapse_api_url + synapse_api_token) aus ~/.synapse/file-watcher/config.json,
 *   die der Tray nach der TOTP-Anmeldung schreibt. Im Runtime-Container gibt es keinen Tray; deshalb schreibt die API dieselben
 *   Felder in dieselbe Datei im Container (/root/.synapse/file-watcher/config.json, Bind <root>/home, persistent), Rechte 0600,
 *   fremde Felder bleiben. Der Daemon braucht so keinen neuen API-Client.
 * GEHEIMNIS: Der Klartext geht NUR ueber stdin von docker exec in den Container (nie argv, Log, Antwort, Status, Modellkontext).
 * BINDUNG wie Tray: daemon_restore_host_bindings token_hash -> Container-Hostname (container_name, docker --hostname, T4).
 * REIHENFOLGE: Token ausstellen -> in den Container schreiben -> binden (alter Token faellt in derselben Transaktion weg).
 *   Scheitert das Schreiben, wird der neue Token verworfen und der alte Zugang bleibt unveraendert wirksam.
 * Nur der User (Routen hinter guardInteractiveRuntimeRequest). Ausstellen nur bei Produkt-Schalter hauptagent EIN;
 * Widerrufen geht immer.
 */
import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  getPool, leseHauptagentSchalter, runtimeDaemonScope, bindeRuntimeDaemonZugang, widerrufeRuntimeDaemonZugang, runtimeDaemonZugangStatus,
  verwerfeRuntimeDaemonToken, ProfilVerwaltungFehler, type RuntimeDaemonZugangStatus,
} from '@synapse/core';
import { issueServiceToken, SERVICE_TOKEN_TTL_MS } from '../auth.js';

/** Datei im Container, die der Daemon (config.ts loadConfig/leseApiZugang) liest. */
export const RUNTIME_DAEMON_CONFIG_PFAD = '/root/.synapse/file-watcher/config.json';

/** Adresse der API aus Sicht des Containers (proxynet, wie claude-driver SYNAPSE_HAUPTAGENT_MCP_URL). */
export function runtimeDaemonApiUrl(): string {
  return (process.env.SYNAPSE_RUNTIME_DAEMON_API_URL || 'http://synapse-api:3456').replace(/\/+$/, '');
}

/**
 * Mischt die Felder von stdin in config.json (null loescht ein Feld). Kaputte/fremdartige Datei -> Exit 3, nichts geschrieben,
 * damit kein Fremdfeld (z. B. eines spaeteren Startprofils) verloren geht.
 */
export const CONFIG_SCHREIB_SKRIPT = [
  "const fs=require('fs'),path=require('path'),p=process.argv[1];let e='';",
  "process.stdin.on('data',d=>{e+=d;}).on('end',()=>{",
  "const n=JSON.parse(e);let c={};",
  "if(fs.existsSync(p)){try{c=JSON.parse(fs.readFileSync(p,'utf8'));}catch{process.exit(3);}if(!c||typeof c!=='object'||Array.isArray(c))process.exit(3);}",
  "for(const [k,v] of Object.entries(n)){if(v===null)delete c[k];else c[k]=v;}",
  "fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const t=p+'.tmp';",
  "fs.writeFileSync(t,JSON.stringify(c,null,2),{mode:0o600});fs.chmodSync(t,0o600);fs.renameSync(t,p);});",
].join('');

export type ContainerSchreiber = (containerName: string, felder: Record<string, string | null>) => Promise<void>;
export type ContainerPruefer = (containerName: string) => Promise<boolean>;

let dockerClient: Docker | null = null;
function getDocker(): Docker {
  if (!dockerClient) dockerClient = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  return dockerClient;
}

async function containerLaeuftDocker(containerName: string): Promise<boolean> {
  try { return (await getDocker().getContainer(containerName).inspect()).State?.Running === true; } catch { return false; }
}

/** Muster artefakt-tool schreibeContainerDatei: direktes Cmd, Inhalt nur ueber stdin. */
async function schreibeConfigDocker(containerName: string, felder: Record<string, string | null>): Promise<void> {
  const docker = getDocker();
  const exec = await docker.getContainer(containerName).exec({
    Cmd: ['node', '-e', CONFIG_SCHREIB_SKRIPT, RUNTIME_DAEMON_CONFIG_PFAD],
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  stdout.resume();
  stderr.resume();
  stream.end(Buffer.from(JSON.stringify(felder), 'utf8'));
  await new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
  const info = await exec.inspect();
  // Kein stderr-Text in den Fehler: er koennte Teile der Eingabe enthalten.
  if (info.ExitCode !== 0) throw new ProfilVerwaltungFehler(info.ExitCode === 3 ? 'container_config_unlesbar' : 'container_config_nicht_geschrieben', { exit: info.ExitCode });
}

export interface DaemonZugangDeps {
  schreibe?: ContainerSchreiber;
  laeuft?: ContainerPruefer;
  ausstellen?: (scope: string, label: string) => Promise<{ token: string }>;
}

const USER = { art: 'user' } as const;

async function containerName(runtime: string): Promise<string> {
  const r = await getPool().query<{ container_name: string }>('SELECT container_name FROM agent_runtime_instances WHERE runtime=$1', [runtime]);
  if (!r.rows[0]) throw new ProfilVerwaltungFehler('runtime_unbekannt');
  return r.rows[0].container_name;
}

export async function leseRuntimeDaemonZugang(runtime: string): Promise<RuntimeDaemonZugangStatus> {
  return runtimeDaemonZugangStatus(runtime);
}

export async function stelleRuntimeDaemonZugangAus(runtime: string, grund: unknown, deps: DaemonZugangDeps = {}): Promise<RuntimeDaemonZugangStatus> {
  const schalter = await leseHauptagentSchalter();
  if (!schalter.aktiv) throw new ProfilVerwaltungFehler('funktion_aus', { funktion: 'hauptagent', quelle: schalter.quelle });
  const scope = runtimeDaemonScope(runtime);
  if (typeof grund !== 'string' || grund.trim().length < 5) throw new ProfilVerwaltungFehler('grund_fehlt');
  const name = await containerName(runtime);
  if (!(await (deps.laeuft ?? containerLaeuftDocker)(name))) throw new ProfilVerwaltungFehler('container_nicht_bereit', { container: name });
  const neu = await (deps.ausstellen ?? ((s, l) => issueServiceToken(s, l, SERVICE_TOKEN_TTL_MS)))(scope, 'runtime-daemon ' + runtime);
  const hash = createHash('sha256').update(neu.token).digest('hex');
  try {
    await (deps.schreibe ?? schreibeConfigDocker)(name, { synapse_api_url: runtimeDaemonApiUrl(), synapse_api_token: neu.token });
    return await bindeRuntimeDaemonZugang(USER, { runtime, token_hash: hash, grund });
  } catch (err) {
    await verwerfeRuntimeDaemonToken(runtime, hash).catch(() => undefined);
    throw err;
  }
}

/** Widerruf wirkt in PG sofort; das Entfernen aus der Container-Datei ist Nachpflege und darf scheitern (container_bereinigt). */
export async function widerrufeRuntimeDaemonZugangKomplett(runtime: string, grund: unknown, deps: DaemonZugangDeps = {}): Promise<RuntimeDaemonZugangStatus & { container_bereinigt: boolean }> {
  const status = await widerrufeRuntimeDaemonZugang(USER, { runtime, grund });
  let bereinigt = false;
  try {
    const name = await containerName(runtime);
    if (await (deps.laeuft ?? containerLaeuftDocker)(name)) {
      await (deps.schreibe ?? schreibeConfigDocker)(name, { synapse_api_token: null });
      bereinigt = true;
    }
  } catch { /* Token ist in PG bereits ungueltig */ }
  return { ...status, container_bereinigt: bereinigt };
}
