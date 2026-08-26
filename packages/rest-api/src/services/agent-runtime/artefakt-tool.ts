/**
 * artefakt-Tool (Serverseite) — Orchestrierung fuer das Hauptagenten-Werkzeug.
 *
 * REIHENFOLGE IST VERTRAG: 1. PG-Zeile (die WAHRHEIT, Auflage 26.08.2026),
 * 2. HTML-Datei + Livebild in den Runtime-Container (nur ABBILD — darf einzeln
 * scheitern, dann laut im hinweis, nie still), 3. Zustellung als SSE-Event
 * `artifact` in den offenen Strom derselben Session (kein Broadcast).
 *
 * ABLAGEORT: heute /attachments/artefakte im Runtime-Container (Host:
 * /mnt/user/synapse-agent-runtime/<cli>/attachments/artefakte), weil der
 * geplante Share /mnt/user/synapse-artefakte/ NOCH NICHT existiert ("die
 * anderen Shares kommen spaeter", Nutzer 26.08.2026). Der Umzug ist dann eine
 * Env-Zeile: SYNAPSE_ARTEFAKT_ROOT (plus Bind im Runtime-Container).
 *
 * NETZWEG (gemessen 26.08.2026): synapse-api, ki-browser und die Runtime-
 * Container haengen im selben proxynet — DNS-Namen benutzen, nie IPs.
 */
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import {
  getPool,
  speichereArtefakt,
  aktualisiereArtefaktPfade,
  type ArtefaktZeile,
} from '@synapse/core';
import { emitArtifact } from './artifact-stream.js';

