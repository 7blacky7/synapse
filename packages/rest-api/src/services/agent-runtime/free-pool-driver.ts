/**
 * FreeModelPoolDriver — dritte Agent-Runtime neben Claude Code und Codex.
 *
 * Anders als die beiden anderen laeuft hier KEIN Programm in einem Container.
 * Ein Container existiert dort, weil ein echtes CLI ein Dateisystem, eine Shell
 * und eine dauerhafte Anmeldung braucht. Hier sind es HTTPS-Aufrufe gegen
 * OpenAI-kompatible Endpunkte — dafuer genuegt der API-Prozess selbst.
 *
 * Was das fuer das Driver-Interface bedeutet:
 *   - `installed` heisst: mindestens ein Anbieter ist nutzbar.
 *   - `start`/`stop` haben nichts zu starten; sie frischen den Katalog auf.
 *   - `openTerminal` gibt es nicht und wird ehrlich abgelehnt.
 *   - `sendMessage` waehlt einen Kandidaten, streamt, und geht bei einem
 *     Fehlschlag zum naechsten — die Auswahl bleibt dabei immer innerhalb
 *     dessen, was der Pool als erlaubt und erreichbar meldet.
 *
 * Der Gespraechsverlauf liegt bei Synapse: diese Endpunkte kennen keine
 * serverseitigen Sitzungen, jede Anfrage traegt ihren Verlauf selbst.
 */

import {
  searchPool,
  getPoolModel,
  getAufrufZiel,
  getPoolProviders,
  getPoolSnapshot,
  classifyFailure,
  lohntWeiterenVersuch,
  markiereFehlschlag,
  markiereErfolg,
  markiereAnbieterZugang,
  type PoolModel,
  type ClassifiedFailure,
} from '@synapse/core';

import { AgentRuntimeRepository } from './repository.js';
import type {
  AgentRuntimeDriver,
  MainAgentSession,
  RuntimeMessageResult,
  RuntimeStatus,
  RuntimeStreamEvent,
  TerminalSession,
} from './types.js';

/**
 * Wie viele verschiedene Kandidaten eine Nachricht hoechstens durchprobiert.
 *
 * Die ersten Plaetze gehen an je einen anderen Anbieter (Streuung), die
 * restlichen fuellen mit weiteren Modellen auf. Beides wird gebraucht: ein
 * kaputter Anbieter darf nicht alle Versuche fressen, aber ein gedrosseltes
 * Einzelmodell soll auch nicht gleich den ganzen Anbieter kosten.
 */
const MAX_KANDIDATEN = 5;
const ANTWORT_TIMEOUT_MS = 10 * 60_000;

/** Ein Eintrag des Gespraechsverlaufs, wie ihn OpenAI-kompatible Endpunkte erwarten. */
interface ChatNachricht {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Der Verlauf liegt im Sitzungskontext. Faellt er weg oder ist er beschaedigt,
 * beginnt das Gespraech neu — besser als mit halbem Verlauf weiterzureden.
 */
function leseVerlauf(session: MainAgentSession): ChatNachricht[] {
  const roh = session.context?.messages;
  if (!Array.isArray(roh)) return [];
  return roh.filter((eintrag): eintrag is ChatNachricht => {
    if (!eintrag || typeof eintrag !== 'object') return false;
    const { role, content } = eintrag as Record<string, unknown>;
    return (role === 'system' || role === 'user' || role === 'assistant') && typeof content === 'string';
  });
}

export class FreeModelPoolDriver implements AgentRuntimeDriver {
  readonly runtime = 'free-pool' as const;
  readonly label = 'Modell-Pool';
  readonly supportsTerminal = false;

  constructor(private readonly repository: AgentRuntimeRepository) {}

