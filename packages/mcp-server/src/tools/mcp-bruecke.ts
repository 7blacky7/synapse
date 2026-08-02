/**
 * MODUL: MCP-Bruecke fuer den INNEREN Claude eines Spezialisten (Schritt 3b)
 * ZWECK: Ein Spezialist besteht aus zwei Programmen. Der Wrapper spricht seit
 *        Schritt 2 ueber die Zugriffsschicht mit der API. Der innere Claude aber
 *        bekommt seine Synapse-Werkzeuge bisher ueber einen LOKALEN stdio-Prozess
 *        mit direkter Datenbankverbindung — er erbt schlicht die .mcp.json der
 *        Maschine (der Spawner startet den Wrapper mit env: {...process.env} und
 *        cwd im Projektpfad). Solange das so ist, braucht ein Spezialist im
 *        Container weiterhin eine Datenbank, nur eben fuer seine Werkzeuge statt
 *        fuer seinen Wrapper. Dieses Modul gibt dem Agenten stattdessen eine
 *        EIGENE MCP-Konfiguration mit, die den Synapse-Server ueber HTTP
 *        anspricht (deployte API, Bearer-Token).
 *
 * ADDITIV: Der neue Weg haengt hinter SYNAPSE_AGENT_MCP_TRANSPORT. VORGABE ist
 *          'stdio' — also der heutige Weg. Nichts wird stillschweigend umgestellt.
 *
 * KEIN STILLER RUECKFALL: Ist 'http' verlangt, aber URL oder Token fehlen, oder
 *          antwortet der Endpunkt nicht mit Werkzeugen, wird der Spawn ABGEBROCHEN.
 *          Ein Agent ohne Werkzeuge sagt "dafuer habe ich kein Werkzeug" und
 *          arbeitet weiter — das liest sich wie eine fachliche Antwort und nicht
 *          wie ein Defekt. Genau diese Fehlerform darf hier nicht entstehen.
 *
 * NEBENEFFEKTE: schreibt eine Datei mit dem Token (mode 0600) unter
 *          .synapse/agents/<name>/mcp-http.json; ein HTTP-Aufruf gegen die API.
 */

import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ⚠️ DER SERVER-PRAEFIX. Der Name des Servers in mcpServers bestimmt den Praefix
 * der Werkzeugnamen: "synapse" ergibt mcp__synapse__post_to_channel. Prompts und
 * Filter nennen die Werkzeuge beim Namen (wrapper.ts, der Handoff-Text, der
 * allowedTools-Filter). Heisst der Server anders, brechen sie ALLE — ohne
 * Fehlermeldung; der Agent ruft dann einfach nichts mehr auf. Deshalb ist dieser
 * Name eine Konstante und kein Konfigurationswert.
 * GEMESSEN 2026-08-02: claude --mcp-config mit diesem Namen meldet
 * mcp__synapse__* — 21 Werkzeuge, identisch zum stdio-Weg.
 */
const SERVER_NAME = 'synapse';

export interface McpBrueckeErgebnis {
  /** true = der Agent bekommt eine eigene HTTP-Konfiguration mit. */
  aktiv: boolean;
  /** Warum aktiv bzw. warum nicht — landet in der Spawn-Antwort. */
  grund: string;
  /** Pfad der erzeugten Konfigurationsdatei (nur wenn aktiv). */
  configPfad?: string;
  /** Beim Selbsttest gezaehlte Werkzeuge (nur wenn aktiv). */
  werkzeuge?: number;
  /** Angesprochener Endpunkt (nur wenn aktiv, ohne Token). */
  url?: string;
  /** Scope des benutzten Tokens, z.B. "wrapper:pruefer" (nur wenn aktiv). */
  scope?: string;
  /** Woher das Token kam: frisch fuer diesen Agenten ausgestellt oder vorgegeben. */
  tokenHerkunft?: 'eigenes' | 'vorgegeben';
}

