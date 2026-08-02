/**
 * Synapse MCP - Specialist, Channel & Inbox Tools
 * Wrapper-Funktionen fuer die @synapse/agents Integration
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { removeInboxForAgent, removeWrapperStatus, upsertWrapperStatus } from '@synapse/core';

import {
  bereiteMcpBrueckeVor,
  selbsttestHinweis,
  widerrufeWrapperTokens,
  McpBrueckeFehler,
} from './mcp-bruecke.js';

import {
  detectClaudeCli,
  canSpawn,
  ensureAgentDir,
  erzeugeWissen,
  readSkill,
  readStatus,
  updateSpecialist,
  removeSpecialist,
  purgeAgentDir,
  buildSpecialistPrompt,
  heartbeatController,
  ensureGeneralChannel,
  joinChannel,
  leaveChannel,
  removeAgentFromAllChannels,
  unregisterAgent,
  createChannel,
  postMessage,
  getMessages,
  listChannels,
  getChannelMembers,
  postToInbox,
  checkInbox,
  readAllSkillFiles,
  appendToSkillFile,
  readSkillFile,
  writeSkillFile,
  migrateSkillMd,
  createInitialAgent,
  type SkillFile,
  type SpecialistConfig,
  type SpecialistStatus,
} from '@synapse/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWrapperPath(): string {
  // ESM-compatible resolution: use createRequire to locate the wrapper binary
  const require = createRequire(import.meta.url);
  return require.resolve('@synapse/agents/dist/wrapper.js');
}

function jsonResult(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// spawn_specialist
// ---------------------------------------------------------------------------

export async function spawnSpecialistTool(
  name: string,
  model: SpecialistConfig['model'] | string,
  expertise: string,
  task: string,
  project: string,
  projectPath: string,
  cwd?: string,
  channel?: string,
  allowedTools?: string[],
  keepAlive?: boolean,
) {
  // 1. Modell aufloesen + provider-spezifische Checks
  const { resolveModel, listAliases } = await import('@synapse/agents');
  const modelEntry = resolveModel(model);
  if (!modelEntry) {
    return jsonResult({
      success: false,
      message: `Unbekanntes Modell-Alias "${model}". Verfuegbar: ${listAliases().join(', ')}`,
    });
  }

  // 2a. Provider-spezifischer Binary-Check
  if (modelEntry.binary === 'claude') {
    const cliInfo = detectClaudeCli();
    if (!cliInfo.available) {
      return jsonResult({
        success: false,
        message: 'Claude CLI nicht gefunden. Installiere claude (npm i -g @anthropic-ai/claude-code) und stelle sicher, dass "claude" im PATH ist.',
      });
    }
  }
  // (binary='node': process.ts macht require.resolve, eigene Error wenn fail)

  // 2b. ENV-Pre-Spawn-Check (S4 — verhindert Endlos-Respawn-Loop bei fehlendem API-Key)
  if (modelEntry.envRequired.length > 0) {
    const useEmbeddingKey = (process.env.SYNAPSE_GEMINI_USE_EMBEDDING_KEY ?? 'true').toLowerCase() !== 'false';
    const missing = modelEntry.envRequired.filter(envName => {
      // Wenn USE_EMBEDDING_KEY=true, ist GOOGLE_API_KEY ueber ENV verfuegbar
      // Sonst muss er in provider_credentials stehen (Check passiert in der Runtime)
      if (envName === 'GOOGLE_API_KEY' && useEmbeddingKey) {
        return !process.env.GOOGLE_API_KEY;
      }
      return !process.env[envName];
    });
    if (missing.length > 0) {
      return jsonResult({
        success: false,
        message: `Modell "${model}" (provider: ${modelEntry.provider}) benoetigt ENV-Variablen: ${missing.join(', ')}. Setze sie oder konfiguriere SYNAPSE_GEMINI_USE_EMBEDDING_KEY=false + provider_credentials-Tabelle.`,
      });
    }
  }

  // 3. Limit pruefen
  const spawnCheck = await canSpawn(projectPath);
  if (!spawnCheck.ok) {
    return jsonResult({
      success: false,
      message: spawnCheck.reason ?? 'Specialist-Limit erreicht.',
    });
  }

  // 3. Agent-Verzeichnis erstellen
  // Bleibt auch im api-Modus: hier liegen die Wrapper-Logs (Schritt 9), und die
  // schreibt dieser Prozess, nicht der Wrapper. Das Verzeichnis ist damit kein
  // Wissensspeicher mehr, sondern nur noch ein Logordner.
  await ensureAgentDir(projectPath, name);

  // 3b. Wissensschicht: woher kommt das Wissen dieses Spezialisten?
  //     Vorgabe 'datei' — dann passiert unten Zeichen fuer Zeichen dasselbe wie
  //     bisher (dieselben Funktionen aus @synapse/agents, kein Nachbau).
  const wissen = erzeugeWissen({
    projekt: project,
    projektPfad: projectPath,
    promptPfad: join(projectPath, '.synapse', 'agents', name, 'system-prompt.txt'),
    log: (msg, ...args) => console.error(`[Synapse][wissen] ${msg}`, ...args),
  });

  // 4. Wissen anlegen (nur falls neu) und lesen.
  //    ⚠️ Das Anlegen entscheidet die Schicht selbst und ruehrt vorhandenes
  //    Wissen NICHT an. Vorher stand hier eine Fallunterscheidung beim Aufrufer
  //    ('nichts gelesen? dann anlegen') — die ist ueber zwei Aufrufe ein
  //    Wettlauf, den zwei gleichzeitige Spawns desselben Namens verlieren
  //    koennen, und der Verlierer waere das gelernte Wissen.
  const angelegt = await wissen.legeAn(name, model, expertise);
  const gelesen = await wissen.liesAlles(name);
  if (!gelesen) {
    return jsonResult({
      success: false,
      message:
        `Spawn abgebrochen — Wissen fuer "${name}" ist auch nach dem Anlegen nicht lesbar ` +
        `(Quelle: ${wissen.art}, anlegen: ${angelegt.grund}). Ohne Wissen bekaeme der Agent einen ` +
        `leeren Kopf, und das faellt spaeter niemandem auf.`,
    });
  }
  const skill = gelesen.text;

  // 5. System-Prompt bauen (memory entfaellt — context.md ist Teil der Skills)
  // model wird widened auf string fuer Provider-Erweiterung; SpecialistConfig
  // hat noch closed Claude-Union, deshalb hier cast.
  const config: SpecialistConfig = {
    name,
    model: model as SpecialistConfig['model'],
    expertise,
    task,
    project,
    cwd,
    channel,
    allowedTools,
  };
  let systemPrompt = buildSpecialistPrompt(config, skill);

  // 6b. MCP-Bruecke (Schritt 3b): bekommt der INNERE Claude seine Werkzeuge ueber
  //     HTTP statt ueber einen lokalen stdio-Prozess mit Datenbankverbindung?
  //     Vorgabe bleibt stdio. Schlaegt der verlangte HTTP-Weg fehl, bricht der
  //     Spawn hier ab — ein tauber Agent waere nicht als Defekt erkennbar.
  let mcpBruecke;
  try {
    mcpBruecke = await bereiteMcpBrueckeVor(projectPath, name);
  } catch (err) {
    if (err instanceof McpBrueckeFehler) {
      return jsonResult({
        success: false,
        message: `Spawn abgebrochen — MCP-Bruecke nicht benutzbar: ${err.message}`,
      });
    }
    throw err;
  }
  if (mcpBruecke.aktiv && mcpBruecke.werkzeuge) {
    systemPrompt += selbsttestHinweis(mcpBruecke.werkzeuge);
  }

  // 7. System-Prompt ablegen (zu gross fuer eine Umgebungsvariable).
  //    'datei': dieselbe Datei wie bisher. 'api': ueber die Wissens-Routen — dann
  //    liegt auf der Platte nichts mehr, was der Wrapper zum Starten braucht.
  const promptFile = join(projectPath, '.synapse', 'agents', name, 'system-prompt.txt');
  await wissen.legeSystemPromptAb(name, systemPrompt);

  // 8. General-Channel sicherstellen und Agent joinen
  await ensureGeneralChannel(project, name, name);
  if (channel && channel !== `${project}-general`) {
    await joinChannel(project, channel, name);
  }

  // 9. Wrapper als DETACHED Prozess starten
  const socketDir = join(projectPath, '.synapse', 'sockets');
  await mkdir(socketDir, { recursive: true });
  const socketPath = join(socketDir, `${name}.sock`);

  const wrapperPath = resolveWrapperPath();

  // Log-Datei fuer Wrapper-Stderr (Debugging)
  const logDir = join(projectPath, '.synapse', 'agents', name, 'logs');
  await mkdir(logDir, { recursive: true });
  const { openSync } = await import('node:fs');
  const logFd = openSync(join(logDir, 'wrapper.log'), 'a');

  const wrapper = spawn('node', [wrapperPath], {
    env: {
      ...process.env,
      SYNAPSE_AGENT_NAME: name,
      SYNAPSE_AGENT_MODEL: model,
      SYNAPSE_PROJECT_NAME: project,
      SYNAPSE_PROJECT_PATH: projectPath,
      SYNAPSE_SOCKET_PATH: socketPath,
      // ⚠️ Den Pfad gibt es nur im Vorgabe-Weg. Im api-Modus wird er BEWUSST nicht
      // gesetzt: ein alter Wrapper (eigener Prozess, laedt seinen Code beim Start —
      // die laufen nach einer Aenderung tagelang weiter) scheitert dann sofort und
      // sichtbar an validateEnv, statt still die Platte zu lesen und dabei wie eine
      // gelungene Umstellung auszusehen.
      ...(wissen.art === 'datei' ? { SYNAPSE_SYSTEM_PROMPT_FILE: promptFile } : {}),
      SYNAPSE_AGENT_CWD: cwd ?? projectPath,
      ...(allowedTools?.length ? { SYNAPSE_ALLOWED_TOOLS: allowedTools.join(',') } : {}),
      ...(keepAlive ? { SYNAPSE_KEEP_ALIVE: '1' } : {}),
      // Schritt 3b: eigene MCP-Konfiguration fuer den inneren Claude. Der Wrapper
      // reicht sie als --mcp-config <datei> --strict-mcp-config an die CLI weiter
      // (packages/agents/src/process.ts). Ist die Variable nicht gesetzt, gilt der
      // heutige Weg: die CLI erbt die .mcp.json der Maschine.
      ...(mcpBruecke.aktiv && mcpBruecke.configPfad
        ? { SYNAPSE_MCP_CONFIG_FILE: mcpBruecke.configPfad, SYNAPSE_MCP_STRICT: '1' }
        : {}),
    },
    detached: true,
    stdio: ['ignore', 'ignore', logFd],
  });
  wrapper.unref();

  const wrapperPid = wrapper.pid ?? 0;

  // 10. Kurz warten und dann verbinden
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    await heartbeatController.connectToWrapper(name, socketPath);
  } catch (err) {
    // Verbindung fehlgeschlagen — Wrapper koennte noch starten
    console.error(`[Synapse] Konnte nicht sofort zu Wrapper "${name}" verbinden: ${err}`);
  }

  // 11. Status aktualisieren — provider + modelFullId mit ablegen
  await updateSpecialist(projectPath, name, {
    name,
    model,
    status: 'running',
    pid: wrapperPid,
    wrapperPid,
    socket: socketPath,
    tokens: { input: 0, output: 0, percent: 0 },
    contextCeiling: modelEntry.contextWindow,
    lastActivity: new Date().toISOString(),
    channels: [channel ?? `${project}-general`],
    currentTask: task,
    provider: modelEntry.provider,
    modelFullId: modelEntry.fullId,
  } as Partial<SpecialistStatus>);

  // 11b. Initiale PG-Zeile schreiben (sofortige Cross-Process-Visibility).
  //      Wrapper ueberschreibt diese Row beim naechsten Heartbeat mit
  //      aktuellen Token-Werten. Try/catch: PG-Down darf Spawn nicht blockieren.
  try {
    await upsertWrapperStatus({
      agentName: name,
      project,
      wrapperPid,
      socketPath,
      model,
      modelFullId: modelEntry.fullId,
      provider: modelEntry.provider,
      status: 'running',
      busy: false,
      currentTask: task,
      contextCeiling: modelEntry.contextWindow,
      tokensInput: 0,
      tokensOutput: 0,
      tokensPercent: 0,
      channels: [channel ?? `${project}-general`],
      connectedMcp: false,
    });
  } catch (err) {
    console.error(`[Synapse] PG-Status-Init fuer "${name}" fehlgeschlagen (non-fatal): ${err}`);
  }

  return jsonResult({
    success: true,
    specialist: {
      name,
      model,
      modelFullId: modelEntry.fullId,
      provider: modelEntry.provider,
      expertise,
      task,
      project,
      wrapperPid,
      socket: socketPath,
      channel: channel ?? `${project}-general`,
      mcpBruecke,
    },
    message:
      `Spezialist "${name}" (${model} → ${modelEntry.fullId}, provider: ${modelEntry.provider}) gestartet. ` +
      `PID: ${wrapperPid}. Werkzeuge des inneren Agenten: ${mcpBruecke.grund}`,
  });
}

// ---------------------------------------------------------------------------
// stop_specialist
// ---------------------------------------------------------------------------

export async function stopSpecialistTool(
  name: string,
  projectPath: string,
) {
  try {
    // Stop-Kommando senden
    if (heartbeatController.isConnected(name)) {
      await heartbeatController.sendStop(name);
    }
  } catch (err) {
    console.error(`[Synapse] Fehler beim Stoppen von "${name}": ${err}`);
  }

  // Verbindung trennen
  await heartbeatController.disconnectFromWrapper(name);

  // Status aktualisieren
  await updateSpecialist(projectPath, name, {
    status: 'stopped',
    lastActivity: new Date().toISOString(),
    currentTask: null,
  } as any);

  return jsonResult({
    success: true,
    message: `Spezialist "${name}" gestoppt.`,
  });
}

// ---------------------------------------------------------------------------
// purge_specialist — stop + komplette Entfernung (FS + DB + Channels)
// ---------------------------------------------------------------------------

/**
 * Lebt der Prozess noch?
 *
 * process.kill(pid, 0) wirft bei totem Prozess (ESRCH) — aber AUCH bei einem
 * fremden, sehr lebendigen Prozess (EPERM). Wer nur auf "wirft" prueft, haelt
 * einen laufenden Fremdprozess faelschlich fuer tot. Deshalb wird der Fehlercode
 * unterschieden.
 */