  async configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus> {
    // Das bevorzugte Modell ist die einzige sinnvolle Einstellung; Pfad und
    // Abbild gehoeren zur Container-Welt und werden nur durchgereicht, damit
    // die gemeinsame Tabelle unveraendert bleibt.
    if (input.model) {
      const treffer = await getPoolModel(input.model);
      if (!treffer) {
        throw new Error(
          'Modell "' + input.model + '" steht im Pool nicht zur Verfuegung. '
          + 'Verfuegbare Modelle liefert das Werkzeug free_models.',
        );
      }
      if (!treffer.allowed) {
        throw new Error(
          'Modell "' + treffer.ref + '" ist nicht freigegeben (Kostenklasse: ' + treffer.costClass + '). '
          + 'Kostenpflichtige und unklare Modelle brauchen eine ausdrueckliche Freigabe in der Oberflaeche.',
        );
      }
    }
    await this.repository.configure(this.runtime, input.rootPath, input.image ?? 'n/a', input.model ?? null);
    return this.status();
  }

  async setup(): Promise<RuntimeStatus> {
    // Nichts zu installieren — aber der Katalog wird frisch geholt, damit
    // "einrichten" etwas Sichtbares tut.
    await getPoolSnapshot(true);
    return this.status();
  }

  async start(): Promise<RuntimeStatus> {
    await getPoolSnapshot(true);
    return this.status();
  }

  async stop(): Promise<RuntimeStatus> {
    // Es laeuft nichts, was sich anhalten liesse. Ehrlich bleiben und den
    // Zustand unveraendert zurueckgeben.
    return this.status();
  }

  async status(): Promise<RuntimeStatus> {
    const gespeichert = await this.repository.get(this.runtime);
    const anbieter = await getPoolProviders();
    // 'unverified' zaehlt mit: der Katalog kam durch, nur ein echter Aufruf
    // stand noch aus. Andernfalls waere die Runtime nach jedem Neustart tot,
    // bis jemand von Hand eine Pruefung anstoesst.
    const nutzbar = anbieter.filter((p) => p.reachability === 'ready' || p.reachability === 'unverified');
    const bestaetigt = anbieter.filter((p) => p.reachability === 'ready');
    const freieModelle = nutzbar.reduce((summe, p) => summe + p.freeCount, 0);

    const lauffaehig = nutzbar.length > 0;
    const letzterFehler = lauffaehig
      ? null
      : anbieter.find((p) => p.reachabilityNote)?.reachabilityNote
        ?? 'Kein Anbieter erreichbar — Zugangsdaten hinterlegen oder Erreichbarkeit pruefen';

    return {
      runtime: this.runtime,
      role: 'main',
      configured: gespeichert !== null,
      installed: lauffaehig,
      rootPath: gespeichert?.rootPath ?? 'n/a',
      image: 'n/a',
      model: gespeichert?.model ?? null,
      container: {
        name: 'n/a',
        id: null,
        // Ohne Container gibt es keinen Container-Zustand. 'running' steht
        // hier fuer "mindestens ein Anbieter antwortet".
        status: lauffaehig ? 'running' : 'not_created',
      },
      authentication: {
        status: lauffaehig ? 'authenticated' : 'not_authenticated',
        method: nutzbar.length ? nutzbar.map((p) => p.id).join(', ') : undefined,
      },
      version: lauffaehig
        ? nutzbar.length + ' Anbieter (' + bestaetigt.length + ' bestaetigt), ' + freieModelle + ' kostenlose Modelle'
        : null,
      lastError: letzterFehler,
      assignedToMain: gespeichert?.assignedToMain ?? false,
    };
  }

  async openTerminal(): Promise<TerminalSession> {
    throw new Error(
      'Der Modell-Pool hat kein Terminal: es laeuft kein Programm, sondern es werden HTTP-Aufrufe gesendet. '
      + 'Fuer eine Shell die Claude- oder Codex-Runtime verwenden.',
    );
  }