/** Fehler dieser Klasse brechen den Spawn ab — bewusst laut. */
export class McpBrueckeFehler extends Error {}

/**
 * Zaehlt die Werkzeuge, die der HTTP-Endpunkt wirklich anbietet.
 * Zwei Aufrufe nach MCP "Streamable HTTP": initialize, dann tools/list.
 *
 * ⚠️ Der MCP-Endpunkt der Synapse-API liegt auf POST / (Root), NICHT auf /mcp —
 * /mcp antwortet mit 404 (gemessen 2026-08-02). Der Auth-Hook gated beide.
 */
async function zaehleWerkzeuge(url: string, token: string): Promise<number> {
  const kopf: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };

  const lies = async (nutzlast: unknown, sitzung?: string) => {
    let antwort: Response;
    try {
      antwort = await fetch(url, {
        method: 'POST',
        headers: sitzung ? { ...kopf, 'Mcp-Session-Id': sitzung } : kopf,
        body: JSON.stringify(nutzlast),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // Ohne dieses Einwickeln kommt hier ein nacktes "fetch failed" heraus — ein
      // Fehler ohne Adresse und ohne Ursache, der beim Spawn nicht erklaert, WAS
      // nicht erreichbar war.
      const ursache = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new McpBrueckeFehler(
        `MCP-Endpunkt ${url} ist nicht erreichbar (${ursache}). Adresse, Netz oder laufende API pruefen.`,
      );
    }
    const text = await antwort.text();
    return { status: antwort.status, text, sitzung: antwort.headers.get('mcp-session-id') };
  };

  // Antwort kann als SSE-Rahmen kommen ("event: message\ndata: {...}").
  const auspacken = (text: string): unknown => {
    if (text.startsWith('event:')) {
      const zeile = text.split('\n').find(z => z.startsWith('data: '));
      if (zeile) return JSON.parse(zeile.slice(6));
    }
    return JSON.parse(text);
  };

  const init = await lies({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'synapse-spawner', version: '1' },
    },
  });
  if (init.status !== 200) {
    throw new McpBrueckeFehler(
      `MCP-Endpunkt ${url} antwortet auf initialize mit HTTP ${init.status}: ${init.text.slice(0, 200)}`,
    );
  }

  const liste = await lies(
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    init.sitzung ?? undefined,
  );
  if (liste.status !== 200) {
    throw new McpBrueckeFehler(
      `MCP-Endpunkt ${url} antwortet auf tools/list mit HTTP ${liste.status}: ${liste.text.slice(0, 200)}`,
    );
  }

  const daten = auspacken(liste.text) as { result?: { tools?: unknown[] } };
  return daten.result?.tools?.length ?? 0;
}

