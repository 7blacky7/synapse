/** P22-T192: ausschliesslich authentifizierte interaktive User-Routen. */
import { apiFetch } from './auth';
export interface UserInboxNachricht { id: string; project: string; von: string; name: string; identity_id: string | null; text: string; gelesen: boolean; erstellt_am: string; antwortbar: boolean }
type Einstellung = { wert: number; quelle: string };
export interface UserInboxStand {
  schalter: { aktiv: boolean; produkt_aktiv: boolean; quelle: string; bis: string | null; letzter_fehler: string | null };
  einstellungen: { seite: Einstellung; abgleich_sekunden: Einstellung; text_max: Einstellung };
  ungelesen: number; gesamt: number; projekte: string[]; agenten: string[]; nachrichten: UserInboxNachricht[];
  mehr: boolean; naechste_vor_id: string | null; debug: Record<string, unknown>;
}
const URL = '/api/agent-runtimes/meine-inbox';
async function anfrage<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(url, init);
  const body = await r.json();
  if (!r.ok || body.success === false) throw new Error(body.error?.message || body.error?.code || 'Meine Inbox ist nicht erreichbar.');
  return body as T;
}
export function leseMeineInbox(q: Record<string, string> = {}): Promise<UserInboxStand> {
  return anfrage(URL + '?' + new URLSearchParams(q));
}
export function schalteMeineInbox(aktiv: boolean): Promise<UserInboxStand> {
  return anfrage(URL + '/schalter', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aktiv }) });
}
export function setzeInboxGelesen(id: string, gelesen: boolean): Promise<{ id: string; gelesen: boolean }> {
  return anfrage(URL + '/' + encodeURIComponent(id) + '/gelesen', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gelesen }) });
}
export function antworteInbox(id: string, text: string): Promise<{ inbox_id: string; an: string; project: string }> {
  return anfrage(URL + '/' + encodeURIComponent(id) + '/antwort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
}

export function setzeMeineInboxEinstellungen(werte: Record<string, number>): Promise<UserInboxStand> {
  return anfrage(URL + '/einstellungen', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ werte }) });
}
