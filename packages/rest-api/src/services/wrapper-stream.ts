/**
 * MODUL: wrapper-stream (API-Bruecke, Schritt 1)
 * ZWECK: EIN gemeinsamer PostgreSQL-LISTEN-Client fuer ALLE Wrapper-Streams, der
 *        seine Benachrichtigungen an die offenen SSE-Verbindungen verteilt (Fan-out).
 *        Ersetzt fuer den Wrapper das, was er heute mit einer eigenen DB-Verbindung
 *        macht (packages/agents/src/wrapper.ts:228-281, LISTEN synapse_chat/
 *        synapse_channel/synapse_event/synapse_file + synapse_specialist_wake_<name>).
 *
 * WARUM NICHT DAS VORHANDENE MUSTER KOPIERT:
 *   GET /api/projects/:name/events (routes/specialists.ts:394-484) nimmt sich PRO
 *   VERBINDUNG eine eigene Verbindung aus dem Pool (:439) und gibt sie erst beim
 *   Schliessen zurueck. Bei 12 Spezialisten waeren das 12 dauerhaft belegte Pool-
 *   Plaetze zusaetzlich zur Web-UI. Hier ist es EINER fuer alle — und sobald kein
 *   Abonnent mehr offen ist, gar keiner (der Client wird freigegeben).
 *
 * BEZEICHNER IN ANFUEHRUNGSZEICHEN — DER BINDESTRICH-VORFALL:
 *   LISTEN synapse_specialist_wake_takt-probe ist fuer PostgreSQL ein Syntaxfehler,
 *   weil ein Bindestrich den Bezeichner beendet. Am 02.08.2026 hat genau das reihenweise
 *   Wrapper stillgelegt: der Wurf passierte VOR der Registrierung des notification-
 *   Handlers, also gingen auch die vier zuvor gelungenen LISTEN ins Leere. Auffaellig
 *   war es nie, weil der Poll-Takt weiterlief. Deshalb hier: jeder Kanalname geht durch
 *   zitiereBezeichner(), und jedes LISTEN steht in seinem eigenen try — ein kaputter
 *   Kanalname darf nie die anderen mitreissen.
 *
 * SICHTBARKEIT: die Zaehler dieses Moduls sind der Grund, warum ein toter Stream nicht
 *   wie Normalbetrieb aussieht. Sie haengen an GET .../wrapper-bridge/health und stehen
 *   ausserdem in jeder config/poll/status-Antwort unter "stream".
 */

import type { PoolClient } from 'pg';
import { getPool } from '@synapse/core';

/** Basis-Kanaele, die JEDER Wrapper heute abonniert (wrapper.ts:233-236). */
const BASIS_KANAELE = [
  'synapse_chat',
  'synapse_channel',
  'synapse_event',
  'synapse_file',
] as const;

/** Ein Ereignis, wie es beim Abonnenten ankommt (SSE: event: <name> / data: <json>). */
export interface StromEreignis {
  event: 'connected' | 'wake' | 'file' | 'hint';
  data: Record<string, unknown>;
}

interface Abonnent {
  id: number;
  project: string;
  agent: string;
  sende: (ereignis: StromEreignis) => void;
  verbundenSeit: Date;
  letztesEreignisAm: Date | null;
  ereignisse: number;
}

const abonnenten = new Map<number, Abonnent>();
let naechsteAbonnentenId = 1;

/** Wie viele Abonnenten haengen an welchem Wake-Kanal (Referenzzaehlung fuer UNLISTEN). */
const wakeZaehler = new Map<string, number>();

let client: PoolClient | null = null;
let verbindetGerade = false;
/** Wann ging die Verbindung verloren? null = es gab noch keinen Abriss. */
let abrissSeit: number | null = null;
let neuversuchTimer: NodeJS.Timeout | null = null;
let neuversuchVerzoegerungMs = 1_000;

const mess = {
  listenerVerbunden: false,
  listenerLetztesEreignisAm: null as Date | null,
  neuverbindungen: 0,
  letzteNeuverbindungAm: null as Date | null,
  letzteLueckeMs: null as number | null,
  letzterFehler: null as string | null,
  letzterFehlerAm: null as Date | null,
  ereignisseGesamt: 0,
  ereignisseVerworfen: 0,
  listenFehler: 0,
};