/** Basisadresse ohne abschliessenden Schraegstrich. */
function basis(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Stellt fuer GENAU DIESEN Spezialisten ein eigenes Token mit Scope
 * "wrapper:<name>" aus (POST /api/auth/service-token).
 *
 * WARUM EIN EIGENES statt eines geteilten: ein ungefiltertes Token darf ueber
 * den MCP-Weg auch specialist(purge) — und purge beendet Prozesse und loescht
 * Verzeichnisse. Solange der Auth-Hook den Scope nicht auswertet, aendert der
 * eigene Scope daran nichts; er macht die spaetere Einschraenkung aber zu einer
 * Datenfrage statt zu einem Umbau, und er macht JETZT SCHON jeden Zugriff einem
 * Agenten zuordenbar und einzeln widerrufbar.
 *
 * AUSWEIS: Die Route nimmt entweder einen TOTP-Code ODER ein bestehendes
 * daemon-Token als Ausweis (auth.ts: 'daemon', 'daemon:*' und 'wrapper:*'
 * gelten). Ein daemon-Token darf einen NEUEN Scope ausstellen; ein
 * wrapper-Token darf nur sich selbst erneuern — sonst 403 scope_forbidden.
 * Deshalb taugt das Tray-Token (scope 'daemon:tray') hier als Ausweis, obwohl
 * es fuer den MCP-Weg selbst NICHT taugt (dort zaehlt kind, und es ist
 * 'session' statt 'service').
 */
export async function holeWrapperToken(
  url: string,
  ausweis: string,
  agentName: string,
  totpCode?: string,
): Promise<{ token: string; scope: string }> {
  const ziel = `${basis(url)}/api/auth/service-token`;
  const kopf: Record<string, string> = { 'Content-Type': 'application/json' };
  // Mit Code braucht es keinen Ausweis-Header; ohne Code ist der Header der Ausweis.
  if (!totpCode) kopf.Authorization = `Bearer ${ausweis}`;

  let antwort: Response;
  try {
    antwort = await fetch(ziel, {
      method: 'POST',
      headers: kopf,
      body: JSON.stringify({
        wrapper_agent: agentName,
        label: `wrapper-${agentName}`.slice(0, 40),
        ...(totpCode ? { code: totpCode } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const ursache = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new McpBrueckeFehler(`Token-Ausstellung unter ${ziel} nicht erreichbar (${ursache}).`);
  }

  const text = await antwort.text();
  if (antwort.status !== 200) {
    throw new McpBrueckeFehler(
      `Token-Ausstellung fuer "wrapper:${agentName}" abgelehnt (HTTP ${antwort.status}): ${text.slice(0, 250)}`,
    );
  }
  const daten = JSON.parse(text) as { success?: boolean; token?: string; scope?: string };
  if (!daten.success || !daten.token) {
    throw new McpBrueckeFehler(
      `Token-Ausstellung fuer "wrapper:${agentName}" lieferte kein Token: ${text.slice(0, 250)}`,
    );
  }
  return { token: daten.token, scope: daten.scope ?? `wrapper:${agentName}` };
}

/**
 * Widerruft alle Tokens mit Scope "wrapper:<name>" (beim purge).
 *
 * OHNE DIESEN SCHRITT bleibt pro Spawn ein Token mit 180 Tagen Laufzeit liegen —
 * fuer einen Agenten, den es nicht mehr gibt. Das faellt niemandem auf, weil
 * nichts kaputt geht; es waechst nur still die Zahl gueltiger Schluessel.
 * Liefert die Anzahl der widerrufenen Tokens zurueck, damit im purge eine ZAHL
 * steht und keine Behauptung.
 */
export async function widerrufeWrapperTokens(
  url: string,
  ausweis: string,
  agentName: string,
): Promise<number> {
  const kopf = { Authorization: `Bearer ${ausweis}`, 'Content-Type': 'application/json' };
  const gesucht = `wrapper:${agentName}`;

  const liste = await fetch(`${basis(url)}/api/auth/sessions`, {
    headers: kopf,
    signal: AbortSignal.timeout(20_000),
  });
  if (liste.status !== 200) {
    throw new Error(`Sitzungsliste nicht lesbar (HTTP ${liste.status})`);
  }
  const daten = (await liste.json()) as { sessions?: Array<{ id?: string; scope?: string }> };
  const treffer = (daten.sessions ?? []).filter(s => s.scope === gesucht && s.id);

  let widerrufen = 0;
  for (const s of treffer) {
    const weg = await fetch(`${basis(url)}/api/auth/sessions/${s.id}`, {
      method: 'DELETE',
      headers: kopf,
      signal: AbortSignal.timeout(20_000),
    });
    if (weg.status === 200) widerrufen++;
  }
  return widerrufen;
}

/**
 * Bereitet die MCP-Konfiguration fuer den inneren Claude vor.
 *
 * Rueckgabe aktiv=false heisst: der heutige stdio-Weg gilt unveraendert.
 * Ein Wurf heisst: der HTTP-Weg wurde verlangt und ist NICHT benutzbar —
 * der Spawn muss abbrechen statt einen tauben Agenten zu starten.
 */
export async function bereiteMcpBrueckeVor(
  projectPath: string,
  agentName: string,
): Promise<McpBrueckeErgebnis> {
  const roh = (process.env.SYNAPSE_AGENT_MCP_TRANSPORT ?? '').trim().toLowerCase();

  if (roh === '' || roh === 'stdio') {
    return {
      aktiv: false,
      grund: `stdio (SYNAPSE_AGENT_MCP_TRANSPORT=${roh === '' ? '<nicht gesetzt, Vorgabe stdio>' : roh})`,
    };
  }
  if (roh !== 'http') {
    // Unbekannter Wert: heutiges Verhalten, aber LAUT. Ein Tippfehler darf nicht
    // als "ist eben stdio" durchgehen.
    console.error(
      `[Synapse] WARNUNG: SYNAPSE_AGENT_MCP_TRANSPORT="${roh}" ist unbekannt (erlaubt: stdio, http). Es gilt der stdio-Weg.`,
    );
    return { aktiv: false, grund: `stdio (unbekannter Wert "${roh}", Warnung im Log)` };
  }

  const url = (process.env.SYNAPSE_AGENT_MCP_URL ?? process.env.SYNAPSE_API_URL ?? '').trim();
  const vorgegeben = (process.env.SYNAPSE_AGENT_MCP_TOKEN ?? '').trim();
  const ausweis = (process.env.SYNAPSE_API_TOKEN ?? '').trim();
  const totpCode = (process.env.SYNAPSE_AGENT_MCP_TOTP ?? '').trim();

  if (!url || (!vorgegeben && !ausweis && !totpCode)) {
    throw new McpBrueckeFehler(
      'SYNAPSE_AGENT_MCP_TRANSPORT=http verlangt eine Adresse und einen Ausweis: ' +
        `SYNAPSE_AGENT_MCP_URL/SYNAPSE_API_URL ${url ? 'ist gesetzt' : 'FEHLT'}; ` +
        'dazu entweder SYNAPSE_API_TOKEN (daemon-Token als Ausweis), SYNAPSE_AGENT_MCP_TOTP ' +
        '(einmaliger Code) oder SYNAPSE_AGENT_MCP_TOKEN (fertiges Token) — alle drei FEHLEN. ' +
        'Kein Rueckfall auf stdio — ein Spezialist, der unbemerkt wieder lokal laeuft, ' +
        'braucht weiterhin eine Datenbankverbindung und der Zweck der Bruecke waere verfehlt.',
    );
  }

  // NORMALFALL: ein EIGENES Token fuer genau diesen Agenten, Scope wrapper:<name>.
  // Das vorgegebene Token ist der Notausgang (z.B. wenn die Ausstellung nicht
  // erreichbar ist) und bewusst nicht die Vorgabe: ein geteiltes Token laesst sich
  // weder einem Agenten zuordnen noch einzeln widerrufen.
  let token: string;
  let scope: string;
  let tokenHerkunft: 'eigenes' | 'vorgegeben';
  if (vorgegeben) {
    token = vorgegeben;
    scope = '(vorgegeben, unbekannt)';
    tokenHerkunft = 'vorgegeben';
  } else {
    const frisch = await holeWrapperToken(url, ausweis, agentName, totpCode || undefined);
    token = frisch.token;
    scope = frisch.scope;
    tokenHerkunft = 'eigenes';
  }

  // Der MCP-Endpunkt liegt auf der Wurzel, nicht auf /mcp (gemessen).
  const endpunkt = url.endsWith('/') ? url : `${url}/`;

  // Scheitert nach der Ausstellung noch irgendetwas, muss das frische Token wieder
  // weg. Sonst bleibt bei JEDEM missglueckten Spawn ein gueltiger Schluessel mit 180
  // Tagen Laufzeit zurueck — und weil der Spawn sichtbar fehlschlaegt, sucht niemand
  // nach dem Rest. GEMESSEN: genau so entstand beim Bauen eine Waise; der Widerruf
  // fand danach 2 Tokens statt 1.
  const aufraeumenBeiFehler = async (fehler: Error): Promise<never> => {
    if (tokenHerkunft === 'eigenes') {
      try {
        await widerrufeWrapperTokens(url, ausweis || token, agentName);
      } catch {
        // Der urspruengliche Fehler ist der wichtigere — er darf nicht verdeckt werden.
      }
    }
    throw fehler;
  };

  // SELBSTTEST VOR DEM SPAWN. Ein Agent ohne Werkzeuge faellt sonst niemandem auf:
  // er antwortet fachlich statt zu scheitern. Deshalb wird hier gezaehlt, bevor
  // ueberhaupt ein Prozess startet.
  let werkzeuge: number;
  try {
    werkzeuge = await zaehleWerkzeuge(endpunkt, token);
  } catch (err) {
    return aufraeumenBeiFehler(err instanceof Error ? err : new Error(String(err)));
  }
  if (werkzeuge === 0) {
    return aufraeumenBeiFehler(
      new McpBrueckeFehler(
        `MCP-Endpunkt ${endpunkt} ist erreichbar, liefert aber 0 Werkzeuge. Der Spawn bricht ab — ` +
          'ein Agent ohne Werkzeuge arbeitet scheinbar normal weiter und der Ausfall bliebe unsichtbar.',
      ),
    );
  }

  const configPfad = join(projectPath, '.synapse', 'agents', agentName, 'mcp-http.json');
  const inhalt = {
    mcpServers: {
      [SERVER_NAME]: {
        type: 'http',
        url: endpunkt,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  try {
    await writeFile(configPfad, JSON.stringify(inhalt, null, 2), 'utf-8');
    // Die Datei traegt ein Token — nur der Eigentuemer darf sie lesen.
    await chmod(configPfad, 0o600);
  } catch (err) {
    return aufraeumenBeiFehler(
      new McpBrueckeFehler(
        `MCP-Konfiguration ${configPfad} konnte nicht geschrieben werden: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  return {
    aktiv: true,
    grund:
      `http (SYNAPSE_AGENT_MCP_TRANSPORT=http, ${werkzeuge} Werkzeuge im Selbsttest gezaehlt, ` +
      `Token: ${tokenHerkunft} ${scope})`,
    configPfad,
    werkzeuge,
    url: endpunkt,
    scope,
    tokenHerkunft,
  };
}

/**
 * Der Satz, der dem System-Prompt des Agenten angehaengt wird, wenn die Bruecke
 * aktiv ist. Zweite Sicherung gegen die Merkbarkeitsluecke: der Vorabtest oben
 * misst die API, dieser Satz laesst den AGENTEN selbst nachzaehlen — nur er
 * sieht, was in seinem Prozess wirklich ankommt.
 */
export function selbsttestHinweis(erwartet: number): string {
  return [
    '',
    '## PFLICHT-SELBSTTEST (erste Handlung, vor der eigentlichen Aufgabe)',
    '',
    `Deine Synapse-Werkzeuge kommen ueber HTTP von der API, nicht von einem lokalen Prozess.`,
    `Zaehle als ALLERERSTES deine verfuegbaren Werkzeuge mit dem Praefix mcp__synapse__ und melde`,
    `die Zahl im Channel. Erwartet werden ${erwartet}.`,
    `Weicht die Zahl ab oder ist sie null, MELDE DAS LAUT als Defekt und arbeite NICHT weiter,`,
    `als waere es eine fachliche Einschraenkung. "Dafuer habe ich kein Werkzeug" ist in diesem`,
    `Fall keine Antwort, sondern ein Ausfall.`,
    '',
  ].join('\n');
}