  async sendMessage(
    session: MainAgentSession,
    message: string,
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeMessageResult> {
    if (!message.trim()) throw new Error('message darf nicht leer sein');

    const gespeichert = await this.repository.get(this.runtime);
    const kandidaten = await this.waehleKandidaten(gespeichert?.model ?? null);
    if (kandidaten.length === 0) {
      throw new Error(
        'Kein nutzbares freigegebenes Modell verfuegbar. Es wird bewusst NICHT auf ein nicht freigegebenes '
        + 'ausgewichen — Zugangsdaten pruefen, eine Sperre abwarten oder ein Modell freigeben.',
      );
    }

    const verlauf = leseVerlauf(session);
    const nachrichten: ChatNachricht[] = [...verlauf, { role: 'user', content: message }];
    const fehlversuche: string[] = [];

    for (const kandidat of kandidaten) {
      if (signal?.aborted) throw new Error('Abgebrochen');

      emit({
        event: 'runtime',
        data: {
          phase: 'attempt',
          model: kandidat.ref,
          provider: kandidat.provider,
          context: kandidat.contextLength,
        },
      });

      try {
        const antwort = await this.streameAntwort(kandidat, nachrichten, emit, signal);
        markiereErfolg(kandidat.ref);
        // Ein geglueckter Aufruf belegt zugleich, dass der Zugang stimmt.
        markiereAnbieterZugang(kandidat.provider, true, 'Aufruf bestaetigt (' + kandidat.ref + ')');

        const neuerVerlauf: ChatNachricht[] = [
          ...nachrichten,
          { role: 'assistant', content: antwort.text },
        ];
        return {
          // Diese Endpunkte fuehren keine Sitzung; die Kennung bleibt unsere.
          runtimeSessionId: session.runtimeSessionId ?? session.id,
          context: {
            ...(session.context ?? {}),
            messages: neuerVerlauf,
            lastModel: kandidat.ref,
            lastProvider: kandidat.provider,
            usage: antwort.usage,
          },
        };
      } catch (fehler) {
        const eingeordnet =
          fehler instanceof PoolAufrufFehler
            ? fehler.classified
            : classifyFailure({ statusCode: null, message: (fehler as Error).message });

        if (signal?.aborted) throw fehler;

        markiereFehlschlag(kandidat.ref, eingeordnet);
        // Anmeldung und Abrechnung betreffen den ganzen Anbieter; alles andere
        // sagt nur etwas ueber dieses eine Modell.
        if (
          eingeordnet.reason === 'auth'
          || eingeordnet.reason === 'auth_permanent'
          || eingeordnet.reason === 'billing'
        ) {
          markiereAnbieterZugang(kandidat.provider, false, eingeordnet.reason + ': ' + eingeordnet.message);
        }
        fehlversuche.push(kandidat.ref + ': ' + eingeordnet.reason + ' — ' + eingeordnet.message);
        emit({
          event: 'runtime',
          data: {
            phase: 'failed',
            model: kandidat.ref,
            reason: eingeordnet.reason,
            message: eingeordnet.message,
            cooldownMs: eingeordnet.cooldownMs,
          },
        });

        // Bei einem Inhaltsfilter oder fehlerhafter Anfrage bringt ein anderes
        // Ziel nichts — dann ist die Anfrage selbst das Problem.
        if (!lohntWeiterenVersuch(eingeordnet)) {
          throw new Error(eingeordnet.reason + ': ' + eingeordnet.message);
        }
      }
    }

    throw new Error(
      'Alle ' + kandidaten.length + ' Kandidaten sind gescheitert:\n' + fehlversuche.join('\n'),
    );
  }

  /**
   * Stellt die Reihenfolge auf. Ein eingestelltes Modell kommt zuerst, danach
   * die besten verfuegbaren kostenlosen als Rueckfallebene — bevorzugt solche,
   * die Werkzeuge koennen, weil Agenten das brauchen.
   */
  private async waehleKandidaten(bevorzugt: string | null): Promise<PoolModel[]> {
    const liste: PoolModel[] = [];

    if (bevorzugt) {
      const treffer = await getPoolModel(bevorzugt);
      // Ein gesperrter oder gerade nicht erreichbarer Favorit wird
      // uebersprungen, nicht erzwungen.
      if (treffer && treffer.allowed && !treffer.cooldownUntil && treffer.reachability !== 'blocked') {
        liste.push(treffer);
      }
    }

    const ergebnis = await searchPool({
      cost: 'free',
      capabilities: ['tools'],
      sort: 'context',
      limit: 40,
    });

    // Erst einer je Anbieter. Ohne diese Streuung gehen alle Versuche an den
    // Anbieter mit den groessten Kontextfenstern — ist der gerade kaputt, sind
    // alle Versuche verbraucht, obwohl daneben ein gesunder Anbieter steht.
    const schonVertreten = new Set(liste.map((m) => m.provider));
    for (const modell of ergebnis.models) {
      if (liste.length >= MAX_KANDIDATEN) break;
      if (schonVertreten.has(modell.provider)) continue;
      if (liste.some((vorhanden) => vorhanden.ref === modell.ref)) continue;
      liste.push(modell);
      schonVertreten.add(modell.provider);
    }

    // Danach auffuellen, falls es weniger Anbieter als Plaetze gibt.
    for (const modell of ergebnis.models) {
      if (liste.length >= MAX_KANDIDATEN) break;
      if (liste.some((vorhanden) => vorhanden.ref === modell.ref)) continue;
      liste.push(modell);
    }

    // Falls kein einziges Modell Werkzeuge kann, lieber irgendein kostenloses
    // als gar keines.
    if (liste.length === 0) {
      const ersatz = await searchPool({ cost: 'free', sort: 'context', limit: MAX_KANDIDATEN });
      liste.push(...ersatz.models);
    }
    return liste.slice(0, MAX_KANDIDATEN);
  }

  /** Ein Aufruf gegen einen Kandidaten, als Ereignisstrom. */
  private async streameAntwort(
    kandidat: PoolModel,
    nachrichten: ChatNachricht[],
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string; usage: Record<string, unknown> | null }> {
    // Zugangsdaten kommen ausschliesslich hierher — sie stehen bewusst nicht
    // im PoolModel, das an Agenten geht.
    const ziel = await getAufrufZiel(kandidat.ref);
    if (!ziel) {
      throw new PoolAufrufFehler(
        classifyFailure({ statusCode: null, message: 'Modell ' + kandidat.ref + ' ist nicht mehr im Katalog' }),
      );
    }
    const kopf: Record<string, string> = { ...ziel.headers, Accept: 'text/event-stream' };

    const abbruch = new AbortController();
    const weiterreichen = (): void => abbruch.abort();
    signal?.addEventListener('abort', weiterreichen, { once: true });
    const wecker = setTimeout(() => abbruch.abort(), ANTWORT_TIMEOUT_MS);

    try {
      const antwort = await fetch(ziel.url, {
        method: 'POST',
        headers: kopf,
        body: JSON.stringify({
          model: ziel.modelId,
          messages: nachrichten,
          stream: true,
        }),
        signal: abbruch.signal,
      });

      if (!antwort.ok) {
        const roh = await antwort.text();
        let koerper: unknown = roh;
        try {
          koerper = JSON.parse(roh);
        } catch {
          // Kein JSON — der Text bleibt die Meldung.
        }
        throw new PoolAufrufFehler(
          classifyFailure({ statusCode: antwort.status, body: koerper, headers: antwort.headers }),
        );
      }
      if (!antwort.body) {
        throw new PoolAufrufFehler(
          classifyFailure({ statusCode: null, message: 'Der Anbieter hat keinen Stream geoeffnet' }),
        );
      }

      return await this.leseStrom(antwort, emit);
    } finally {
      clearTimeout(wecker);
      signal?.removeEventListener('abort', weiterreichen);
    }
  }

  /**
   * Liest den Ereignisstrom.
   *
   * WICHTIG: Ein Statuscode 200 ist hier kein Beweis fuer Erfolg. Mehrere
   * Anbieter schicken die Kopfzeilen zuerst und melden das Scheitern erst als
   * Ereignis im Strom — ohne diese Pruefung sieht eine abgelehnte Anfrage wie
   * eine leere Antwort aus.
   */
  private async leseStrom(
    antwort: Response,
    emit: (event: RuntimeStreamEvent) => void,
  ): Promise<{ text: string; usage: Record<string, unknown> | null }> {
    const leser = (antwort.body as ReadableStream<Uint8Array>).getReader();
    const dekodierer = new TextDecoder();
    let puffer = '';
    let text = '';
    // Als Objektfeld statt loser Variablen: der Compiler sieht die Zuweisung
    // innerhalb der Hilfsfunktion sonst nicht und haelt den Wert fuer immer null.
    const gesammelt: { usage: Record<string, unknown> | null } = { usage: null };

    const verarbeite = (block: string): void => {
      for (const zeile of block.split('\n')) {
        if (!zeile.startsWith('data:')) continue;
        const nutzlast = zeile.slice(5).trim();
        if (!nutzlast || nutzlast === '[DONE]') continue;

        let ereignis: Record<string, unknown>;
        try {
          ereignis = JSON.parse(nutzlast) as Record<string, unknown>;
        } catch {
          continue;
        }

        // Fehler im laufenden Strom — der eigentliche Grund, warum 200 nichts beweist.
        if (ereignis.error) {
          throw new PoolAufrufFehler(
            classifyFailure({ statusCode: null, body: ereignis, message: 'Fehler im Antwortstrom' }),
          );
        }

        const auswahl = (ereignis.choices as Array<Record<string, unknown>> | undefined)?.[0];
        const stueck = auswahl?.delta as Record<string, unknown> | undefined;
        const inhalt = stueck?.content;
        if (typeof inhalt === 'string' && inhalt) {
          text += inhalt;
          emit({ event: 'delta', data: { content: inhalt } });
        }
        // Reasoning-Modelle liefern ihren Denkanteil getrennt; er gehoert nicht
        // in die Antwort, ist aber fuer die Anzeige nuetzlich.
        const denken = stueck?.reasoning ?? stueck?.reasoning_content;
        if (typeof denken === 'string' && denken) {
          emit({ event: 'runtime', data: { phase: 'reasoning', content: denken } });
        }
        if (ereignis.usage && typeof ereignis.usage === 'object') {
          gesammelt.usage = ereignis.usage as Record<string, unknown>;
        }
      }
    };

    while (true) {
      const stueck = await leser.read();
      if (stueck.done) break;
      puffer += dekodierer.decode(stueck.value, { stream: true });
      let grenze = puffer.indexOf('\n\n');
      while (grenze >= 0) {
        verarbeite(puffer.slice(0, grenze));
        puffer = puffer.slice(grenze + 2);
        grenze = puffer.indexOf('\n\n');
      }
    }
    if (puffer.trim()) verarbeite(puffer);

    if (gesammelt.usage) {
      emit({
        event: 'usage',
        data: {
          inputTokens: gesammelt.usage.prompt_tokens,
          outputTokens: gesammelt.usage.completion_tokens,
          totalTokens: gesammelt.usage.total_tokens,
        },
      });
    }

    // Ein leerer Text ohne Fehler ist ebenfalls ein Fehlschlag: der naechste
    // Kandidat soll es versuchen, statt dem Nutzer nichts zu liefern.
    if (!text.trim()) {
      throw new PoolAufrufFehler(
        classifyFailure({ statusCode: null, message: 'Der Anbieter lieferte eine leere Antwort' }),
      );
    }
    return { text, usage: gesammelt.usage };
  }
}

/** Traegt das Einordnungsergebnis durch die Aufrufkette. */
class PoolAufrufFehler extends Error {
  constructor(readonly classified: ClassifiedFailure) {
    super(classified.reason + ': ' + classified.message);
    this.name = 'PoolAufrufFehler';
  }
}