function meldung(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function ganzzahl(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function artefaktRoot(): string {
  return (process.env.SYNAPSE_ARTEFAKT_ROOT || '/attachments/artefakte').replace(/\/+$/, '');
}

function kiBrowserUrl(): string {
  return (process.env.SYNAPSE_KI_BROWSER_URL || 'http://ki-browser:9222').replace(/\/+$/, '');
}

let dockerClient: Docker | null = null;
function getDocker(): Docker {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }
  return dockerClient;
}

interface SessionKontext {
  sessionId: string;
  runtime: string;
  containerName: string;
}

async function ladeSessionKontext(sessionId: string): Promise<SessionKontext | null> {
  const result = await getPool().query(
    `SELECT s.id AS session_id, s.runtime, i.container_name
       FROM agent_runtime_sessions s
       JOIN agent_runtime_instances i ON i.runtime = s.runtime
      WHERE s.id = $1`,
    [sessionId],
  );
  const row = result.rows[0] as { session_id: string; runtime: string; container_name: string } | undefined;
  if (!row) return null;
  return { sessionId: row.session_id, runtime: row.runtime, containerName: row.container_name };
}

/**
 * Datei per docker-exec in den Runtime-Container schreiben. Direktes Cmd ohne
 * '&'-Hintergrundjob — die stdin-/dev/null-Falle (claude-driver.ts, behoben
 * 26.08.2026) gibt es hier konstruktiv nicht.
 */
async function schreibeContainerDatei(containerName: string, pfad: string, inhalt: Buffer): Promise<void> {
  const docker = getDocker();
  const container = docker.getContainer(containerName);
  const verzeichnis = pfad.slice(0, pfad.lastIndexOf('/'));
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', 'mkdir -p "$1" && cat > "$2"', 'synapse-artefakt', verzeichnis, pfad],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  let fehlerText = '';
  stdout.resume();
  stderr.on('data', (chunk: Buffer) => { fehlerText += chunk.toString('utf8'); });
  stream.end(inhalt);
  await new Promise<void>((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
  const info = await exec.inspect();
  if (info.ExitCode !== 0) {
    throw new Error('Schreiben nach ' + pfad + ' endete mit Exit ' + String(info.ExitCode) + (fehlerText ? ': ' + fehlerText.slice(0, 300) : ''));
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function fetchJson(url: string, init: { method?: string; body?: string }): Promise<Record<string, unknown>> {
  const antwort = await fetch(url, { ...init, headers: JSON_HEADERS, signal: AbortSignal.timeout(10_000) });
  const text = await antwort.text();
  if (!antwort.ok) throw new Error(url + ' -> HTTP ' + String(antwort.status) + ' ' + text.slice(0, 200));
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * ⭐ Livebild: HTML im ki-browser rendern (data:-URL, kein Datei-Mount noetig),
 * PNG zurueck. Transientenregel: ein einzelner Fehlschlag ist KEIN Befund,
 * 2-3 Versuche; ein Mini-PNG (~69 Bytes, 1x1) heisst "noch nicht bereit".
 * Scheitert alles, wirft die Funktion — der Aufrufer liefert das Artefakt dann
 * OHNE Vorschaubild aus und sagt es laut im hinweis.
 */
async function renderLivebild(html: string): Promise<Buffer> {
  const basis = kiBrowserUrl();
  const dataUrl = 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');
  const neuerTab = await fetchJson(basis + '/tabs/new', { method: 'POST', body: JSON.stringify({ url: dataUrl, active: false }) });
  // GEMESSEN 26.08.2026 (E2E-Probe): die Antwort ist {success:true, data:{tab_id:...}}
  // — tab_id steckt UNTER data, nicht auf oberster Ebene.
  const tabDaten = (neuerTab.data ?? neuerTab) as Record<string, unknown>;
  const tabId = typeof tabDaten.tab_id === 'string' ? tabDaten.tab_id : typeof tabDaten.id === 'string' ? tabDaten.id : '';
  if (!tabId) throw new Error('/tabs/new lieferte keine tab_id: ' + JSON.stringify(neuerTab).slice(0, 200));
  try {
    let letzterFehler: Error | null = null;
    for (let versuch = 1; versuch <= 3; versuch++) {
      await new Promise((resolve) => setTimeout(resolve, versuch * 700));
      const antwort = await fetch(
        basis + '/screenshot?tab_id=' + encodeURIComponent(tabId) + '&format=png&full_page=true&raw=true',
        { signal: AbortSignal.timeout(15_000) },
      );
      const puffer = Buffer.from(await antwort.arrayBuffer());
      // raw=true SOLL binaer liefern; falls doch JSON kommt ({success,data:{data:base64}}),
      // Base64 auspacken statt still ein JSON als "PNG" zu speichern.
      let png = puffer;
      if (puffer.length > 0 && puffer[0] === 0x7b) {
        try {
          const json = JSON.parse(puffer.toString('utf8')) as Record<string, unknown>;
          const inner = (json.data ?? json) as Record<string, unknown>;
          const b64 = typeof inner.data === 'string' ? inner.data : '';
          if (b64) png = Buffer.from(b64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
        } catch {
          // bleibt beim Rohpuffer — der PNG-Magic-Check unten faengt es
        }
      }
      // 0x89 = PNG-Magic; ein Mini-PNG (~69 Bytes, 1x1) heisst "noch nicht bereit".
      if (antwort.ok && png.length > 100 && png[0] === 0x89) return png;
      letzterFehler = new Error('/screenshot Versuch ' + String(versuch) + ': HTTP ' + String(antwort.status) + ', ' + String(puffer.length) + ' Bytes' + (png !== puffer ? ' (JSON-Antwort ohne brauchbares Base64)' : ''));
    }
    throw letzterFehler ?? new Error('Livebild scheiterte ohne Fehlermeldung');
  } finally {
    await fetch(basis + '/tabs/close', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tab_id: tabId }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

export async function zeigeArtefakt(args: Record<string, unknown>, agentId?: string): Promise<unknown> {
  const action = typeof args.action === 'string' ? args.action : '';
  if (action !== 'zeigen') {
    return { success: false, error: 'unbekannte_action', message: 'artefakt kennt nur action:"zeigen" (erster Schritt: EIN Block je Aufruf).' };
  }
  const sessionId = str(args, 'session_id');
  if (!sessionId) {
    return {
      success: false,
      error: 'kein_hauptagent_kontext',
      message: 'artefakt ist nur aus einer Hauptagenten-Session aufrufbar — die Session-Bindung setzt der Server aus dem Header X-Synapse-Hauptagent-Session.',
    };
  }
  const kontext = await ladeSessionKontext(sessionId);
  if (!kontext) {
    return { success: false, error: 'session_unbekannt', message: 'Session ' + sessionId + ' existiert nicht in agent_runtime_sessions.' };
  }

  // 1. PG zuerst — die Zeile ist die Wahrheit. Datei/Livebild/Strom sind Abbilder
  //    und duerfen einzeln scheitern, ohne dass das Artefakt verloren geht.
  let zeile: ArtefaktZeile;
  try {
    zeile = await speichereArtefakt({
      sessionId,
      html: typeof args.html === 'string' ? args.html : '',
      titel: str(args, 'titel'),
      artefaktId: str(args, 'artefakt_id'),
      column: ganzzahl(args, 'column'),
      columnSpan: ganzzahl(args, 'columnSpan'),
      row: ganzzahl(args, 'row'),
      rowSpan: ganzzahl(args, 'rowSpan'),
      minHeight: ganzzahl(args, 'minHeight'),
      createdBy: agentId ?? null,
    });
  } catch (error) {
    return { success: false, error: 'artefakt_ungueltig', message: meldung(error) };
  }

  const hinweise: string[] = [];
  const basisPfad = artefaktRoot() + '/' + zeile.id;
  let htmlPfad: string | null = basisPfad + '.html';
  let bildPfad: string | null = null;

  try {
    await schreibeContainerDatei(kontext.containerName, htmlPfad, Buffer.from(zeile.html, 'utf8'));
  } catch (error) {
    htmlPfad = null;
    hinweise.push('HTML-Datei nicht geschrieben: ' + meldung(error) + ' — die PG-Zeile bleibt die Wahrheit, das Artefakt existiert.');
  }

  try {
    const png = await renderLivebild(zeile.html);
    const zielPfad = basisPfad + '.png';
    await schreibeContainerDatei(kontext.containerName, zielPfad, png);
    bildPfad = zielPfad;
  } catch (error) {
    hinweise.push('Livebild uebersprungen: ' + meldung(error));
  }

  await aktualisiereArtefaktPfade(zeile.id, htmlPfad, bildPfad).catch((error) => {
    hinweise.push('Pfad-Update in PG scheiterte: ' + meldung(error));
  });

  // 3. Zustellung NUR in den offenen Strom derselben Session (kein Broadcast —
  //    ⭐ Ablegen und Anpingen sind zwei getrennte Schritte). Feldnamen exakt
  //    AgentArtifactEvent/AgentHtmlBlock (Channel 19189/19193).
  const event: Record<string, unknown> = { id: zeile.id, html: zeile.html, revision: zeile.revision };
  if (zeile.title !== null) event.title = zeile.title;
  if (zeile.column !== null) event.column = zeile.column;
  if (zeile.columnSpan !== null) event.columnSpan = zeile.columnSpan;
  if (zeile.row !== null) event.row = zeile.row;
  if (zeile.rowSpan !== null) event.rowSpan = zeile.rowSpan;
  if (zeile.minHeight !== null) event.minHeight = zeile.minHeight;
  if (bildPfad) event.preview_path = bildPfad;
  const zugestellt = emitArtifact(sessionId, event);
  if (!zugestellt) {
    hinweise.push('Kein offener Nachrichten-Strom fuer diese Session — das Artefakt liegt in PG (und als Datei) bereit.');
  }

  return {
    success: true,
    artefakt_id: zeile.id,
    revision: zeile.revision,
    html_pfad: htmlPfad,
    bild_pfad: bildPfad,
    stream_zugestellt: zugestellt,
    ...(hinweise.length ? { hinweise } : {}),
  };
}