function prozessLebt(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Wartet bis zur Frist auf den Tod des Prozesses. Rueckgabe: ist er tot? */
async function warteAufProzessTod(pid: number, fristMs: number): Promise<boolean> {
  const ende = Date.now() + fristMs;
  while (Date.now() < ende) {
    if (!prozessLebt(pid)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return !prozessLebt(pid);
}

export async function purgeSpecialistTool(
  name: string,
  projectPath: string,
  project?: string,
) {
  const steps: Record<string, unknown> = {};

  // 1. Wrapper-PID merken VOR dem Stop (fuer PID-Wait-Loop)
  let wrapperPid: number | null = null;
  try {
    const status = await readStatus(projectPath);
    wrapperPid = status.specialists[name]?.wrapperPid ?? null;
  } catch { /* ignore */ }

  // 2. Stop wie bisher (Wrapper-Prozess beenden)
  try {
    if (heartbeatController.isConnected(name)) {
      await heartbeatController.sendStop(name);
    }
    await heartbeatController.disconnectFromWrapper(name);
    steps.stop = 'ok';
  } catch (err) {
    steps.stop = `Fehler: ${err}`;
  }

  // 2b. Auf Wrapper-Prozess-Tod warten — Wrapper schreibt waehrend Shutdown
  // updateSpecialist({ status: 'stopped' }) und wuerde unseren removeSpecialist
  // ueberschreiben. Polling: max 5s warten bis PID tot ist.
  //
  // ⚠️ GEMESSEN AM 02.08.2026 an rollen-pruefer: sendStop lief in einen Timeout UND
  // der Wrapper ignorierte SIGTERM (er brauchte SIGKILL). Vorher wurde danach trotzdem
  // abgeraeumt: Channels, Chat, Verzeichnis, status.json und PG-Eintrag waren weg,
  // waehrend Wrapper und Claude-Prozess weiterliefen. Der ueberlebende Wrapper legte
  // sein Verzeichnis in derselben Sekunde neu an (jeder Schreibvorgang geht durch
  // ensureAgentDir). Uebrig blieb ein Agent, den kein Werkzeug mehr findet — status
  // meldete "nicht gefunden", stop und wake brauchen einen Registry-Eintrag — der aber
  // weiterlief, Kontext belegte und in ein Verzeichnis schrieb, das es offiziell nicht
  // mehr gab. Deshalb wird jetzt eskaliert (TERM, dann KILL) und im Zweifel ABGEBROCHEN,
  // statt einen unerreichbaren Geist zu hinterlassen.
  if (wrapperPid && wrapperPid > 0) {
    let tot = await warteAufProzessTod(wrapperPid, 5000);

    if (!tot) {
      try {
        process.kill(wrapperPid, 'SIGTERM');
        steps.signal_term = 'gesendet';
      } catch (err) {
        steps.signal_term = `Fehler: ${err}`;
      }
      tot = await warteAufProzessTod(wrapperPid, 3000);
    }

    if (!tot) {
      try {
        process.kill(wrapperPid, 'SIGKILL');
        steps.signal_kill = 'gesendet';
      } catch (err) {
        steps.signal_kill = `Fehler: ${err}`;
      }
      tot = await warteAufProzessTod(wrapperPid, 2000);
    }

    steps.prozess_beendet = tot;

    // ABBRUCH statt Geist: solange der Prozess lebt, wird NICHTS entfernt. Ein
    // adressierbarer Spezialist mit falschem Status ist reparierbar — ein laufender
    // ohne Registry-Eintrag ist es nicht.
    if (!tot) {
      return jsonResult({
        success: false,
        message: `Spezialist "${name}" NICHT entfernt: Wrapper-Prozess ${wrapperPid} lebt noch, `
          + `SIGTERM und SIGKILL blieben wirkungslos. Es wurde nichts geloescht — Registry, `
          + `Verzeichnis, Channels und PG-Eintrag bleiben erhalten, damit der Agent `
          + `adressierbar bleibt. Prozess von Hand pruefen, dann erneut purgen.`,
        wrapper_pid: wrapperPid,
        steps,
      });
    }

    // Sicherheitspuffer fuer letzten async write
    await new Promise(r => setTimeout(r, 200));
  } else {
    steps.prozess_beendet = 'keine Wrapper-PID bekannt — Prozesstod UNGEPRUEFT';
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Aus allen Channels entfernen (DB)
  try {
    const removed = await removeAgentFromAllChannels(name);
    steps.channels_removed = removed;
  } catch (err) {
    steps.channels_removed = `Fehler: ${err}`;
  }

  // 3. Chat-Session abmelden (DB)
  try {
    await unregisterAgent(name);
    steps.chat_unregistered = 'ok';
  } catch (err) {
    steps.chat_unregistered = `Fehler: ${err}`;
  }

  // 4. Agent-Verzeichnis komplett loeschen (FS)
  // Sicherheits-Check ist in purgeAgentDir selbst (verhindert path traversal)
  try {
    await purgeAgentDir(projectPath, name);
    steps.fs_purged = 'ok';
  } catch (err) {
    steps.fs_purged = `Fehler: ${err}`;
  }

  // 4c. Wissens-Ablage entfernen, wenn sie nicht auf der Platte liegt.
  // Im Vorgabe-Weg ist das mit Schritt 4 bereits erledigt — dort waere ein
  // zweiter Aufruf nur ein zweites rm auf dasselbe Verzeichnis. Im api-Weg
  // bliebe das Wissen sonst in der Datenbank stehen: der Spezialist ist weg,
  // sein Wissen nicht, und beim naechsten Spawn desselben Namens erbt ein
  // fremder Agent die alten Regeln. Das waere kein Fehler, den man sieht.
  if (project) {
    try {
      const wissen = erzeugeWissen({
        projekt: project,
        projektPfad: projectPath,
        log: (msg, ...args) => console.error(`[Synapse][wissen] ${msg}`, ...args),
      });
      if (wissen.art !== 'datei') {
        // ⚠️ ZAHL UND WEG, nicht nur der Weg. Vorher stand hier allein wissen.art
        // ('api') — das sagt WO geloescht wurde, aber nicht OB etwas da war. Ein
        // purge, der ins Leere greift, sah damit aus wie einer, der aufgeraeumt
        // hat, und ein still wachsender Bestand zu entfernten Agenten waere
        // niemandem aufgefallen. Die Einheit steht dabei, weil sie am Weg haengt.
        const anzahl = await wissen.loescheAlles(name);
        steps.wissen_geloescht = { weg: wissen.art, anzahl, einheit: 'zeilen' };
      }
    } catch (err) {
      steps.wissen_geloescht = `Fehler: ${err}`;
    }
  }

  // 4b. Socket entfernen — blieb bisher liegen und liess einen entfernten
  // Spezialisten im Dateisystem wie einen laufenden aussehen.
  try {
    await rm(join(projectPath, '.synapse', 'sockets', `${name}.sock`), { force: true });
    steps.socket_removed = 'ok';
  } catch (err) {
    steps.socket_removed = `Fehler: ${err}`;
  }

  // 5. Specialist aus status.json entfernen (zuletzt — nachdem Wrapper sicher tot)
  try {
    await removeSpecialist(projectPath, name);
    steps.status_removed = 'ok';
  } catch (err) {
    steps.status_removed = `Fehler: ${err}`;
  }

  // 6. Wrapper-Status aus PG entfernen (zusaetzlich zu status.json)
  if (project) {
    try {
      await removeWrapperStatus(name, project);
      steps.pg_status_removed = 'ok';
    } catch (err) {
      // Kein Hard-Fail — PG-Row fehlt z.B. bei alten Spezialisten ohne PG-Eintrag
      steps.pg_status_removed = `Fehler (non-fatal): ${err}`;
    }
  }

  // 7. Inbox-Zeilen dieses Agenten entfernen.
  // Sie blieben bisher liegen, obwohl die Erfolgsmeldung "PG" in ihrer Aufzaehlung
  // fuehrte — wieder eine Meldung, die mehr sagt als sie haelt. Gefunden am
  // 02.08.2026 beim Nachpruefen eines purge, das "komplett entfernt" meldete:
  // zwei Waisen blieben stehen, darunter eine unverarbeitete Wake-Nachricht.
  // Die ANZAHL steht ausdruecklich in steps, damit man sieht was passiert ist,
  // statt es glauben zu muessen.
  try {
    steps.inbox_removed = await removeInboxForAgent(name);
  } catch (err) {
    steps.inbox_removed = `Fehler: ${err}`;
  }

  // 8. Token dieses Agenten widerrufen (Scope wrapper:<name>).
  // Ohne diesen Schritt bleibt pro Spawn ein Token mit 180 Tagen Laufzeit liegen —
  // fuer einen Agenten, den es nicht mehr gibt. Es geht dabei nichts kaputt, es
  // waechst nur still die Zahl gueltiger Schluessel; genau die Sorte Rest, die bei
  // einer Erfolgsmeldung niemand nachzaehlt. Deshalb steht hier die ANZAHL.
  // Nur sinnvoll, wenn ueberhaupt ueber HTTP gearbeitet wird.
  const mcpUrl = (process.env.SYNAPSE_AGENT_MCP_URL ?? process.env.SYNAPSE_API_URL ?? '').trim();
  const mcpAusweis = (process.env.SYNAPSE_API_TOKEN ?? '').trim();
  if ((process.env.SYNAPSE_AGENT_MCP_TRANSPORT ?? '').trim().toLowerCase() === 'http' && mcpUrl && mcpAusweis) {
    try {
      steps.wrapper_token_revoked = await widerrufeWrapperTokens(mcpUrl, mcpAusweis, name);
    } catch (err) {
      steps.wrapper_token_revoked = `Fehler: ${err}`;
    }
  }

  // Erfolg wird aus den Schritten ABGELEITET, nicht behauptet. Vorher stand hier ein
  // fest verdrahtetes success:true samt "Auto-Respawn unmoeglich" — auch dann, wenn
  // in steps ein Fehler protokolliert war. Genau daran war der Ausfall vom 02.08.2026
  // von aussen nicht zu erkennen.
  //
  // Nicht gewertet werden:
  //   stop — ein Timeout ist hier folgenlos, weil der Prozesstod oben verbindlich
  //          geprueft (und notfalls erzwungen) wurde.
  //   pg_status_removed — ausdruecklich als "Fehler (non-fatal)" markiert; alte
  //          Spezialisten haben gar keine PG-Zeile. Der Filter trifft nur "Fehler:".
  const fehlgeschlagen = Object.entries(steps)
    .filter(([schritt, wert]) => schritt !== 'stop' && typeof wert === 'string' && wert.startsWith('Fehler:'))
    .map(([schritt]) => schritt);

  return jsonResult({
    success: fehlgeschlagen.length === 0,
    message: fehlgeschlagen.length === 0
      ? `Spezialist "${name}" komplett entfernt (Stop + Channels + Chat + Status + FS + Socket + Inbox${project ? ' + PG' : ''}). Prozess nachweislich beendet, Auto-Respawn unmoeglich.`
      : `Spezialist "${name}" nur TEILWEISE entfernt. Fehlgeschlagen: ${fehlgeschlagen.join(', ')}. `
        + `Der Prozess ist beendet, aber Reste bleiben liegen — steps pruefen und von Hand nachraeumen.`,
    steps,
  });
}

// ---------------------------------------------------------------------------
// specialist_status
// ---------------------------------------------------------------------------

export async function specialistStatusTool(
  projectPath: string,
  name?: string,
) {
  if (!name) {
    // Alle Spezialisten
    const status = await readStatus(projectPath);
    return jsonResult({
      success: true,
      specialists: status.specialists,
      maxSpecialists: status.maxSpecialists,
      runningCount: Object.values(status.specialists).filter(s => s.status === 'running').length,
      lastUpdate: status.lastUpdate,
    });
  }

  // Einzelner Spezialist
  const status = await readStatus(projectPath);
  const specialist = status.specialists[name];
  if (!specialist) {
    return jsonResult({
      success: false,
      message: `Spezialist "${name}" nicht gefunden.`,
    });
  }

  // Wrapper-Status holen wenn verbunden
  let wrapperStatus: Record<string, unknown> = {};
  if (heartbeatController.isConnected(name)) {
    try {
      wrapperStatus = await heartbeatController.getWrapperStatus(name);
    } catch {
      wrapperStatus = { connected: false, error: 'Konnte Wrapper-Status nicht abrufen' };
    }
  }

  // SKILL.md lesen
  const skill = await readSkill(projectPath, name);

  return jsonResult({
    success: true,
    specialist,
    wrapperStatus,
    skill: skill ?? '(keine SKILL.md vorhanden)',
    connected: heartbeatController.isConnected(name),
  });
}

// ---------------------------------------------------------------------------
// wake_specialist
// ---------------------------------------------------------------------------

export async function wakeSpecialistTool(
  name: string,
  message: string,
) {
  if (!heartbeatController.isConnected(name)) {
    return jsonResult({
      success: false,
      message: `Spezialist "${name}" ist nicht verbunden. Verwende spawn_specialist um ihn zu starten.`,
    });
  }

  try {
    const result = await heartbeatController.sendWake(name, message);
    return jsonResult({
      success: true,
      response: result.content,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
    });
  } catch (err) {
    // Agent busy → auto-fallback to inbox (delivered on next heartbeat poll)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Agent is busy')) {
      try {
        const inboxResult = await postToInbox('koordinator', name, message);
        return jsonResult({
          success: true,
          queued: true,
          message: `Spezialist "${name}" ist beschaeftigt. Nachricht in Inbox zugestellt (ID: ${inboxResult.id}) — wird beim naechsten Heartbeat verarbeitet.`,
        });
      } catch (inboxErr) {
        return jsonResult({
          success: false,
          message: `Spezialist "${name}" ist beschaeftigt und Inbox-Fallback fehlgeschlagen: ${inboxErr}`,
        });
      }
    }

    return jsonResult({
      success: false,
      message: `Fehler beim Aufwecken von "${name}": ${err}`,
    });
  }
}

// ---------------------------------------------------------------------------
// update_specialist_skill
// ---------------------------------------------------------------------------

export async function updateSpecialistSkillTool(
  name: string,
  projectPath: string,
  section: 'regeln' | 'fehler' | 'patterns' | undefined,
  action: 'add' | 'remove',
  content: string,
  file?: SkillFile,
) {
  // Auto-Migration: falls meta.yaml nicht existiert, migrieren.
  // Nur der Dateiweg kennt eine SKILL.md — in der Ablage gibt es sie nie.
  const wissen = erzeugeWissen({
    projekt: '',
    projektPfad: projectPath,
    log: (msg, ...args) => console.error(`[Synapse][wissen] ${msg}`, ...args),
  });
  if (wissen.art === 'datei') {
    await migrateSkillMd(projectPath, name);
  }

  // Legacy-Mapping: section → file
  const fileMap: Record<string, SkillFile> = {
    regeln: 'rules',
    fehler: 'errors',
    patterns: 'patterns',
  };
  const targetFile: SkillFile = file ?? (section ? fileMap[section] : undefined) ?? 'rules';

  if (action === 'add') {
    await wissen.haengeAn(name, targetFile, content);
    return jsonResult({
      success: true,
      message: `Eintrag zu "${targetFile}" hinzugefuegt fuer "${name}".`,
      file: targetFile,
      quelle: wissen.art,
    });
  }

  if (action === 'remove') {
    // Die ZAHL statt eines blossen Erfolgs: 'nichts passte' und 'eine Zeile
    // entfernt' sahen vorher am Aufrufer gleich aus, sobald man nicht genau
    // hinsah — und das Filtern selbst liegt jetzt dort, wo die Daten liegen.
    const entfernt = await wissen.entferneEintraege(name, targetFile, content);

    if (entfernt === 0) {
      return jsonResult({
        success: false,
        message: `Eintrag "${content}" nicht gefunden in "${targetFile}" von "${name}" (oder "${targetFile}" existiert nicht).`,
        quelle: wissen.art,
      });
    }

    return jsonResult({
      success: true,
      message: `Eintrag aus "${targetFile}" entfernt fuer "${name}" (${entfernt} Zeile(n)).`,
      file: targetFile,
      entfernte_zeilen: entfernt,
      quelle: wissen.art,
    });
  }

  return jsonResult({ success: false, message: `Unbekannte Aktion: ${action}` });
}

// ---------------------------------------------------------------------------
// Channel Tools
// ---------------------------------------------------------------------------

export async function createChannelTool(
  name: string,
  project: string,
  description: string,
  createdBy: string,
) {
  try {
    const channel = await createChannel(project, name, description, createdBy);
    return jsonResult({
      success: true,
      channel,
      message: `Channel "${name}" erstellt.`,
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function joinChannelTool(project: string, channelName: string, agentName: string) {
  try {
    const joined = await joinChannel(project, channelName, agentName);
    if (!joined) {
      return jsonResult({ success: false, message: `Channel "${channelName}" nicht gefunden.` });
    }
    return jsonResult({ success: true, message: `"${agentName}" ist Channel "${channelName}" beigetreten.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function leaveChannelTool(project: string, channelName: string, agentName: string) {
  try {
    const left = await leaveChannel(project, channelName, agentName);
    if (!left) {
      return jsonResult({ success: false, message: `"${agentName}" war nicht in Channel "${channelName}".` });
    }
    return jsonResult({ success: true, message: `"${agentName}" hat Channel "${channelName}" verlassen.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function postToChannelTool(project: string, channelName: string, sender: string, content: string) {
  try {
    const result = await postMessage(project, channelName, sender, content);
    if (!result) {
      return jsonResult({ success: false, message: `Channel "${channelName}" nicht gefunden.` });
    }
    return jsonResult({
      success: true,
      message: `Nachricht in "${channelName}" gepostet.`,
      messageId: result.id,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function getChannelFeedTool(project: string, channelName: string, limit?: number, sinceId?: number, preview?: boolean) {
  try {
    const messages = await getMessages(project, channelName, { limit, sinceId, preview });
    return jsonResult({
      success: true,
      channel: channelName,
      count: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function listChannelsTool(
  project?: string,
) {
  try {
    const channels = await listChannels(project);
    return jsonResult({
      success: true,
      count: channels.length,
      channels,
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

// ---------------------------------------------------------------------------
// Inbox Tools
// ---------------------------------------------------------------------------

export async function postToInboxTool(
  fromAgent: string,
  toAgent: string,
  content: string,
) {
  try {
    const result = await postToInbox(fromAgent, toAgent, content);
    return jsonResult({
      success: true,
      message: `Nachricht von "${fromAgent}" an "${toAgent}" gesendet.`,
      messageId: result.id,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function checkInboxTool(
  agentName: string,
) {
  try {
    const messages = await checkInbox(agentName);
    return jsonResult({
      success: true,
      agent: agentName,
      count: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        from: m.fromAgent,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

// ---------------------------------------------------------------------------
// Utility: get_agent_capabilities
// ---------------------------------------------------------------------------

export function getAgentCapabilitiesTool() {
  const cliInfo = detectClaudeCli();
  return jsonResult({
    success: true,
    claudeCli: cliInfo,
    features: {
      specialists: cliInfo.available,
      channels: true,
      inbox: true,
      skillLearning: cliInfo.available,
    },
    message: cliInfo.available
      ? `Claude CLI verfuegbar (${cliInfo.version}). Alle Specialist-Features aktiv.`
      : 'Claude CLI nicht verfuegbar. Channel und Inbox Tools funktionieren, aber Specialist-Spawning ist deaktiviert.',
  });
}
