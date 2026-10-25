/**
 * P22-T161: Live-Strom der Top-Artefakte. Der Trigger notify_artefakt_bewertung (core Schema 156) meldet jede Aenderung einer Bewertung
 * auf ARTEFAKT_BEWERTUNG_KANAL. EIN LISTEN-Client fuer alle Betrachter, nur solange jemand zusieht (erster baut ihn auf, letzter gibt ihn
 * frei). Ereignisse werden BUENDEL_MS gesammelt und als ein 'geaendert' {anzahl, ereignisse} an alle Betrachter geschickt; die Web-UI laedt
 * ihre Liste darauf (gedrosselt) neu. Der Projektfilter liegt in der Liste selbst (eine Vorlage kann ueber standard_project zu einem
 * anderen Projekt gehoeren als die Bewertung), darum gehen Ereignisse an alle Betrachter.
 * DEBUG: bewertungLiveStatus() {abonnenten, listener, benachrichtigungen, gesendet, letzter_fehler}.
 */
import type { Client, Notification } from 'pg';
import { verbindeListenClient, ARTEFAKT_BEWERTUNG_KANAL } from '@synapse/core';

export type BewertungLiveSende = (event: string, data: Record<string, unknown>) => void;
export const BEWERTUNG_LIVE_BUENDEL_MS = 400;
const abos = new Map<number, BewertungLiveSende>();
let naechsteId = 1;
let client: Client | null = null;
let verbindet: Promise<void> | null = null;
let zeitplan: NodeJS.Timeout | null = null;
let gesammelt: Array<Record<string, unknown>> = [];
const mess = { benachrichtigungen: 0, gesendet: 0, letzter_fehler: null as string | null };

function sendeGesammelt(): void {
  zeitplan = null;
  const ereignisse = gesammelt;
  gesammelt = [];
  if (!ereignisse.length) return;
  mess.gesendet++;
  const data = { anzahl: ereignisse.length, ereignisse: ereignisse.slice(-20) };
  for (const sende of abos.values()) {
    try { sende('geaendert', data); } catch { /* eine kaputte Verbindung darf die anderen nicht mitnehmen */ }
  }
}

/** NOTIFY -> sammeln und gebuendelt an alle Betrachter. Exportiert fuer Tests; Rueckgabe = Zahl der Betrachter. */
export function verarbeiteBewertungsBenachrichtigung(payload: string | undefined): number {
  mess.benachrichtigungen++;
  let p: Record<string, unknown> = {};
  try { const roh = JSON.parse(payload ?? '{}'); if (roh && typeof roh === 'object') p = roh as Record<string, unknown>; } catch { /* kein JSON */ }
  gesammelt.push({ id: p.id ?? null, project: p.project ?? null, zustand: p.zustand ?? null, op: p.op ?? null });
  if (!zeitplan) zeitplan = setTimeout(sendeGesammelt, BEWERTUNG_LIVE_BUENDEL_MS);
  return abos.size;
}

async function stelleListenerSicher(): Promise<void> {
  if (client) return;
  if (verbindet) return verbindet;
  verbindet = (async () => {
    try {
      const c = await verbindeListenClient();
      await c.query('LISTEN ' + ARTEFAKT_BEWERTUNG_KANAL);
      c.on('notification', (n: Notification) => { if (n.channel === ARTEFAKT_BEWERTUNG_KANAL) verarbeiteBewertungsBenachrichtigung(n.payload); });
      c.on('error', (error: Error) => {
        mess.letzter_fehler = 'LISTEN: ' + error.message;
        client = null;
        c.end().catch(() => undefined);
        if (abos.size) setTimeout(() => { void stelleListenerSicher(); }, 2000);
      });
      client = c;
      if (!abos.size) gibListenerFrei();
    } catch (error) {
      mess.letzter_fehler = 'LISTEN-Aufbau: ' + (error instanceof Error ? error.message : String(error));
    } finally {
      verbindet = null;
    }
  })();
  return verbindet;
}

function gibListenerFrei(): void {
  if (abos.size || !client) return;
  const c = client;
  client = null;
  c.end().catch(() => undefined);
}

/** Betrachter anmelden (offener SSE-Strom der Top-Liste). Rueckgabe: Abmelden. */
export async function abonniereBewertungsLive(sende: BewertungLiveSende): Promise<() => void> {
  const id = naechsteId++;
  abos.set(id, sende);
  await stelleListenerSicher();
  return () => {
    abos.delete(id);
    gibListenerFrei();
  };
}

export function bewertungLiveStatus(): Record<string, unknown> {
  return { abonnenten: abos.size, listener: !!client, kanal: ARTEFAKT_BEWERTUNG_KANAL, buendel_ms: BEWERTUNG_LIVE_BUENDEL_MS, ...mess };
}
