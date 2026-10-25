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
  leseDesignVorlieben,
  ladeBewertungHtml,
  verknuepfeVersuch,
  designVorliebenZahlen,
  bewertungFuerArtefakt,
  BewertungsFehler,
  // P22-T154: Artefakte als Datenvorlagen
  ladeArtefakt,
  speichereVorlagenArtefakt,
  renderArtefakt,
  ladeVorlagenZeile,
  stelleArtefaktInVerlauf,
  artefaktVorlagenSchalter,
  artefaktQuellenKatalog,
  darfProjekt,
  ArtefaktVorlagenFehler,
  ARTEFAKT_AUSWEIS_ZEIGEN_FUNKTION,
  aktuellerAgentPrincipal,
  aktuelleAgentAkteurIdentityId,
  hauptagentIdentitaetsId,
  // P22-T166: Artefakte mit Skript (nur Top-Artefakte)
  artefaktSkripteSchalter,
  type ArtefaktBetrachter,
  type ArtefaktRenderErgebnis,
} from '@synapse/core';
import { emitArtifact, identitaetAusSessionId, aktiveMainTurnSession } from './artifact-stream.js';
import '../artefakt-quellen-api.js';

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
 * P22-T70: 'identitaet-<id>' (dauerhafter Main ohne Session-Header) -> Session des laufenden Turns, sonst die zuletzt
 * benutzte Chat-Session dieser Identitaet (Artefakt landet in PG, ohne offenen Strom). Echte Session-IDs unveraendert.
 */
