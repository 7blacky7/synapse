/**
 * Synapse MCP - Server
 * MCP Server Implementation mit 13 konsolidierten Tools
 */

import { SERVER_INSTANCE_ID } from './server-instanz.js';
import { mitAgentToolAufruf, bereiteAgentToolAufrufVor, ergaenzeAgentTokenParameter, beworbeneAgentTools, gateToolListe } from '@synapse/core';
// P22-T56: tools/list je Verbindung (stdio: Ausweis in SYNAPSE_AGENT_TOKEN oder gemeinsame CLI-Verbindung).
import { entscheideToolListeVerbindung, toolListeMeta } from '@synapse/core';
import { haengeAusloeserTextHinweiseAn, initialisiereAssetKonfliktHinweise, initialisiereW1bAnmeldungHinweise } from '@synapse/core';
// P23-T5: Fall-Skill-Hinweis bei Fehlbedienung (Tabelle Fehlercode -> Fall-Skill, je Weg Ausweis/Legacy).
import { haengeFallSkillHinweisAn, haengeFallSkillTextHinweisAn, type FallSkillOptionen } from '@synapse/core';
// P22-T13 Paket C: Hinweisentscheidung vor First-Use-Marke und gemeinsame Agentenprojektion (wie REST).
import { hinweisAktiv, projiziereTextAntwort } from '@synapse/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  checkAgentOnboarding,
  getChatMessages,
  sendChatMessage,
  listAgents,
  getProjectPath,
  listActiveProjects,
  registerChatAgent,
  registerChatAgentsBatch,
  acknowledgeEventTool,
} from './tools/index.js';

import {
  ergaenzeToolHinweise,
  claimOpenPlanHints,
  getPendingEventHints,
  pruefeEventEskalation,
  TOOL_GUIDES,
  guideFuerKennung,
  stelleSchemaSicher,
  logToolCall,
  toolArgsVorschau,
  resolveAgentId,
  filtereJevTool,
  kompaktiereTextErgebnis,
} from '@synapse/core';
import { ensureAgentsSchema, detectClaudeCli, heartbeatController, readStatus, postToInbox, postMessage, checkInbox } from '@synapse/agents';

import {
  projectTool,
  searchTool,
  memoryTool,
  thoughtTool,
  proposalTool,
  planTool,
  chatTool,
  channelTool,
  eventTool,
  specialistTool,
  docsTool,
  adminTool,
  codeIntelTool,
  assetIntelTool,
  hexTool,
  reverseTool,
  codeCheckTool,
  ignoreTool,
  freeModelsTool,
  jevTool,
  filesTool,
  shellTool,
  guideTool,
} from './tools/consolidated/index.js';
// PA-1: unbekannte Parameter melden statt still verwerfen. Aus core — dieselbe Funktion
// benutzt die REST-Strecke, damit die beiden Wege nicht auseinanderlaufen.
import { pruefeUnbekannteParameter, baueErlaubteParameter, baueJsonParameterTypen, koerziereJsonParameter } from '@synapse/core';
// P13-T34/A16: ansicht (Bild inline/Link) nur ueber die API, Antwort unveraendert durchreichen.
import { hatAnsichtParameter } from '@synapse/core';
import { rufeAnsichtApi } from './tools/consolidated/ansicht-api.js';

/** Eindeutige ID dieser Server-Instanz — bei Neustart neu generiert.
 *  Wird fuer Session-basiertes Onboarding verwendet: neue Instance = neues Onboarding. */
export { SERVER_INSTANCE_ID }; // P25-T9: Wert aus server-instanz.ts (Importzyklus onboarding -> server)

/** Tracking: Welche (Session, Tool)-Kombination wurde bereits mit Guide-Hint versehen?
 *  Schluessel: `${sessionKey}:${toolName}`. sessionKey = agent_id (wenn gesetzt) oder
 *  SERVER_INSTANCE_ID (Fallback fuer anonyme Calls). Lebt im RAM, wird bei Server-Restart
 *  geleert — neuer Server-Run = neue Hints. */
const firstUseHinted = new Set<string>();

/** Baut einen kompakten Tool-Guide-Hinweis fuer die erste Nutzung eines Tools.
 *  Liest aus dem geteilten TOOL_GUIDES (Single Source of Truth in @synapse/core).
 *  Returnt null wenn fuer das Tool kein Guide existiert. */
function buildFirstUseHint(toolName: string): Record<string, unknown> | null {
  const g = TOOL_GUIDES[toolName];
  if (!g) return null;
  return {
    message: `📚 Erste Nutzung von "${toolName}" in dieser Session — kompakte Doku unten. Vollstaendig: guide({ tool_name: "${toolName}" }).`,
    summary: g.summary,
    when_to_use: g.when_to_use,
    when_not_to_use: g.when_not_to_use,
    actions: g.actions ? Object.keys(g.actions) : undefined,
    anti_patterns: g.anti_patterns,
  };
}



/** Prüft ausstehende Events für einen Agenten und baut Hint-Text */

/**
 * Erstellt und konfiguriert den MCP Server
 */
