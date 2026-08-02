/**
 * Synapse API — Agenten-Wissen (API-Bruecke, Schritt 4)
 *
 * ZWECK: Das Wissen eines Spezialisten und sein System-Prompt liegen heute als
 * Dateien unter .synapse/agents/<name>/ auf der Platte, auf der der Daemon laeuft.
 * Damit ist ein Spezialist an seine Maschine gebunden. Diese Routen legen dasselbe
 * Wissen in die Datenbank und machen es ueber HTTP erreichbar.
 *
 * ADDITIV: keine bestehende Route wird veraendert, der Dateiweg bleibt vollstaendig.
 * Diese Routen werden erst benutzt, wenn die Aufruferseite (packages/agents,
 * packages/mcp-server) es ausdruecklich verlangt.
 *
 * ABBILDUNG (Quelle: packages/agents/src/skills.ts, packages/mcp-server/src/tools/specialists.ts):
 *   readAllSkillFiles / readSkill  -> GET    .../wissen           (Feld "text")
 *   readSkillFile                  -> GET    .../wissen/:art
 *   writeSkillFile                 -> PUT    .../wissen/:art
 *   appendToSkillFile (update_skill add)    -> POST   .../wissen/:art/anhaengen
 *   update_skill remove            -> DELETE .../wissen/:art/eintraege
 *   createInitialAgent             -> POST   .../wissen/anlegen
 *   purgeAgentDir (DB-Anteil)      -> DELETE .../wissen
 *   system-prompt.txt              -> GET/PUT .../wissen/system_prompt
 *
 * SICHTBARKEIT (die Frage "woran wuerde ich merken, dass es kaputt ist"):
 * Der gefaehrliche Fall ist hier kein Fehler, sondern LEERE. Ein Agent, dessen
 * Wissen nicht ankommt, startet ohne Regeln und sieht dabei voellig normal aus.
 * Deshalb:
 *   - Ein UNBEKANNTER Agent gibt 404, nicht 200 mit leerem Inhalt. Genau daran
 *     entscheidet der Spawner, ob er das Wissen neu anlegt; faellt die
 *     Unterscheidung zusammen, ueberschreibt jeder Spawn die gelernten Regeln.
 *   - Jede schreibende Route gibt eine ZAHL zurueck (ersetzte/entfernte/geloeschte
 *     Zeilen), keine blosse Erfolgsmeldung.
 *   - GET .../wissen liefert leer, zeilen_gesamt und warnungen.
 *   - Ein leerer System-Prompt gibt 404, nicht 200 mit "". Ein leerer Prompt macht
 *     keinen Fehler, er macht einen dummen Agenten.
 *   - GET /api/projects/:name/agent-wissen/health zeigt die Zaehler.
 */

import { FastifyInstance } from 'fastify';
import {
  leseAgentWissen,
  leseWissensArt,
  setzeWissen,
  haengeWissenAn,
  entferneWissenZeilen,
  legeAgentWissenAn,
  loescheAgentWissen,
  listeWissensAgenten,
  normalisiereArt,
  erlaubteArten,
  type WissensArt,
  type ArtSicht,
} from '@synapse/core';

/** Zaehler fuer GET .../agent-wissen/health. Prozesslokal, bewusst kein Speicher. */
const zaehler = {
  lesen: 0,
  lesenUnbekannt: 0,
  lesenLeer: 0,
  lesenArt: 0,
  setzen: 0,
  anhaengen: 0,
  entfernen: 0,
  entfernenOhneTreffer: 0,
  anlegen: 0,
  anlegenSchonDa: 0,
  loeschen: 0,
  loeschenLeer: 0,
  promptLesen: 0,
  promptFehlt: 0,
  promptSetzen: 0,
  artUnbekannt: 0,
  fehler: 0,
  seit: new Date().toISOString(),
};

/** Liest ein Feld in mehreren Schreibweisen — der Aufrufer soll nichts umbenennen muessen. */
function feld(body: Record<string, unknown> | undefined, ...namen: string[]): unknown {
  if (!body) return undefined;
  for (const n of namen) {
    if (body[n] !== undefined && body[n] !== null) return body[n];
  }
  return undefined;
}

function alsText(wert: unknown): string | null {
  return typeof wert === 'string' ? wert : null;
}

function artSicht(sicht: ArtSicht): Record<string, unknown> {
  return {
    art: sicht.art,
    text: sicht.text,
    block: sicht.block,
    eintraege: sicht.eintraege,
    anzahl: sicht.anzahl,
  };
}