export async function loeseArtefaktSession(sessionId: string): Promise<string | null> {
  const identityId = identitaetAusSessionId(sessionId);
  if (!identityId) return sessionId;
  const aktiv = aktiveMainTurnSession(identityId);
  if (aktiv) return aktiv;
  const r = await getPool().query<{ id: string }>(
    'SELECT id::text AS id FROM agent_runtime_sessions WHERE identity_id = $1 ORDER BY updated_at DESC LIMIT 1', [identityId]);
  return r.rows[0]?.id ?? null;
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

function bewertungsFehlerAntwort(error: unknown): Record<string, unknown> {
  return error instanceof BewertungsFehler
    ? { success: false, error: error.code, message: error.message }
    : { success: false, error: 'artefakt_bewertung_fehler', message: meldung(error) };
}

/**
 * P22-T141: Aktionen des artefakt-Tools. zeigen bleibt an die Hauptagenten-Session gebunden (zeigeArtefakt); vorlieben, vorbild und
 * versuch (Design-Gedaechtnis, core artefakt-bewertung.ts) brauchen keine Session und stehen jeder Identitaet offen, die artefakt
 * sieht. zeigen mit ueberarbeitet_aus verknuepft den neuen Block als Versuch (Fehler dabei: versuch_fehler, das Artefakt bleibt)
 * und traegt bei Schalter artefakt_bewertung EIN die Zahlen der Vorlieben als design_vorlieben mit.
 * P22-T147: Ersetzt zeigen (artefakt_id) ein bewertetes Artefakt, liefert die Antwort dessen bewertung (Zustand, Kommentar,
 * bewertet_am, hinweis) - fuer jeden Agenten, nicht nur den Urheber; vorbild liefert sie ebenso (core ladeBewertungHtml).
 */
export async function fuehreArtefaktAus(args: Record<string, unknown>, agentId?: string): Promise<unknown> {
  const action = typeof args.action === 'string' ? args.action : '';
  // P22-T154: neu zeichnen (jeder mit Leserecht auf das Projekt) und Quellenkatalog.
  if (action === 'neu_zeichnen') return neuZeichnen(args, agentId);
  if (action === 'quellen') {
    const [s, live, ausweis, verweise, skripte] = await Promise.all([artefaktVorlagenSchalter(), artefaktVorlagenSchalter('artefakt_vorlagen_live'),
      artefaktVorlagenSchalter(ARTEFAKT_AUSWEIS_ZEIGEN_FUNKTION), artefaktVorlagenSchalter('artefakt_verweise'), artefaktSkripteSchalter()]);
    return { success: true, katalog: artefaktQuellenKatalog(), schalter: { artefakt_vorlagen: s, artefakt_vorlagen_live: live, artefakt_ausweis_zeigen: ausweis, artefakt_verweise: verweise,
      artefakt_skripte: skripte },
      // P22-T166: kurze Anleitung fuer Artefakte mit Skript (laufen NUR in den Top-Artefakten, sonst wird das Skript entfernt).
      skripte: 'Skript (Schalter artefakt_skripte): <script> im html bzw. in der vorlage laeuft NUR in den Top-Artefakten, nach Klick auf "Skript starten",'
        + ' in einem abgeschotteten iframe (kein Netzwerk, kein fetch, kein eval, keine externen Bibliotheken - nur inline; keine Formulare/Popups).'
        + ' Chatfenster und Persoenliche Artefakte zeigen es ohne Skript. Daten nur lesend: await synapse.quelle("plan.alle", {offen:true}) (Katalog wie oben,'
        + ' project setzt der Rahmen), await synapse.lese("task"|"plan"|"thought"|"memory", id), synapse.oeffne("P22-T5") oeffnet das Lesefenster,'
        + ' synapse.bereit(fn), synapse.beiNeuemStand(fn), synapse.projekt, synapse.thema (hell|dunkel), CSS-Variablen --synapse-bg/-text/-accent.'
        + ' Grenzen: 30 Aufrufe je 10 s, 4 parallel, 10 s Zeitlimit, 256 KB je Antwort; haengt das Skript 5 s, wird es gestoppt. Nie nach Codes/Passwoertern fragen.',
      hinweis: 'Quellen: [{name, vertrag, args?}]; project wird beim Rendern eingesetzt, nie in args. Vorlage: {{wert | filter}}, {{#each liste as x}}, {{#if a == b}}; alles wird escaped.',
      // P22-T165: kurze Anleitung fuer anklickbare Artefakte (ohne Skript).
      interaktion: 'Verweis (Schalter artefakt_verweise): <span data-synapse-verweis="P22-T5"> oder <a href="#verweis:P22"> oeffnet das Lesefenster;'
        + ' andere Arten als art:id (thought, memory, task, plan, doc, event, nachricht, chat, asset), Projekt per data-synapse-projekt="{{_meta.project}}".'
        + ' Navigation ohne Skript: {{#each plan.plaene as p}}<input type="radio" name="plan" id="r-{{p.kurz_id}}" {{#if @erster}}checked{{/if}}>'
        + '<label for="r-{{p.kurz_id}}">{{p.kurz_id}}</label>{{/each}} und CSS #r-P22:checked ~ .ansichten .v-P22{display:block}; der gewaehlte Plan bleibt ueber Live-Updates erhalten.' };
  }
  try {
    if (action === 'vorlieben') return { success: true, ...(await leseDesignVorlieben({ limit: args.limit })) };
    if (action === 'vorbild') return { success: true, ...(await ladeBewertungHtml(args.bewertung_id)) };
    if (action === 'versuch') {
      return { success: true, ...(await verknuepfeVersuch({ bewertung_id: args.bewertung_id, quelle_art: args.quelle_art, quelle_ref: args.quelle_ref, von: agentId ?? null })) };
    }
  } catch (error) {
    return bewertungsFehlerAntwort(error);
  }
  const ergebnis = await zeigeArtefakt(args, agentId);
  if (action !== 'zeigen' || !ergebnis || typeof ergebnis !== 'object' || (ergebnis as { success?: unknown }).success !== true) return ergebnis;
  const r = ergebnis as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  if (args.ueberarbeitet_aus !== undefined && args.ueberarbeitet_aus !== null && args.ueberarbeitet_aus !== '') {
    try {
      extra.versuch = (await verknuepfeVersuch({ bewertung_id: args.ueberarbeitet_aus, quelle_art: 'artefakt', quelle_ref: r.artefakt_id, von: agentId ?? null })).bewertung;
    } catch (error) {
      const f = bewertungsFehlerAntwort(error);
      extra.versuch_fehler = { code: f.error, message: f.message };
    }
  }
  if (str(args, 'artefakt_id')) {
    const bewertung = await bewertungFuerArtefakt(r.artefakt_id).catch(() => null);
    if (bewertung) extra.bewertung = bewertung;
  }
  const zahlen = await designVorliebenZahlen().catch(() => null);
  if (zahlen && zahlen.vorbilder + zahlen.ueberarbeiten + zahlen.verbannt > 0) extra.design_vorlieben = { ...zahlen, abruf: 'artefakt(action:"vorlieben")' };
  return { ...r, ...extra };
}

function vorlagenFehlerAntwort(error: unknown): Record<string, unknown> {
  return error instanceof ArtefaktVorlagenFehler
    ? { success: false, error: error.code, message: error.message }
    : { success: false, error: 'artefakt_ungueltig', message: meldung(error) };
}

function raster(args: Record<string, unknown>) {
  return { column: ganzzahl(args, 'column'), columnSpan: ganzzahl(args, 'columnSpan'), row: ganzzahl(args, 'row'), rowSpan: ganzzahl(args, 'rowSpan'), minHeight: ganzzahl(args, 'minHeight') };
}

function vorlagenEingabe(args: Record<string, unknown>) {
  return {
    titel: str(args, 'titel'),
    html: typeof args.html === 'string' ? args.html : null,
    vorlage: typeof args.vorlage === 'string' ? args.vorlage : null,
    quellen: args.quellen,
    modus: args.modus,
    ...raster(args),
  };
}

/** P22-T154: Antwortteil einer Renderung (ohne HTML). */
function renderTeil(r: ArtefaktRenderErgebnis): Record<string, unknown> {
  return { modus: r.modus, project: r.project, vorlage: r.vorlage, render_revision: r.revision, gerendert_am: r.gerendert_am,
    ...(r.fehler.length ? { render_fehler: r.fehler } : {}), ...(r.hinweis ? { render_hinweis: r.hinweis } : {}), ...(r.debug ? { debug: r.debug } : {}) };
}

/**
 * P22-T154: Betrachter aus dem bezeugten Aufruf (Ausweis-Principal), nie aus Tool-Argumenten. Main = Main-Session oder die
 * Main-Identitaet. Ohne Ausweis (Legacy) gilt das angegebene Projekt wie bei den uebrigen Legacy-Werkzeugen.
 */
async function betrachterAusAufruf(args: Record<string, unknown>, mainSession: boolean): Promise<ArtefaktBetrachter> {
  const p = aktuellerAgentPrincipal();
  if (p && p.art === 'identity') {
    const main = mainSession || p.identity_id === await hauptagentIdentitaetsId().catch(() => null);
    return { art: 'agent', identity_id: p.identity_id, agent_id: p.agent_id, project: p.project, main };
  }
  return { art: 'agent', identity_id: null, agent_id: p?.agent_id ?? null, project: str(args, 'project') ?? p?.project ?? '', main: mainSession };
}

/** P22-T154: neu zeichnen ohne die Vorlage neu zu schreiben (jeder mit Leserecht auf das Projekt, R8). */
async function neuZeichnen(args: Record<string, unknown>, agentId?: string): Promise<unknown> {
  const id = str(args, 'artefakt_id');
  if (!id) return { success: false, error: 'artefakt_id_fehlt', message: 'neu_zeichnen braucht artefakt_id' };
  try {
    const b = await betrachterAusAufruf(args, !!str(args, 'session_id'));
    const r = await renderArtefakt(id, { project: str(args, 'project'), betrachter: b, anlass: 'neu_zeichnen', von: agentId ?? null });
    return { success: true, artefakt_id: r.artefakt_id, revision: r.revision, neu: r.neu, html_zeichen: r.html.length, ...renderTeil(r) };
  } catch (error) {
    return vorlagenFehlerAntwort(error);
  }
}

/**
 * P22-T154 (R5/R7): zeigen per Ausweis ohne Hauptagenten-Session (Schalter artefakt_ausweis_zeigen). Bindung ueber die Identitaet;
 * Ziel ist der eigene Verlauf (Koordinator-Fenster, Spalte artefakte) plus Persoenliche Artefakte. Kein Runtime-Container,
 * daher keine HTML-Datei und kein Livebild (PG bleibt die Wahrheit).
 */
async function zeigePerAusweis(args: Record<string, unknown>, agentId?: string): Promise<unknown> {
  const s = await artefaktVorlagenSchalter(ARTEFAKT_AUSWEIS_ZEIGEN_FUNKTION);
  if (!s.aktiv) {
    return {
      success: false,
      error: 'kein_hauptagent_kontext',
      message: 'artefakt ist nur aus einer Hauptagenten-Session aufrufbar — die Session-Bindung setzt der Server aus dem Header X-Synapse-Hauptagent-Session. (zeigen per Ausweis: Produkt-Schalter artefakt_ausweis_zeigen, derzeit AUS)',
    };
  }
  const p = aktuellerAgentPrincipal();
  if (!p || p.art !== 'identity') {
    return { success: false, error: 'kein_ausweis', message: 'zeigen ohne Hauptagenten-Session braucht einen Ausweis (agent_kennung); die Bindung laeuft ueber die Identitaet.' };
  }
  const b = await betrachterAusAufruf(args, false);
  const project = str(args, 'project') ?? p.project;
  if (!darfProjekt(b, project)) return { success: false, error: 'projekt_fremd', message: 'Mit Ausweis nur im eigenen Projekt (' + p.project + ')' };
  try {
    const v = await speichereVorlagenArtefakt({ artefaktId: str(args, 'artefakt_id'), sessionId: null, ownerIdentityId: p.identity_id,
      createdBy: agentId ?? p.agent_id, project, ...vorlagenEingabe(args) });
    let html = v.html;
    let revision = v.revision;
    let gerendert_am: string | undefined;
    let extra: Record<string, unknown> = { modus: v.modus, project: v.standard_project ?? project, vorlage: false };
    if (v.vorlage) {
      const r = await renderArtefakt(v.id, { project, betrachter: b, anlass: 'zeigen', von: agentId ?? p.agent_id });
      html = r.html; revision = r.revision; gerendert_am = r.gerendert_am; extra = renderTeil(r);
    }
    const verlauf = await stelleArtefaktInVerlauf(p.identity_id, { id: v.id, title: v.title, html, revision, modus: v.modus,
      project: (extra.project as string | null) ?? project, vorlage: !!v.vorlage, gerendert_am });
    const hinweise = ['Ausweis-Weg: kein Runtime-Container und kein offener Main-Strom - HTML-Datei und Livebild entfallen, die PG-Zeile ist die Wahrheit.'];
    if (verlauf.hinweis) hinweise.push(verlauf.hinweis);
    return { success: true, weg: 'ausweis', artefakt_id: v.id, revision, verlauf_id: verlauf.verlauf_id, html_pfad: null, bild_pfad: null,
      stream_zugestellt: false, hinweise, ...extra };
  } catch (error) {
    return vorlagenFehlerAntwort(error);
  }
}

export async function zeigeArtefakt(args: Record<string, unknown>, agentId?: string): Promise<unknown> {
  const action = typeof args.action === 'string' ? args.action : '';
  if (action !== 'zeigen') {
    return { success: false, error: 'unbekannte_action', message: 'artefakt kennt zeigen, neu_zeichnen, quellen, vorlieben, vorbild und versuch (zeigen: EIN Block je Aufruf).' };
  }
  const angefragt = str(args, 'session_id');
  if (!angefragt) return zeigePerAusweis(args, agentId);
  const sessionId = await loeseArtefaktSession(angefragt);
  const kontext = sessionId ? await ladeSessionKontext(sessionId) : null;
  if (!sessionId || !kontext) {
    return { success: false, error: 'session_unbekannt', message: 'Session ' + (sessionId ?? angefragt) + ' existiert nicht in agent_runtime_sessions.' };
  }

  // 1. PG zuerst — die Zeile ist die Wahrheit. Datei/Livebild/Strom sind Abbilder
  //    und duerfen einzeln scheitern, ohne dass das Artefakt verloren geht.
  let zeile: ArtefaktZeile;
  let vorlagenTeil: Record<string, unknown> = {};
  // P22-T154: Vorlage (oder Ersetzen eines Vorlagen-Artefakts bzw. eines Ausweis-Artefakts ohne Session) -> Vorlagen-Dienst.
  const vorlageArg = typeof args.vorlage === 'string' && args.vorlage.trim() ? args.vorlage : null;
  const ersetzt = str(args, 'artefakt_id');
  const alt = !vorlageArg && ersetzt ? await ladeVorlagenZeile(ersetzt).catch(() => null) : null;
  if (vorlageArg || alt?.vorlage || (alt && !alt.session_id)) {
    const project = str(args, 'project') ?? alt?.standard_project ?? null;
    if (vorlageArg && !project) return { success: false, error: 'projekt_fehlt', message: 'Vorlage aus der Main-Session: project angeben (der Main arbeitet projektuebergreifend)' };
    try {
      const v = await speichereVorlagenArtefakt({ artefaktId: ersetzt, sessionId, ownerIdentityId: aktuelleAgentAkteurIdentityId(agentId),
        createdBy: agentId ?? null, project, ...vorlagenEingabe(args) });
      let html = v.html;
      if (v.vorlage) {
        const r = await renderArtefakt(v.id, { project, betrachter: await betrachterAusAufruf(args, true), anlass: 'zeigen', von: agentId ?? null });
        html = r.html;
        vorlagenTeil = renderTeil(r);
      }
      const geladen = await ladeArtefakt(v.id);
      if (!geladen) throw new Error('Artefakt ' + v.id + ' nach dem Speichern nicht lesbar');
      zeile = { ...geladen, html };
    } catch (error) {
      return vorlagenFehlerAntwort(error);
    }
  } else try {
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
    ...vorlagenTeil,
  };
}