function log(nachricht: string, ...args: unknown[]): void {
  // console.error, nicht console.log — Projektregel (MCP stdio).
  console.error(`[WrapperStream] ${nachricht}`, ...args);
}

/** Kanalname als PostgreSQL-Bezeichner in Anfuehrungszeichen (siehe Kopfkommentar). */
function zitiereBezeichner(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function wakeKanal(agent: string): string {
  return `synapse_specialist_wake_${agent}`;
}

/**
 * Verteilt eine PG-Benachrichtigung an die passenden Abonnenten.
 * Die Zuordnung folgt exakt dem heutigen Wrapper-Verhalten:
 *   wake-Kanal  -> nur der eine Agent, als 'wake'
 *   synapse_file-> alle Abonnenten des Projekts, als 'file' (roh, inkl. agent_id;
 *                  den Echo-Schutz macht der Wrapper selbst, wie heute)
 *   uebrige     -> alle Abonnenten des Projekts, als 'hint' (nur der Kanalname —
 *                  mehr braucht der Wrapper nicht, er pollt danach ohnehin)
 */
function verteile(kanal: string, nutzlastRoh: string | undefined): void {
  mess.ereignisseGesamt += 1;
  mess.listenerLetztesEreignisAm = new Date();

  let nutzlast: Record<string, unknown> = {};
  if (nutzlastRoh) {
    try {
      nutzlast = JSON.parse(nutzlastRoh) as Record<string, unknown>;
    } catch {
      nutzlast = { raw: nutzlastRoh };
    }
  }

  const projektDerNutzlast = typeof nutzlast.project === 'string' ? nutzlast.project : null;
  let zugestellt = 0;

  for (const abo of abonnenten.values()) {
    let ereignis: StromEreignis | null = null;

    if (kanal === wakeKanal(abo.agent)) {
      const nachricht = typeof nutzlast.message === 'string' ? nutzlast.message : null;
      if (!nachricht) continue;
      if (projektDerNutzlast && projektDerNutzlast !== abo.project) continue;
      ereignis = { event: 'wake', data: { message: nachricht, project: projektDerNutzlast ?? abo.project } };
    } else if (kanal === 'synapse_file') {
      if (projektDerNutzlast && projektDerNutzlast !== abo.project) continue;
      ereignis = { event: 'file', data: nutzlast };
    } else if ((BASIS_KANAELE as readonly string[]).includes(kanal)) {
      if (projektDerNutzlast && projektDerNutzlast !== abo.project) continue;
      ereignis = { event: 'hint', data: { channel: kanal } };
    }

    if (!ereignis) continue;

    try {
      abo.sende(ereignis);
      abo.letztesEreignisAm = new Date();
      abo.ereignisse += 1;
      zugestellt += 1;
    } catch (err) {
      // Eine kaputte Verbindung darf die anderen nicht mitnehmen.
      mess.ereignisseVerworfen += 1;
      log('Zustellung an %s fehlgeschlagen: %s', abo.agent, String(err));
    }
  }

  if (zugestellt === 0) mess.ereignisseVerworfen += 1;
}

async function meldeAn(c: PoolClient, kanal: string): Promise<void> {
  try {
    await c.query(`LISTEN ${zitiereBezeichner(kanal)}`);
  } catch (err) {
    mess.listenFehler += 1;
    log('LISTEN %s fehlgeschlagen: %s', kanal, String(err));
  }
}

function planeNeuverbindung(): void {
  if (neuversuchTimer) return;
  if (abonnenten.size === 0) return;
  const verzoegerung = neuversuchVerzoegerungMs;
  neuversuchVerzoegerungMs = Math.min(neuversuchVerzoegerungMs * 2, 30_000);
  neuversuchTimer = setTimeout(() => {
    neuversuchTimer = null;
    void stelleListenerSicher();
  }, verzoegerung);
  if (typeof neuversuchTimer.unref === 'function') neuversuchTimer.unref();
  log('Neuverbindung in %dms geplant', verzoegerung);
}

function gibClientFrei(grund: string): void {
  const alt = client;
  client = null;
  mess.listenerVerbunden = false;
  if (!alt) return;
  try {
    alt.release();
  } catch {
    // egal — die Verbindung ist ohnehin hin
  }
  log('LISTEN-Client freigegeben (%s)', grund);
}

/**
 * Stellt sicher, dass genau EIN LISTEN-Client verbunden ist und alle noetigen
 * Kanaele abonniert hat. Idempotent; bei Fehler wird mit Backoff neu versucht.
 */
async function stelleListenerSicher(): Promise<void> {
  if (client || verbindetGerade) return;
  if (abonnenten.size === 0) return;

  verbindetGerade = true;
  try {
    const c = await getPool().connect();

    c.on('notification', (msg) => {
      verteile(msg.channel ?? '', msg.payload ?? undefined);
    });
    c.on('error', (err: Error) => {
      mess.letzterFehler = err.message;
      mess.letzterFehlerAm = new Date();
      log('LISTEN-Client-Fehler: %s', err.message);
      if (abrissSeit === null) abrissSeit = Date.now();
      gibClientFrei('Fehler');
      mess.neuverbindungen += 1;
      planeNeuverbindung();
    });

    for (const kanal of BASIS_KANAELE) {
      await meldeAn(c, kanal);
    }
    for (const agent of wakeZaehler.keys()) {
      await meldeAn(c, wakeKanal(agent));
    }

    client = c;
    mess.listenerVerbunden = true;
    neuversuchVerzoegerungMs = 1_000;
    log('LISTEN aktiv (%d Basis-Kanaele, %d Wake-Kanaele, %d Abonnenten)',
      BASIS_KANAELE.length, wakeZaehler.size, abonnenten.size);

    // WIEDERAUFBAU NACH EINEM ABRISS — das hier ist der Unterschied zwischen
    // "kommt zurueck" und "faellt auf".
    // GEMESSEN am 02.08.2026: wird die LISTEN-Sitzung serverseitig beendet
    // (pg_terminate_backend), ist der Client nach rund 1,2 Sekunden zurueck und
    // liefert wieder aus. Die SSE-Verbindung des Wrappers reisst dabei aber NICHT
    // ab — sie haengt am HTTP-Socket, nicht an der Datenbank. Der Wrapper sieht
    // also weder einen Abbruch noch einen Wiederaufbau und haelt die Sekunden ohne
    // LISTEN fuer einen ruhigen Moment. Alles, was in dieser Luecke passiert ist,
    // waere ihm lautlos entgangen.
    // Deshalb: nach jedem Wiederaufbau ein hint mit dem Kanal 'resync'. Der
    // Aufrufer soll darauf SOFORT pollen (nicht warm abwarten) — der Poll ist das
    // Fundament, der Stream nur der Beschleuniger, und genau hier zahlt sich das aus.
    if (abrissSeit !== null) {
      const lueckeMs = Date.now() - abrissSeit;
      abrissSeit = null;
      mess.letzteNeuverbindungAm = new Date();
      mess.letzteLueckeMs = lueckeMs;
      log('Wiederaufbau nach %dms ohne LISTEN — resync an %d Abonnenten', lueckeMs, abonnenten.size);
      for (const abo of abonnenten.values()) {
        try {
          abo.sende({
            event: 'hint',
            data: { channel: 'resync', reason: 'listener_reconnected', gap_ms: lueckeMs },
          });
          abo.letztesEreignisAm = new Date();
        } catch {
          // eine kaputte Verbindung darf die anderen nicht mitnehmen
        }
      }
    }
  } catch (err) {
    mess.letzterFehler = err instanceof Error ? err.message : String(err);
    mess.letzterFehlerAm = new Date();
    mess.listenerVerbunden = false;
    log('LISTEN-Aufbau fehlgeschlagen: %s', mess.letzterFehler);
    planeNeuverbindung();
  } finally {
    verbindetGerade = false;
  }
}

/**
 * Meldet eine offene SSE-Verbindung an. Rueckgabe: die Abmeldefunktion.
 * Der erste Abonnent baut den LISTEN-Client auf, der letzte gibt ihn frei.
 */
export function abonniere(
  project: string,
  agent: string,
  sende: (ereignis: StromEreignis) => void,
): () => void {
  const id = naechsteAbonnentenId++;
  abonnenten.set(id, {
    id,
    project,
    agent,
    sende,
    verbundenSeit: new Date(),
    letztesEreignisAm: null,
    ereignisse: 0,
  });

  const kanal = wakeKanal(agent);
  const vorher = wakeZaehler.get(agent) ?? 0;
  wakeZaehler.set(agent, vorher + 1);
  if (vorher === 0 && client) {
    void meldeAn(client, kanal);
  }

  void stelleListenerSicher();

  let abgemeldet = false;
  return () => {
    if (abgemeldet) return;
    abgemeldet = true;
    abonnenten.delete(id);

    const rest = (wakeZaehler.get(agent) ?? 1) - 1;
    if (rest <= 0) {
      wakeZaehler.delete(agent);
      if (client) {
        client.query(`UNLISTEN ${zitiereBezeichner(kanal)}`).catch(() => undefined);
      }
    } else {
      wakeZaehler.set(agent, rest);
    }

    if (abonnenten.size === 0) {
      if (neuversuchTimer) {
        clearTimeout(neuversuchTimer);
        neuversuchTimer = null;
      }
      gibClientFrei('kein Abonnent mehr');
    }
  };
}

/** Stream-Sicht fuer EINEN Agenten — geht in jede config/status/poll-Antwort. */
export function stromSicht(project: string, agent: string): {
  connected: boolean;
  last_event_at: string | null;
  subscribers: number;
  listener_connected: boolean;
  listener_last_event_at: string | null;
  listener_reconnects: number;
  listener_last_reconnect_at: string | null;
  listener_last_gap_ms: number | null;
} {
  let anzahl = 0;
  let letztes: Date | null = null;
  for (const abo of abonnenten.values()) {
    if (abo.project !== project || abo.agent !== agent) continue;
    anzahl += 1;
    if (abo.letztesEreignisAm && (!letztes || abo.letztesEreignisAm > letztes)) {
      letztes = abo.letztesEreignisAm;
    }
  }
  return {
    connected: anzahl > 0,
    last_event_at: letztes ? letztes.toISOString() : null,
    subscribers: anzahl,
    listener_connected: mess.listenerVerbunden,
    listener_last_event_at: mess.listenerLetztesEreignisAm
      ? mess.listenerLetztesEreignisAm.toISOString()
      : null,
    // Sichtbar auch fuer den, der NUR pollt und gar keinen Stream offen hat:
    // eine steigende Zahl heisst, dass der Live-Kanal Loecher hatte.
    listener_reconnects: mess.neuverbindungen,
    listener_last_reconnect_at: mess.letzteNeuverbindungAm
      ? mess.letzteNeuverbindungAm.toISOString()
      : null,
    listener_last_gap_ms: mess.letzteLueckeMs,
  };
}

/** Vollbild fuer GET .../wrapper-bridge/health. */
export function stromGesundheit(project?: string): Record<string, unknown> {
  const liste = [...abonnenten.values()]
    .filter((a) => !project || a.project === project)
    .map((a) => ({
      agent: a.agent,
      project: a.project,
      connected_since: a.verbundenSeit.toISOString(),
      last_event_at: a.letztesEreignisAm ? a.letztesEreignisAm.toISOString() : null,
      events: a.ereignisse,
    }));

  return {
    listener: {
      connected: mess.listenerVerbunden,
      last_event_at: mess.listenerLetztesEreignisAm
        ? mess.listenerLetztesEreignisAm.toISOString()
        : null,
      reconnects: mess.neuverbindungen,
      last_reconnect_at: mess.letzteNeuverbindungAm ? mess.letzteNeuverbindungAm.toISOString() : null,
      last_gap_ms: mess.letzteLueckeMs,
      listen_errors: mess.listenFehler,
      last_error: mess.letzterFehler,
      last_error_at: mess.letzterFehlerAm ? mess.letzterFehlerAm.toISOString() : null,
      channels: [...BASIS_KANAELE, ...[...wakeZaehler.keys()].map(wakeKanal)],
    },
    events: {
      total: mess.ereignisseGesamt,
      undeliverable: mess.ereignisseVerworfen,
    },
    subscribers: liste,
    subscriber_count: liste.length,
  };
}