export async function agentWissenRoutes(fastify: FastifyInstance): Promise<void> {
  const BASIS = '/api/projects/:name/specialists/:specName/wissen';

  /**
   * Loest den :art-Parameter auf. Ein unbekannter Wert gibt 400 mit der Liste der
   * erlaubten Werte — KEIN stilles Ausweichen auf 'regeln'. Der heutige Code faellt
   * an dieser Stelle still auf 'rules' zurueck (specialists.ts:684); ein Tippfehler
   * schriebe damit in die Regeln, ohne dass es jemand bemerkt.
   */
  function loeseArt(roh: string, reply: import('fastify').FastifyReply): WissensArt | null {
    const art = normalisiereArt(roh);
    if (!art) {
      zaehler.artUnbekannt += 1;
      reply.status(400).send({
        success: false,
        error: {
          code: 'unbekannte_art',
          message: `Unbekannte Wissens-Art "${roh}".`,
          erlaubt: erlaubteArten(),
        },
      });
      return null;
    }
    return art;
  }

  /**
   * GET .../wissen — alles auf einmal, so wie readAllSkillFiles es liefert.
   * Das Feld "text" ist der Wortlaut, der woertlich in den System-Prompt geht;
   * er wird hier gebaut, damit ihn niemand nachbaut und die beiden Wege
   * auseinanderlaufen.
   * 404 = zu diesem Agenten existiert KEINE Zeile (entspricht readSkill()===null).
   */
  fastify.get<{ Params: { name: string; specName: string } }>(BASIS, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    zaehler.lesen += 1;
    try {
      const wissen = await leseAgentWissen(project, agent);
      if (!wissen) {
        zaehler.lesenUnbekannt += 1;
        return reply.status(404).send({
          success: false,
          bekannt: false,
          error: {
            code: 'unbekannt',
            message: `Kein Wissen zu "${agent}" in "${project}" hinterlegt.`,
          },
        });
      }
      if (wissen.leer) zaehler.lesenLeer += 1;
      return {
        success: true,
        bekannt: true,
        project,
        agent,
        meta: wissen.meta,
        text: wissen.text,
        arten: {
          regeln: artSicht(wissen.arten.regeln),
          fehler: artSicht(wissen.arten.fehler),
          muster: artSicht(wissen.arten.muster),
          kontext: artSicht(wissen.arten.kontext),
        },
        system_prompt_vorhanden: wissen.systemPromptLaenge > 0,
        system_prompt_laenge: wissen.systemPromptLaenge,
        leer: wissen.leer,
        zeilen_gesamt: wissen.zeilenGesamt,
        warnungen: wissen.warnungen,
        server_time: new Date().toISOString(),
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * GET .../wissen/system_prompt — ROHTEXT, kein Rendern, keine Kopfzeilen.
   * Der Prompt ist ein Erzeugnis aus dem Wissen, kein Wissen; jede Verzierung
   * landete sonst im Kopf des Agenten.
   * ⚠️ 404 auch bei LEEREM Prompt (nicht nur bei fehlendem). Ein 200 mit "" waere
   * fuer den Aufrufer nicht von einem gueltigen Prompt zu unterscheiden, und ein
   * leerer Prompt macht keinen Fehler — er macht einen dummen Agenten.
   * Eigene Route, weil der Wrapper beim Start und nach jeder Rotation NUR den
   * Prompt braucht und nicht das ganze Wissen ziehen soll.
   */
  fastify.get<{ Params: { name: string; specName: string } }>(
    `${BASIS}/system_prompt`,
    async (request, reply) => {
      const { name: project, specName: agent } = request.params;
      zaehler.promptLesen += 1;
      try {
        const sicht = await leseWissensArt(project, agent, 'system_prompt');
        const inhalt = sicht?.block ?? null;
        if (inhalt === null || inhalt.length === 0) {
          zaehler.promptFehlt += 1;
          return reply.status(404).send({
            success: false,
            vorhanden: false,
            laenge: 0,
            error: {
              code: sicht === null ? 'unbekannt' : 'kein_prompt',
              message: `Kein System-Prompt fuer "${agent}" in "${project}" hinterlegt.`,
            },
          });
        }
        return {
          success: true,
          vorhanden: true,
          project,
          agent,
          laenge: inhalt.length,
          inhalt,
          server_time: new Date().toISOString(),
        };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /** PUT .../wissen/system_prompt — der Spawner legt den Prompt ab, statt ihn zu schreiben. */
  fastify.put<{
    Params: { name: string; specName: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/system_prompt`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    const inhalt = alsText(feld(request.body, 'inhalt', 'content', 'prompt'));
    zaehler.promptSetzen += 1;
    if (inhalt === null) {
      return reply
        .status(400)
        .send({ success: false, error: { code: 'inhalt_fehlt', message: 'Feld "inhalt" erwartet.' } });
    }
    try {
      const quelle = alsText(feld(request.body, 'quelle', 'agent_id'));
      const ergebnis = await setzeWissen(project, agent, 'system_prompt', inhalt, quelle);
      return {
        success: true,
        project,
        agent,
        laenge: inhalt.length,
        ersetzte_zeilen: ergebnis.ersetzteZeilen,
        id: ergebnis.id,
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * POST .../wissen/anlegen — createInitialAgent: meta + vier leere Arten.
   * DIE ENTSCHEIDUNG LIEGT HIER, nicht beim Aufrufer: ist der Agent schon bekannt,
   * wird NICHTS angeruehrt und angelegt:false gemeldet. Zwei gleichzeitige Spawns
   * desselben Namens saehen sonst beide "unbekannt" und der zweite raeumte dem
   * ersten das Wissen weg — ueber zwei Aufrufe ist dieser Wettlauf nicht zu
   * gewinnen, in einer Anweisung schon.
   */
  fastify.post<{
    Params: { name: string; specName: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/anlegen`, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    zaehler.anlegen += 1;
    try {
      const model = alsText(feld(request.body, 'model', 'modell')) ?? 'unknown';
      const expertise = alsText(feld(request.body, 'expertise')) ?? 'General';
      const created = alsText(feld(request.body, 'created')) ?? new Date().toISOString().slice(0, 10);
      const quelle = alsText(feld(request.body, 'quelle', 'agent_id'));
      const ergebnis = await legeAgentWissenAn(
        project,
        agent,
        { name: agent, model, expertise, created },
        quelle,
      );
      if (!ergebnis.angelegt) zaehler.anlegenSchonDa += 1;
      return {
        success: true,
        project,
        agent,
        angelegt: ergebnis.angelegt,
        neue_zeilen: ergebnis.neueZeilen,
        grund: ergebnis.angelegt
          ? 'neu angelegt'
          : 'bereits vorhanden — nichts veraendert',
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /** GET .../wissen/:art — eine einzelne Art. 404 = Agent unbekannt (nicht: Art leer). */
  fastify.get<{ Params: { name: string; specName: string; art: string } }>(
    `${BASIS}/:art`,
    async (request, reply) => {
      const { name: project, specName: agent, art: artRoh } = request.params;
      const art = loeseArt(artRoh, reply);
      if (!art) return reply;
      zaehler.lesenArt += 1;
      try {
        const sicht = await leseWissensArt(project, agent, art);
        if (!sicht) {
          zaehler.lesenUnbekannt += 1;
          return reply.status(404).send({
            success: false,
            bekannt: false,
            error: {
              code: 'unbekannt',
              message: `Kein Wissen zu "${agent}" in "${project}" hinterlegt.`,
            },
          });
        }
        return { success: true, bekannt: true, project, agent, ...artSicht(sicht) };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );

  /**
   * PUT .../wissen/:art — die Art vollstaendig ersetzen (= writeSkillFile).
   * ⚠️ Alles Bisherige dieser Art faellt weg, genau wie beim Ueberschreiben einer
   * Datei. ersetzte_zeilen sagt, wie viel weggefallen ist — ein blosses "ok" waere
   * hier wertlos, weil ein Schreiben ins Leere genauso aussaehe.
   */
  fastify.put<{
    Params: { name: string; specName: string; art: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/:art`, async (request, reply) => {
    const { name: project, specName: agent, art: artRoh } = request.params;
    const art = loeseArt(artRoh, reply);
    if (!art) return reply;
    const inhalt = alsText(feld(request.body, 'inhalt', 'content'));
    if (inhalt === null) {
      return reply
        .status(400)
        .send({ success: false, error: { code: 'inhalt_fehlt', message: 'Feld "inhalt" erwartet.' } });
    }
    zaehler.setzen += 1;
    try {
      const quelle = alsText(feld(request.body, 'quelle', 'agent_id'));
      const ergebnis = await setzeWissen(project, agent, art, inhalt, quelle);
      return {
        success: true,
        project,
        agent,
        art,
        laenge: inhalt.length,
        ersetzte_zeilen: ergebnis.ersetzteZeilen,
        id: ergebnis.id,
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * POST .../wissen/:art/anhaengen — ein Eintrag (= update_skill add).
   * Die Datums-Gruppierung liegt hier: EIN INSERT, kein Lesen-Zusammensetzen-
   * Zurueckschreiben. Zwei gleichzeitige Eintraege koennen einander damit nicht
   * mehr verlieren; im Dateiweg ist genau das moeglich.
   */
  fastify.post<{
    Params: { name: string; specName: string; art: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/:art/anhaengen`, async (request, reply) => {
    const { name: project, specName: agent, art: artRoh } = request.params;
    const art = loeseArt(artRoh, reply);
    if (!art) return reply;
    const inhalt = alsText(feld(request.body, 'inhalt', 'content', 'eintrag'));
    if (inhalt === null || inhalt.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'inhalt_fehlt', message: 'Feld "inhalt" erwartet (nicht leer).' },
      });
    }
    zaehler.anhaengen += 1;
    try {
      const quelle = alsText(feld(request.body, 'quelle', 'agent_id'));
      const tag = alsText(feld(request.body, 'tag', 'datum'));
      const ergebnis = await haengeWissenAn(project, agent, art, inhalt, quelle, tag);
      return { success: true, project, agent, art, id: ergebnis.id, tag: ergebnis.tag };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * DELETE .../wissen/:art/eintraege — Zeilen entfernen, die einen Text enthalten
   * (= update_skill remove). Gefiltert wird ZEILENWEISE, genau wie heute.
   * Kein Treffer gibt success:false mit derselben Aussage wie der Dateiweg.
   */
  fastify.delete<{
    Params: { name: string; specName: string; art: string };
    Body: Record<string, unknown>;
  }>(`${BASIS}/:art/eintraege`, async (request, reply) => {
    const { name: project, specName: agent, art: artRoh } = request.params;
    const art = loeseArt(artRoh, reply);
    if (!art) return reply;
    const enthaelt = alsText(feld(request.body, 'enthaelt', 'content', 'contains'));
    if (enthaelt === null || enthaelt.length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'enthaelt_fehlt', message: 'Feld "enthaelt" erwartet (nicht leer).' },
      });
    }
    zaehler.entfernen += 1;
    try {
      const ergebnis = await entferneWissenZeilen(project, agent, art, enthaelt);
      if (ergebnis.entfernteZeilen === 0) {
        zaehler.entfernenOhneTreffer += 1;
        return reply.status(404).send({
          success: false,
          entfernte_zeilen: 0,
          message: `Eintrag "${enthaelt}" nicht gefunden in "${art}" von "${agent}".`,
        });
      }
      return {
        success: true,
        project,
        agent,
        art,
        entfernte_zeilen: ergebnis.entfernteZeilen,
        entfernte_eintraege: ergebnis.entfernteEintraege,
        geaenderte_eintraege: ergebnis.geaenderteZeilen,
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * DELETE .../wissen — alles zu diesem Agenten (= DB-Anteil von purgeAgentDir).
   * Idempotent: kein Fehler, wenn nichts da war. Die ZAHL sagt, ob es etwas gab —
   * ein purge, das nichts findet, soll sichtbar sein und nicht wie Erfolg aussehen.
   */
  fastify.delete<{ Params: { name: string; specName: string } }>(BASIS, async (request, reply) => {
    const { name: project, specName: agent } = request.params;
    zaehler.loeschen += 1;
    try {
      const ergebnis = await loescheAgentWissen(project, agent);
      if (ergebnis.geloeschteZeilen === 0) zaehler.loeschenLeer += 1;
      return {
        success: true,
        project,
        agent,
        geloeschte_zeilen: ergebnis.geloeschteZeilen,
        hinweis:
          ergebnis.geloeschteZeilen === 0
            ? 'Es war nichts hinterlegt — idempotent, aber kein Beleg dafuer, dass es je etwas gab.'
            : undefined,
      };
    } catch (error) {
      zaehler.fehler += 1;
      return reply.status(500).send({ success: false, error: { message: String(error) } });
    }
  });

  /**
   * GET /api/projects/:name/agent-wissen/health — Zaehler und Bestand.
   * Vorbild: GET .../wrapper-bridge/health. Ohne diese Sicht ist "die Routen
   * werden nie gerufen" von "die Routen antworten falsch" nicht zu unterscheiden.
   */
  fastify.get<{ Params: { name: string } }>(
    '/api/projects/:name/agent-wissen/health',
    async (request, reply) => {
      const { name: project } = request.params;
      try {
        const agenten = await listeWissensAgenten(project);
        return {
          success: true,
          project,
          agenten,
          agenten_gesamt: agenten.length,
          zeilen_gesamt: agenten.reduce((summe, a) => summe + a.zeilen, 0),
          zaehler,
          // ⚠️ WO GEZAEHLT WIRD: in DIESEM API-Prozess, nicht beim Aufrufer. Die
          // Zahlen belegen, was die API gesehen hat — NICHT, dass ein Wrapper das
          // Wissen auch bekommen und benutzt hat. Wer das braucht, muss es dort
          // messen, wo der Agent laeuft. (Lehre aus dem Spawner-Selbsttest vom
          // 02.08.2026: eine Pruefung im falschen Prozess ist schlimmer als keine.)
          zaehler_gemessen_in: 'synapse-api-prozess',
          server_time: new Date().toISOString(),
        };
      } catch (error) {
        zaehler.fehler += 1;
        return reply.status(500).send({ success: false, error: { message: String(error) } });
      }
    },
  );
}