export function createServer(): Server {
  initialisiereAssetKonfliktHinweise();
  initialisiereW1bAnmeldungHinweise();
  const server = new Server(
    {
      name: 'synapse-mcp',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool-Liste registrieren (14 konsolidierte Tools)
  const ALLE_DEFINITIONEN = [
    projectTool.definition,
    searchTool.definition,
    memoryTool.definition,
    thoughtTool.definition,
    proposalTool.definition,
    planTool.definition,
    chatTool.definition,
    channelTool.definition,
    eventTool.definition,
    specialistTool.definition,
    docsTool.definition,
    adminTool.definition,
    codeIntelTool.definition,
    assetIntelTool.definition,
    hexTool.definition,
    reverseTool.definition,
    codeCheckTool.definition,
    ignoreTool.definition,
    freeModelsTool.definition,
    jevTool.definition,
    filesTool.definition,
    shellTool.definition,
    guideTool.definition,
  ];

  // PA-1: Nachschlagetabelle fuer die Parameter-Pruefung — aus DENSELBEN Definitionen, die
  // unten an ListTools gehen. Eine zweite, von Hand gepflegte Liste liefe sofort auseinander.
  ergaenzeAgentTokenParameter(ALLE_DEFINITIONEN);
  const ERLAUBTE_PARAMETER = baueErlaubteParameter(
    ALLE_DEFINITIONEN as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
  );
  // P22-T160: Objekt-/Listen-Parameter je Tool (JSON-Text eines Clients mit altem Schema wird zurueckgewandelt).
  const JSON_PARAMETER_TYPEN = baueJsonParameterTypen(
    ALLE_DEFINITIONEN as Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
  );

  // EINE Quelle fuer beides: was hier ausgeliefert wird, ist genau das, wogegen PA-1 prueft.
  // P15-T33 E0.5: ist Jev GLOBAL abgeschaltet (admin jev_schalten), fehlt das Tool jev in der Liste.
  // Grenze: MCP-Clients holen die Liste meist nur beim Verbinden - wirksam ab der naechsten Sitzung.
  // P22-T56: Variante je Verbindung (stdio ohne Ausweis = gemeinsame CLI-Verbindung); Debug unter _meta nur bei Schalter EIN.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const verbindung = await entscheideToolListeVerbindung({ transport: 'stdio', transportToken: process.env.SYNAPSE_AGENT_TOKEN || undefined });
    return {
      tools: await gateToolListe(await beworbeneAgentTools(await filtereJevTool(ALLE_DEFINITIONEN), { mitAusweis: !!process.env.SYNAPSE_AGENT_TOKEN, verbindung }),
        { transportToken: process.env.SYNAPSE_AGENT_TOKEN || undefined }),
      ...toolListeMeta(verbindung),
    };
  });

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    return mitAgentToolAufruf(name, request.params.arguments ?? {}, SERVER_INSTANCE_ID, async (kontext) => {
    // P23-T5: Weg nach Principal (Ausweis/Legacy), Entprellung je Sitzung; Schalter fall_skill_hinweis (Standard AUS).
    const fallOpt: FallSkillOptionen = {
      weg: kontext.principal ? 'ausweis' : 'legacy',
      schluessel: kontext.principal ? `${kontext.principal.identitaet.id}:${kontext.principal.context_epoch}`
        : (typeof kontext.args.agent_id === 'string' && kontext.args.agent_id ? kontext.args.agent_id : SERVER_INSTANCE_ID),
      project: kontext.principal?.project ?? (typeof kontext.args.project === 'string' ? kontext.args.project : null),
      args: kontext.args,
    };
    if (kontext.antwort?.success === false) {
      // P22-T155: wie REST - Absender aus geprueftem ALS bzw. bei frueher Abweisung lesend aus dem Ausweis (kontext.absender,
      // nur im Heimatprojekt); args_preview geschwaerzt (token ist aus kontext.args entfernt, logToolCall schwaerzt).
      const projekt = kontext.principal?.project ?? (typeof kontext.args.project === 'string' && kontext.args.project ? kontext.args.project : null)
        ?? kontext.absender?.project ?? null;
      void logToolCall({
        agentId: kontext.principal?.agent_id ?? kontext.absender?.agent_id ?? (typeof kontext.args.agent_id === 'string' ? kontext.args.agent_id : null),
        project: projekt, source: 'stdio', tool: name, action: String(kontext.args.action ?? ''), ok: false,
        argsPreview: toolArgsVorschau(kontext.args), error: String(kontext.antwort.error), result: JSON.stringify(kontext.antwort),
        absender: kontext.absender && kontext.absender.project === projekt ? kontext.absender : null });
      return kompaktiereTextErgebnis({ content: [{ type: 'text', text: JSON.stringify(await haengeFallSkillHinweisAn(kontext.antwort, name, fallOpt)) }], isError: true }, name);
    }
    const args = kontext.args;
    // P21: derselbe API-Core und dieselben Hooks; den geprueften Transportausweis erneut bezeugen.
    if (name === 'hex' && !kontext.antwort) return await hexTool.handler(kontext.aktiv ? { ...args, token: request.params.arguments?.token ?? process.env.SYNAPSE_AGENT_TOKEN } : args) as { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    // RV9: API verantwortet DB, Audit und Antwort-Hooks; stdio reicht die fertige Antwort weiter.
    if (name === 'reverse' && !kontext.antwort) return await reverseTool.handler(kontext.aktiv ? { ...args, project: args.project, agent_id: args.agent_id, token: request.params.arguments?.token ?? process.env.SYNAPSE_AGENT_TOKEN } : args) as { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    const _t0 = Date.now();

    // Globale Parameter fuer Agent-Onboarding extrahieren
    // P22-T55: mit Ausweis zaehlt der Principal, nie ein agent_id-Fachfilter (files.history/chat.get).
    const agentId = kontext.principal?.agent_id ?? (args?.agent_id as string | undefined);
    const projectName = args?.project as string | undefined;
    const role = args?.role as import('./tools/onboarding.js').AgentRole | undefined;

    // First-Use-Hint: pro (Session, Tool) genau einmal die Tool-Doku anhaengen.
    // sessionKey = agent_id wenn gesetzt, sonst Server-Instance-ID (Fallback fuer
    // anonyme Calls in derselben MCP-Session).
    const sessionKey = kontext.principal
      ? `${kontext.principal.identitaet.id}:${kontext.principal.context_epoch}`
      : agentId ?? SERVER_INSTANCE_ID;
    const firstUseKey = `${sessionKey}:${name}`;
    let toolGuideHint: Record<string, unknown> | null = null;
    // P22-T13 Paket C: abgeschalteter tool_guide wird weder gebaut noch als gezeigt markiert.
    if (!firstUseHinted.has(firstUseKey) && hinweisAktiv('tool_guide')) {
      // P22-T131: First-Use-Guide mit agent_kennung bei Schalter agent_kennung_werbung EIN.
      toolGuideHint = await guideFuerKennung(buildFirstUseHint(name), kontext.principal?.project ?? null);
      // Auch bei null markieren — kein "Retry" wenn Tool im Guide fehlt
      firstUseHinted.add(firstUseKey);
    }

    // Post-Hoc-Decorator: Haengt den First-Use-Hint an JEDE finale Tool-Response —
    // egal ob der Pfad ueber withOnboarding lief oder bypass-Sonderlogik (chat.list,
    // event.ack, etc.). Idempotent: nur einmal pro Response, nur wenn nicht schon drin.
    const attachToolGuide = (resp: { content: Array<{ type: string; text: string }>; isError?: boolean }) => {
      if (!toolGuideHint) return resp;
      const first = resp.content?.[0];
      if (!first || first.type !== 'text' || typeof first.text !== 'string') return resp;
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return resp;
        if ('tool_guide' in parsed) return resp; // schon angehaengt (z.B. via withOnboarding)
        parsed.tool_guide = toolGuideHint;
        first.text = JSON.stringify(parsed, null, 2);
      } catch { /* nicht-JSON Response — kein Decorate moeglich, lassen */ }
      return resp;
    };

    /**
     * PUNKT 2.2 — Regeln, die ueber eine "bei:"-Marke an diesen Aufruf gebunden sind, an das
     * Ergebnis haengen. Die Auswahl-Logik steht EINMAL in core (services/werkzeug-regeln.ts);
     * hier steht nur das Auspacken des JSON-Strings, das sich zwischen den Oberflaechen
     * unterscheidet. Kein zweiter Mechanismus neben dem REST-Weg.
     *
     * ⚠️ OHNE agent_id-BEDINGUNG, und deshalb wird es vor der Schranke in attachResponseHooks
     * aufgerufen. Vorbild ist attachToolGuide, das ebenfalls ohne Identitaet arbeitet.
     * ⚠️ KEINE PRAEVENTION: die Warnung erscheint MIT dem Ergebnis, nicht davor. Es gibt in
     * diesem System keinen Haken vor der Ausfuehrung.
     * Aendert die Antwortform nicht: Arrays werden uebersprungen, sonst wird ein Feld ergaenzt.
     */
    const haengeWerkzeugRegelnAn = async (
      resp: { content: Array<{ type: string; text: string }>; isError?: boolean },
    ): Promise<void> => {
      const first = resp.content?.[0];
      if (!first || first.type !== 'text' || typeof first.text !== 'string') return;
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
        const { holeWerkzeugRegeln, WERKZEUG_REGEL_FELD } = await import('@synapse/core');
        if (WERKZEUG_REGEL_FELD in parsed) return;
        const regeln = await holeWerkzeugRegeln(
          projectName,
          name,
          typeof args?.action === 'string' ? args.action : undefined,
          agentId,
        );
        if (regeln.length === 0) return;
        parsed[WERKZEUG_REGEL_FELD] = regeln;
        first.text = JSON.stringify(parsed, null, 2);
      } catch { /* Eine Anreicherung darf einen Tool-Aufruf niemals brechen. */ }
    };


    const attachResponseHooks = async (
      resp: { content: Array<{ type: string; text: string }>; isError?: boolean },
    ) => {
      const guided = attachToolGuide(resp);
      // ⚠️ MUSS VOR DER agent_id-SCHRANKE STEHEN (naechste Zeile). Werkzeug-gebundene Regeln
      // haengen an der HANDLUNG, nicht an einer Identitaet — von 23 gemessenen
      // specialist(purge)-Aufrufen hatten 18 keine agent_id.
      await haengeWerkzeugRegelnAn(guided);
      await haengeAusloeserTextHinweiseAn(guided, name, (args ?? {}) as Record<string, unknown>, agentId);
      // P23-T5: vor der agent_id-Schranke - der Hinweis gilt auch fuer Aufrufe ohne Identitaet.
      await haengeFallSkillTextHinweisAn(guided, name, fallOpt);
      if (!agentId) return guided;
      const first = guided.content?.[0];
      if (!first || first.type !== 'text' || typeof first.text !== 'string') return guided;
      try {
        const erweitert = await ergaenzeToolHinweise(JSON.parse(first.text), name, (args ?? {}) as Record<string, unknown>, agentId);
        first.text = JSON.stringify(erweitert, null, 2);
        if (typeof erweitert !== 'object' || erweitert === null || Array.isArray(erweitert)) return guided;
        const parsed = erweitert as Record<string, unknown>;

        // CE-7: Jede erweiterbare Objektantwort wird zur Inbox-Gelegenheit.
        // event ist die Vollansicht und guide bleibt bewusst kontextfrei.
        if (projectName && name !== 'event' && name !== 'guide') {
          try {
            const pendingEvents = await getPendingEventHints(projectName, agentId, 3);
            if (pendingEvents.hints.length > 0) {
              parsed.pending_events = pendingEvents.hints;
              first.text = JSON.stringify(parsed, null, 2);
            }

            const warnung = await pruefeEventEskalation(projectName, agentId, pendingEvents.urgent);
            if (warnung) {
              parsed.event_warning = warnung;
              first.text = JSON.stringify(parsed, null, 2);
            }
          } catch { /* Pending-Events duerfen Toolantworten nie brechen */ }
        }



        // Offene Multi-File-Plaene (laufen seit 28.09.2026 nicht mehr ab). Gedrosselt je
        // Agent in claimOpenPlanHints: eigene Aenderungen sofort, sonst 30 Min bei files/plan.
        // P22-T50: nicht fuer '*' (alle Projekte) und nicht in chat(anmelden) (alte files-Plaene sind dort Ballast).
        if (typeof args?.project === 'string' && args.project && args.project !== '*' && !(name === 'chat' && args.action === 'anmelden')) {
          try {
            const planHints = await claimOpenPlanHints(args.project, agentId, Date.now(), !!parsed.agentOnboarding, name);
            if (planHints) {
              parsed.open_plans = planHints;
              first.text = JSON.stringify(parsed, null, 2);
            }
          } catch { /* Hinweise duerfen Toolantworten nie brechen */ }
        }

        // JEV-11 (P7-T30): bei aktivem jev-Schalter EINE kurze Zeile jev_modus, sonst nichts.
        // Das jev-Tool selbst ist ausgenommen (seine Antworten tragen den Hinweis schon).
        if (name !== 'jev' && typeof args?.project === 'string' && args.project) {
          try {
            const { holeJevSitzungsHinweis } = await import('@synapse/core');
            const jevModus = await holeJevSitzungsHinweis(args.project, agentId, !!parsed.agentOnboarding);
            if (jevModus) {
              parsed.jev_modus = jevModus;
              first.text = JSON.stringify(parsed, null, 2);
            }
          } catch { /* Hinweise duerfen Toolantworten nie brechen */ }
        }

        // P15-T17 E0: Fehlermuster-Treffer der eigenen Schreibvorgaenge (vorher nur im Log).
        // Wartet kurz auf eine noch laufende Pruefung, sonst Nachlieferung mit der naechsten Antwort.
        try {
          const { holeFehlermusterHinweise } = await import('@synapse/core');
          const fehlermuster = await holeFehlermusterHinweise(agentId);
          if (fehlermuster) {
            parsed.fehlermuster = fehlermuster;
            first.text = JSON.stringify(parsed, null, 2);
          }
        } catch { /* Hinweise duerfen Toolantworten nie brechen */ }

        // ⚠️ MEMORY, GEDANKE UND TASK SIND EBENFALLS HINWEISGEBER (Vorgabe des Users,
        // 02.08.2026). Ein Skillname steht genauso in einer Memory oder einer Task wie in
        // einer Channel-Nachricht. Wer nie einen Channel betritt, bekam vorher nie einen
        // Vorschlag. Gilt schreibend UND lesend: der haeufige Fall ist, dass einer die Task
        // anlegt und ein anderer den Auftrag bekommt, genau sie abzurufen.
        // Die Dedup bleibt global je Agent — kein Skill wird zweimal gezeigt, egal woher.
        if (name === 'memory' || name === 'thought' || name === 'plan') {
          // P23-T8: Namenstreffer nur aus den Quellen DIESES Aufrufs (holeSkillVorschlaegeFuerAufruf).
          const { holeSkillVorschlaegeFuerAufruf } = await import('@synapse/core');
          const weitere = await holeSkillVorschlaegeFuerAufruf(
            name,
            args?.action as string | undefined,
            (args ?? {}) as Record<string, unknown>,
            parsed,
            agentId,
          );
          if (weitere.suggestions.length > 0) {
            parsed.skill_suggestions = weitere.suggestions;
            parsed.skill_hook_metrics = weitere.metrics;
            first.text = JSON.stringify(parsed, null, 2);
          }
        } else if (name !== 'skills' && agentId && !('skill_suggestions' in parsed)) {
          // P23-T1 (2c): an allen uebrigen Tools nur die 99%-Kette nachliefern (vorgegebene und verknuepfte
          // Skills, P23-T8 KETTEN_QUELLEN), bis der Agent sie gesehen hat - wie im REST-Pfad.
          const { holeOffeneSkillVorschlaege, KETTEN_SCORE } = await import('@synapse/core');
          const kette = await holeOffeneSkillVorschlaege(agentId, undefined, undefined, { mindestScore: KETTEN_SCORE });
          if (kette.suggestions.length > 0) {
            parsed.skill_suggestions = kette.suggestions;
            parsed.skill_hook_metrics = kette.metrics;
            first.text = JSON.stringify(parsed, null, 2);
          }
        }
      } catch { /* Response-Hooks duerfen Toolantworten nie brechen */ }
      return guided;
    };

    // Helper: Ergebnis mit Onboarding erweitern
    const withOnboarding = async (result: Record<string, unknown>) => {
      if (!agentId || !projectName) {
        const out: Record<string, unknown> = { ...result };
        if (toolGuideHint) out.tool_guide = toolGuideHint;
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      const registrierung = name === 'chat' && ['register', 'register_batch'].includes(String(args?.action));
      const onboarding = result.agentOnboarding || registrierung ? null : await checkAgentOnboarding(projectName, agentId, undefined, role);
      const enhanced: Record<string, unknown> = { ...result };
      if (toolGuideHint) enhanced.tool_guide = toolGuideHint;

      // Onboarding-Regeln bei erstem Besuch
      if (onboarding?.isFirstVisit) {
        // ⚠️ HIER WURDEN BIS ZUM 15.08.2026 DREI FELDER VON HAND KOPIERT und alles andere
        // stillschweigend verworfen. Was checkAgentOnboarding zusaetzlich liefert, kam damit
        // NIE beim Agenten an: rolle/rolle_quelle/rolle_hinweis (das Rollen-Protokoll, das
        // eine Fehleinstufung ueberhaupt erst sichtbar macht), volltext_hinweis (WIE man an
        // eine gekuerzte Regel kommt — ohne ihn ist die Kuerzung eine Unterschlagung) und
        // seit CH-1 die Channel-Uebersicht. Ueber die REST-API kamen sie an, hier nicht:
        // eine stille Abweichung zwischen zwei Strecken, die beide plausibel antworten.
        // JETZT: alles durchreichen, was das Onboarding erzeugt hat, und nur die Anzeige-
        // Nachricht ergaenzen. Ein neues Feld im Onboarding ist damit sofort auf beiden Wegen
        // da, statt auf sein Nachtragen an dieser Stelle zu warten.
        enhanced.agentOnboarding = {
          ...onboarding,
          isFirstVisit: true,
          message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
        };
      }



      // Aktive Agenten anzeigen (kompakte Einblendung)
      try {
        const agentList = await listAgents(projectName);
        if (enhanced.agentOnboarding && agentList.success && agentList.agents.length > 0) {
          const others = agentList.agents.filter(a => a.id !== agentId);
          if (others.length > 0) {
            // ⚠️ KEINE OBJEKTLISTE MEHR (15.08.2026, User-Vorgabe). Hier stand zusaetzlich ein
            // agents[] mit {id, model, isYou} je Agent — an JEDER Tool-Antwort, bei acht
            // Agenten rund vierzig Zeilen JSON. Der hint darunter sagt dasselbe in einer Zeile,
            // inklusive der Markierung, welcher Eintrag der eigene ist. Das model war dabei
            // fast durchweg null, weil es nur beim Registrieren gesetzt wird.
            // Wer die Liste strukturiert braucht: chat(action:"list").
            enhanced.activeAgents = {
              count: others.length + 1,
              hint: `👥 Aktive Agenten: ${agentList.agents.map(a => a.id === agentId ? `${a.id} (du)` : a.id).join(', ')}`,
            };
          }
        }
      } catch { /* Agenten-Liste darf nicht crashen */ }

      return { content: [{ type: 'text', text: JSON.stringify(enhanced, null, 2) }] };
    };

    // ═══════════════════════════════════════════════════════════════════════════════════
    // PA-1 (15.08.2026, User-Vorgabe): UNBEKANNTER PARAMETER IST EIN FEHLER.
    //
    // Vorher wurde ein Feld, das im Schema nicht steht, stillschweigend verworfen — und die
    // Aktion lief trotzdem, mit der Bedeutung, die sie OHNE das Feld hat. So archivierte der
    // Koordinator am 15.08. den Standardchannel, statt nur dessen Nachrichten auszublenden:
    // der Server kannte bis_nachricht_id noch nicht und meldete Erfolg.
    //
    // Die Pruefung steht VOR dem switch und vor jedem Seiteneffekt. Sie soll den Aufruf
    // verhindern, nicht ihn hinterher kommentieren.
    // ═══════════════════════════════════════════════════════════════════════════════════
    // P22-T160: wie REST - Objekt-/Listen-Parameter als JSON-Text laut Schema zurueckwandeln (vor PA-1 und jedem Handler).
    koerziereJsonParameter(JSON_PARAMETER_TYPEN.get(name), args as Record<string, unknown> | undefined);
    const parameterBefund = pruefeUnbekannteParameter(
      name,
      ERLAUBTE_PARAMETER.get(name) ?? new Set<string>(),
      args as Record<string, unknown> | undefined,
    );
    if (parameterBefund) {
      // Auch der abgelehnte Aufruf gehoert ins Protokoll — sonst sieht niemand, wie oft die
      // Regel greift und welche Parameter die Agenten wirklich schicken.
      void logToolCall({
        project: typeof projectName === 'string' ? projectName : null,
        agentId: resolveAgentId(typeof agentId === 'string' ? agentId : null),
        source: 'stdio',
        tool: name,
        action: typeof args?.action === 'string' ? (args.action as string) : null,
        argsPreview: toolArgsVorschau(args ?? {}),
        ok: false,
        error: `unbekannter_parameter: ${parameterBefund.unbekannt.join(', ')}`,
        durationMs: Date.now() - _t0,
        result: null,
      });

      return kompaktiereTextErgebnis({
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'unbekannter_parameter',
            tool: name,
            unbekannte_parameter: parameterBefund.unbekannt,
            message: parameterBefund.meldung,
          }, null, 2),
        }],
        isError: true,
      }, name);
    }

    // P13-T34/A16: asset_intel/code_intel MIT ansicht -> API (Hooks, Audit, Bild kommen von dort);
    // Textteil + image-Bloecke unveraendert wie bei reverse. Ohne ansicht bleibt der Weg wie bisher.
    if ((name === 'asset_intel' || name === 'code_intel') && hatAnsichtParameter(args as Record<string, unknown> | undefined)) {
      return await rufeAnsichtApi(name, kontext.aktiv ? { ...args, project: args.project, agent_id: args.agent_id, token: request.params.arguments?.token ?? process.env.SYNAPSE_AGENT_TOKEN } : args);
    }

    const baseResp = await (async () => {
    try {
      if (kontext.antwort) return withOnboarding(kontext.antwort);
      switch (name) {
        case 'project':
          return withOnboarding(await projectTool.handler(args as Record<string, unknown>));

        case 'search':
          return withOnboarding(await searchTool.handler(args as Record<string, unknown>));

        case 'memory':
          return withOnboarding(await memoryTool.handler(args as Record<string, unknown>));

        case 'thought':
          return withOnboarding(await thoughtTool.handler(args as Record<string, unknown>));

        case 'proposal':
          return withOnboarding(await proposalTool.handler(args as Record<string, unknown>));

        case 'plan':
          return withOnboarding(await planTool.handler(args as Record<string, unknown>));

        case 'chat': {
          const chatAction = (args as Record<string, unknown>)?.action as string;

          // SONDER-LOGIK: "register" mit Specialist-Info
          if (chatAction === 'register') {
            const regId = (args as Record<string, unknown>)?.id as string;
            const regProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const regProject = (args as Record<string, unknown>)?.project as string;
            const regModel = (args as Record<string, unknown>)?.model as string | undefined;
            const regCutoffDate = (args as Record<string, unknown>)?.cutoff_date as string | undefined;

            const result = await registerChatAgent(regId, regProject, regModel, regCutoffDate);
            // Specialist-System: Pruefen ob dieser Agent ein Spezialist ist
            const regEnriched: Record<string, unknown> = { ...result };
            if (regProjectPath) {
              try {
                const specStatus = await readStatus(regProjectPath);
                if (specStatus.specialists[regId]) {
                  regEnriched.specialistInfo = {
                    isSpecialist: true,
                    specialistStatus: specStatus.specialists[regId].status,
                  };
                }
              } catch { /* Specialist-Status nicht verfuegbar */ }
            }
            return { content: [{ type: 'text', text: JSON.stringify(regEnriched, null, 2) }] };
          }

          // SONDER-LOGIK: "register_batch"
          if (chatAction === 'register_batch') {
            const agentsList = (args as Record<string, unknown>)?.agents as Array<{ id: string; model?: string; cutoffDate?: string }>;
            const batchProject = (args as Record<string, unknown>)?.project as string;
            const result = await registerChatAgentsBatch(agentsList, batchProject);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "send" mit Specialist Dual-Path Routing
          if (chatAction === 'send') {
            const senderId = (args as Record<string, unknown>)?.sender_id as string;
            const rawRecipientId = (args as Record<string, unknown>)?.recipient_id;
            const content = (args as Record<string, unknown>)?.content as string;
            const project = (args as Record<string, unknown>)?.project as string;
            const sendProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;

            // Array-Support: Multicast an mehrere Empfaenger
            if (Array.isArray(rawRecipientId)) {
              const recipientIds = rawRecipientId as string[];
              const results: Array<Record<string, unknown>> = [];
              const errors: string[] = [];
              for (const rid of recipientIds) {
                try {
                  // Specialist-Routing pro Empfaenger
                  if (sendProjectPath) {
                    try {
                      const specStatus = await readStatus(sendProjectPath);
                      if (specStatus.specialists[rid]) {
                        const inboxResult = await postToInbox(senderId, rid, content, project);
                        results.push({ success: true, routed: 'specialist_inbox', recipient: rid, ...inboxResult });
                        continue;
                      }
                    } catch { /* Specialist-Status nicht verfuegbar */ }
                  }
                  const r = await sendChatMessage(project, senderId, content, rid);
                  results.push(r as Record<string, unknown>);
                } catch (err) {
                  errors.push(`${rid}: ${err}`);
                }
              }
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              try {
                await server.sendLoggingMessage({
                  level: 'info',
                  data: `📨 Chat [${senderId} → Multicast(${recipientIds.join(',')})]: ${preview}`,
                });
              } catch { /* Logging nicht verfuegbar */ }
              return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, errors, action: 'send' }, null, 2) }] };
            }

            const recipientId = typeof rawRecipientId === 'string' ? rawRecipientId : undefined;

            // Dual-path: Specialist-Routing wenn project_path angegeben
            if (sendProjectPath) {
              try {
                const specStatus = await readStatus(sendProjectPath);

                // Recipient ist ein Spezialist → direkt in die Inbox routen
                if (recipientId && specStatus.specialists[recipientId]) {
                  const inboxResult = await postToInbox(senderId, recipientId, content, project);
                  const target = `DM an ${recipientId}`;
                  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
                  try {
                    await server.sendLoggingMessage({
                      level: 'info',
                      data: `📨 Chat [${senderId} → ${target}] (specialist-inbox): ${preview}`,
                    });
                  } catch { /* Logging nicht verfuegbar */ }
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({ success: true, routed: 'specialist_inbox', ...inboxResult }, null, 2),
                    }],
                  };
                }

                // Broadcast und Spezialisten laufen → auch in general-channel posten
                if (!recipientId) {
                  const runningCount = Object.values(specStatus.specialists).filter(s => s.status === 'running').length;
                  if (runningCount > 0) {
                    try {
                      await postMessage(project, `${project}-general`, senderId, content);
                    } catch { /* Channel existiert noch nicht */ }
                  }
                }
              } catch { /* Specialist-Status nicht verfuegbar, legacy fallback */ }
            }

            // Legacy-Pfad (auch als Fallback wenn kein project_path)
            const result = await sendChatMessage(project, senderId, content, recipientId);

            // Broadcast-Notification an den Client: Neue Chat-Nachricht!
            if (result.success) {
              const target = recipientId ? `DM an ${recipientId}` : 'Broadcast';
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              try {
                await server.sendLoggingMessage({
                  level: 'info',
                  data: `📨 Chat [${senderId} → ${target}]: ${preview}`,
                });
              } catch { /* Logging nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "get" mit persistentem Core-Lesestand + Specialist Inbox
          if (chatAction === 'get') {
            if (args?.message_id !== undefined) {
              return withOnboarding(await chatTool.handler(args as Record<string, unknown>));
            }
            const getMsgProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const getMsgAgentId = (args as Record<string, unknown>)?.agent_id as string | undefined;
            const getMsgProject = (args as Record<string, unknown>)?.project as string;
            const result = await getChatMessages(getMsgProject, {
              agentId: getMsgAgentId,
              since: (args as Record<string, unknown>)?.since as string | undefined,
              senderId: (args as Record<string, unknown>)?.sender_id_filter as string | undefined,
              limit: (args as Record<string, unknown>)?.limit as number | undefined,
            });

            // Dual-path: Specialist-Inbox-Nachrichten anfuegen wenn project_path vorhanden
            if (getMsgProjectPath && getMsgAgentId) {
              try {
                const specStatus = await readStatus(getMsgProjectPath);
                if (Object.keys(specStatus.specialists).length > 0) {
                  const inboxMessages = await checkInbox(getMsgAgentId, (args as Record<string, unknown>)?.project as string);
                  if (inboxMessages.length > 0) {
                    const inboxResult: Record<string, unknown> = {
                      ...(typeof result === 'object' && result !== null ? result : { messages: [] }),
                      specialistInbox: inboxMessages.map(m => ({
                        id: m.id,
                        from: m.fromAgent,
                        content: m.content,
                        createdAt: m.createdAt,
                      })),
                    };
                    return { content: [{ type: 'text', text: JSON.stringify(inboxResult, null, 2) }] };
                  }
                }
              } catch { /* Specialist-Inbox nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "list" mit Specialist-Merge
          if (chatAction === 'list') {
            const listProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const listProject = (args as Record<string, unknown>)?.project as string;
            const result = await listAgents(listProject);

            // Dual-path: Spezialisten anfuegen wenn project_path vorhanden
            if (listProjectPath) {
              try {
                const specStatus = await readStatus(listProjectPath);
                const specialists = Object.entries(specStatus.specialists).map(([specName, s]) => ({
                  id: specName,
                  isSpecialist: true,
                  status: s.status,
                  model: s.model,
                  currentTask: s.currentTask,
                  lastActivity: s.lastActivity,
                }));
                if (specialists.length > 0) {
                  const enrichedList: Record<string, unknown> = {
                    ...(typeof result === 'object' && result !== null ? result : {}),
                    specialists,
                  };
                  return { content: [{ type: 'text', text: JSON.stringify(enrichedList, null, 2) }] };
                }
              } catch { /* Specialist-Status nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // Alle anderen chat-actions (unregister, unregister_batch, inbox_send, inbox_check)
          return withOnboarding(await chatTool.handler(args as Record<string, unknown>));
        }

        case 'channel':
          return withOnboarding(await channelTool.handler(args as Record<string, unknown>));

        case 'event': {
          const eventAction = (args as Record<string, unknown>)?.action as string;

          // Einzel-/Mehrfach-ACK; Eskalationen verfolgen die betroffenen Event-IDs im Core.
          if (eventAction === 'ack') {
            const eventIdRaw = (args as Record<string, unknown>)?.event_id;
            const ackAgentId = (args as Record<string, unknown>)?.agent_id as string;
            const reaction = (args as Record<string, unknown>)?.reaction as string | undefined;

            // Array-Support: Mehrere Events in einem Call bestätigen
            if (Array.isArray(eventIdRaw)) {
              const eventIds = eventIdRaw as number[];
              const settled = await Promise.allSettled(
                eventIds.map(eid => acknowledgeEventTool(eid, ackAgentId, reaction))
              );
              const results: Array<Record<string, unknown>> = [];
              const errors: string[] = [];
              for (const r of settled) {
                if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
                else errors.push(String(r.reason));
              }
              return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, errors }, null, 2) }] };
            }

            // Bestehend: Einzelnes Event
            const eventId = eventIdRaw as number;
            const result = await acknowledgeEventTool(eventId, ackAgentId, reaction);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          return withOnboarding(await eventTool.handler(args as Record<string, unknown>));
        }

        case 'specialist':
          return withOnboarding(await specialistTool.handler(args as Record<string, unknown>));

        case 'docs':
          return withOnboarding(await docsTool.handler(args as Record<string, unknown>));

        case 'admin':
          return withOnboarding(await adminTool.handler(args as Record<string, unknown>));

        case 'code_intel':
          return withOnboarding(await codeIntelTool.handler(args as Record<string, unknown>));

        case 'asset_intel':
          return withOnboarding(await assetIntelTool.handler(args as Record<string, unknown>));

        case 'code_check':
          return withOnboarding(await codeCheckTool.handler(args as Record<string, unknown>));

        case 'ignore':
          return withOnboarding(await ignoreTool.handler(args as Record<string, unknown>));

        case 'free_models':
          return withOnboarding(await freeModelsTool.handler(args as Record<string, unknown>));

        case 'jev':
          return withOnboarding(await jevTool.handler(args as Record<string, unknown>));

        case 'files':
          return withOnboarding(await filesTool.handler(args as Record<string, unknown>));

        case 'shell':
          return withOnboarding(await shellTool.handler(args as Record<string, unknown>));

        case 'guide':
          return withOnboarding(await guideTool.handler(args as Record<string, unknown>));

        default:
          throw new Error(`Unbekanntes Tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          },
        ],
        isError: true,
      };
    }
    })();
    // Activity-Log (best-effort, non-blocking) — stdio-Pfad.
    const _resp = baseResp as { content?: Array<{ text?: string }>; isError?: boolean };
    const _text = _resp.content?.[0]?.text ?? null;
    void logToolCall({
      project: typeof projectName === 'string' ? projectName : null,
      agentId: resolveAgentId(typeof agentId === 'string' ? agentId : null),
      source: 'stdio',
      tool: name,
      action: typeof (args as Record<string, unknown> | undefined)?.action === 'string' ? ((args as Record<string, unknown>).action as string) : null,
      argsPreview: toolArgsVorschau(args ?? {}),
      ok: !_resp.isError,
      error: _resp.isError ? (_text ?? 'error') : null,
      durationMs: Date.now() - _t0,
      result: _text,
    });
    // P10-T51 (K2): nach ALLEN Anhaengen einmal kompakt serialisieren (null-Felder weg, keine
    // Einrueckung, success ergaenzt) — derselbe Helfer wie auf dem REST-Weg.
    // P22-T13 Paket C (K16.4/K16.7): Audit (logToolCall oben) bleibt vollstaendig; nur die Agentenauslieferung
    // wird projiziert. Ohne Snapshot/Schalter antwortanpassung unveraendert (t109).
    return kompaktiereTextErgebnis(
      projiziereTextAntwort(await attachResponseHooks(
        baseResp as { content: Array<{ type: string; text: string }>; isError?: boolean },
      ), name, typeof args?.action === 'string' ? args.action : undefined),
      name,
      typeof args?.action === 'string' ? args.action : undefined,
    );
    }, process.env.SYNAPSE_AGENT_TOKEN, ERLAUBTE_PARAMETER.get(name));
  });

  return server;
}

/**
 * Startet den MCP Server
 */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error('[Synapse MCP] Server gestartet (v0.2.0)');

  // Step 0: Haupt-DB-Schema PRUEFEN (P7-T14) — nicht mehr ausfuehren: das Anlegen/Migrieren sperrt alle
  // Produktions-Tabellen ~2,3 s und gehoert dem API-Start (bei jedem stdio-Start blockierte es die Produktion).
  // Leere DB -> einmal anlegen; sonst nur Hinweiszeile bei veraltetem Stand. SYNAPSE_SCHEMA=ausfuehren erzwingt.
  // Wichtig: VOR ensureAgentsSchema() und dem ersten Tool-Call.
  try {
    await stelleSchemaSicher('pruefen');
  } catch (err) {
    console.error('[Synapse] Schema-Pruefung fehlgeschlagen — Tools koennten Schema-Fehler werfen:', err);
  }

  // Step 1: Ensure agents DB schema exists before any tools are used
  await ensureAgentsSchema();

  // P16-T4: Syntaxpruefer Stufe 1 fuer files plan/commit und Einzelschreibweg dieses Prozesses.
  // Ein Worker je stdio-Prozess (es laufen viele davon); SYNTAX_WORKER_THREADS ueberschreibt, SYNTAXPRUEFUNG=0 = aus.
  try {
    const { registriereStandardSyntaxPruefer } = await import('@synapse/core');
    registriereStandardSyntaxPruefer({ threads: 1 });
  } catch (err) {
    console.error('[Synapse MCP] Syntaxpruefer-Anmeldung fehlgeschlagen (Schreibweg ohne Syntaxpruefung):', err);
  }

  // Step 2: Reconnect to running specialists and clean up orphans for all known projects
  const cliInfo = detectClaudeCli();
  if (cliInfo.available) {
    for (const activeProjectName of listActiveProjects()) {
      const projectPath = getProjectPath(activeProjectName);
      if (!projectPath) continue;

      const orphans = await heartbeatController.cleanupOrphans(projectPath);
      if (orphans.length > 0) {
        console.error(`[Synapse] Cleaned up ${orphans.length} orphaned agent sockets for "${activeProjectName}"`);
      }

      const reconnected = await heartbeatController.reconnectAll(projectPath);
      if (reconnected.connected.length > 0) {
        console.error(`[Synapse] Reconnected to ${reconnected.connected.length} running specialists for "${activeProjectName}"`);
      }
      if (reconnected.cleaned.length > 0) {
        console.error(`[Synapse] Cleaned up ${reconnected.cleaned.length} stale specialist entries for "${activeProjectName}"`);
      }
    }
  }
}
