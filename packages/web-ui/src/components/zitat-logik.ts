/**
 * P22-T168 (Entwurf b75a72bb Fassung 2, GO c32285ce F1-F8): reine Logik der Zitat-Anhaenge im Chat (ohne React/DOM, ohne Importe;
 * testbar mit node --experimental-strip-types).
 * - Entwurf je Chatfenster = je Empfaenger ('main' bzw. 'agent:<identity_id>'): hinzufuegen, Anmerkung ersetzen, entfernen. Speicher
 *   localStorage 'synapse:zitat-entwurf:<chat>' (F7: uebersteht F5 und Tab-Schliessen; Logout verwirft, chat-fenster-speicher).
 * - Senden: zuSendeZitaten -> Body-Feld 'zitate' (nur Verweis + Titel + markierter Ausschnitt + Anmerkung, nie der volle Inhalt).
 * - Anzeige: zerlegeZitatBlock trennt den Block [Synapse-Zitate] ... [/Synapse-Zitate] (Bauer: core chat-zitate.ts baueZitatBlock)
 *   vom Text; anzeigeAusAnhaengen liest die Zitate einer Main-Verlaufszeile (anhaenge art 'zitat').
 */

export const ZITAT_ARTEN = ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset', 'ausschnitt'] as const;
export type ZitatArt = typeof ZITAT_ARTEN[number];
/** Wie core ZITAT_ART_LABEL (Golden-Test). */
export const ZITAT_ART_LABEL: Record<ZitatArt, string> = {
  thought: 'Thought', memory: 'Memory', task: 'Task', plan: 'Plan', doc: 'Doku', event: 'Event', nachricht: 'Channel-Nachricht',
  chat: 'Chat-Nachricht', asset: 'Bild', ausschnitt: 'Ausschnitt',
};
export const ZITAT_ENTWURF_PRAEFIX = 'synapse:zitat-entwurf:';

export interface ZitatGrenzen { max_anzahl: number; anmerkung_max: number; ausschnitt_max: number; titel_max: number }
/** Code-Standard wie core CHAT_ZITATE_EINSTELLUNGEN; wirksam sind die Grenzen der Status-Route. */
export const ZITAT_GRENZEN_STANDARD: ZitatGrenzen = { max_anzahl: 10, anmerkung_max: 2000, ausschnitt_max: 600, titel_max: 160 };

/** Was ein Rechtsklick/Knopf vorschlaegt (noch ohne Anmerkung). */
export interface ZitatVorlage {
  art: ZitatArt;
  id: string | null;
  projekt: string;
  titel: string;
  ausschnitt?: string;
  /** Schluessel der Nachricht, aus der der Ausschnitt stammt ('verlauf:<id>' bzw. 'inbox:<id>'). */
  quelle?: string;
  /**
   * P22-T170: Kaertchen einer gerade angepinnten User-Entscheidung (Zitat art 'thought', ID = Pin-thought).
   * P22-T171 Punkt 5 (User 83b5014f): pin = Bezug ('Task P22-T171'); geht mit (SendeZitat.pin) und heisst im Block wie auf dem
   * Kaertchen 'Angepinnte User-Entscheidung an <Bezug>' statt 'Thought <id>'.
   */
  pin?: string;
}
export interface ZitatAnhang extends ZitatVorlage { schluessel: string; anmerkung: string; erstellt_am: string }
export interface SendeZitat { art: ZitatArt; id?: string; projekt: string; titel: string; ausschnitt?: string; quelle?: { nachricht: string }; anmerkung: string; pin?: string }
export interface AnzeigeZitat { art: ZitatArt; id: string | null; projekt: string | null; titel: string; ausschnitt?: string; quelle?: string; anmerkung: string; pin?: string }

/** P22-T171: Eintragszeile eines Pins im Block (wie core chat-zitate.ts PIN_EINTRAG) und Kopf seines Kaertchens. */
export const PIN_EINTRAG = 'Angepinnte User-Entscheidung an ';

export function istZitatArt(v: unknown): v is ZitatArt {
  return typeof v === 'string' && (ZITAT_ARTEN as readonly string[]).includes(v);
}

export function neuerZitatSchluessel(jetzt = Date.now(), zufall = Math.random()): string {
  return 'z' + jetzt.toString(36) + '-' + Math.floor(zufall * 1e8).toString(36);
}

/** Text auf max Zeichen kuerzen (mit '…'); gekuerzt = ob etwas wegfiel. */
export function kuerzeZitatText(text: string, max: number): { text: string; gekuerzt: boolean } {
  const t = text.replace(/\r\n/g, '\n').trim();
  return t.length <= max ? { text: t, gekuerzt: false } : { text: t.slice(0, Math.max(1, max - 1)).trimEnd() + '…', gekuerzt: true };
}

/** Neues Zitat ans Ende. Voll (max erreicht) -> Liste unveraendert, voll true. */
export function fuegeZitatHinzu(liste: readonly ZitatAnhang[], vorlage: ZitatVorlage, anmerkung: string, max: number,
  schluessel = neuerZitatSchluessel(), jetzt = new Date().toISOString()): { liste: ZitatAnhang[]; voll: boolean; zitat?: ZitatAnhang } {
  if (liste.length >= max) return { liste: [...liste], voll: true };
  const zitat: ZitatAnhang = { ...vorlage, anmerkung: anmerkung.replace(/\r\n/g, '\n').trim(), schluessel, erstellt_am: jetzt };
  return { liste: [...liste, zitat], voll: false, zitat };
}

export function ersetzeZitatAnmerkung(liste: readonly ZitatAnhang[], schluessel: string, anmerkung: string): ZitatAnhang[] {
  return liste.map((z) => (z.schluessel === schluessel ? { ...z, anmerkung: anmerkung.replace(/\r\n/g, '\n').trim() } : z));
}

export function entferneZitat(liste: readonly ZitatAnhang[], schluessel: string): ZitatAnhang[] {
  return liste.filter((z) => z.schluessel !== schluessel);
}

/** Kopf eines Zitats: 'Task P22-T158' bzw. 'Ausschnitt'; P22-T171: Pin = 'Angepinnte User-Entscheidung an Task P22-T171'. */
export function zitatKopf(z: { art: ZitatArt; id: string | null; pin?: string }): string {
  return z.pin ? PIN_EINTRAG + z.pin : ZITAT_ART_LABEL[z.art] + (z.id ? ' ' + z.id : '');
}

/** Beschriftung eines Kaertchens: Art + ID, Titel, Anfang der Anmerkung (bzw. des Ausschnitts). */
export function zitatKarte(z: { art: ZitatArt; id: string | null; titel: string; anmerkung: string; ausschnitt?: string; pin?: string }, laenge = 60): { kopf: string; titel: string; anmerkung: string } {
  const quelle = (z.anmerkung || (z.ausschnitt ? '„' + z.ausschnitt + '“' : '')).replace(/\s+/g, ' ').trim();
  return { kopf: zitatKopf(z), titel: z.titel, anmerkung: quelle.length > laenge ? quelle.slice(0, laenge - 1).trimEnd() + '…' : quelle };
}

export function zuSendeZitaten(liste: readonly ZitatAnhang[]): SendeZitat[] {
  return liste.map((z) => ({
    art: z.art, ...(z.id ? { id: z.id } : {}), projekt: z.projekt, titel: z.titel,
    ...(z.ausschnitt ? { ausschnitt: z.ausschnitt } : {}), ...(z.quelle ? { quelle: { nachricht: z.quelle } } : {}), anmerkung: z.anmerkung,
    ...(z.pin ? { pin: z.pin } : {}),
  }));
}

export function anzeigeAusEntwurf(liste: readonly ZitatAnhang[]): AnzeigeZitat[] {
  return liste.map((z) => ({ art: z.art, id: z.id, projekt: z.projekt, titel: z.titel, ...(z.ausschnitt ? { ausschnitt: z.ausschnitt } : {}),
    ...(z.quelle ? { quelle: z.quelle } : {}), anmerkung: z.anmerkung, ...(z.pin ? { pin: z.pin } : {}) }));
}

// ───────────────────────── Speicher (localStorage je Chat) ─────────────────────────

export interface ZitatAblage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; readonly length: number; key(i: number): string | null }

function gueltigerEntwurf(v: unknown): ZitatAnhang | null {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  if (!o || !istZitatArt(o.art) || typeof o.schluessel !== 'string' || typeof o.projekt !== 'string' || !o.projekt) return null;
  const id = typeof o.id === 'string' && o.id ? o.id : null;
  if (o.art !== 'ausschnitt' && !id) return null;
  return {
    art: o.art, id, projekt: o.projekt, titel: typeof o.titel === 'string' ? o.titel : '', schluessel: o.schluessel,
    anmerkung: typeof o.anmerkung === 'string' ? o.anmerkung : '', erstellt_am: typeof o.erstellt_am === 'string' ? o.erstellt_am : '',
    ...(typeof o.ausschnitt === 'string' && o.ausschnitt ? { ausschnitt: o.ausschnitt } : {}),
    ...(typeof o.quelle === 'string' && o.quelle ? { quelle: o.quelle } : {}),
    ...(pinAusEntwurf(o) ? { pin: pinAusEntwurf(o)! } : {}),
  };
}

/** P22-T171: pin eines gespeicherten Entwurfs; T170-Entwuerfe hatten pin true und den Bezug im Titel ('User-Entscheidung an X · ...'). */
function pinAusEntwurf(o: Record<string, unknown>): string | null {
  if (o.art !== 'thought') return null;
  if (typeof o.pin === 'string' && o.pin.trim()) return o.pin.trim();
  if (o.pin !== true) return null;
  const alt = /^User-Entscheidung an (.+?)(?: · |$)/.exec(typeof o.titel === 'string' ? o.titel : '');
  return alt ? alt[1] : 'User-Entscheidung';
}

export function leseZitatEntwurf(ablage: ZitatAblage | null, chat: string): ZitatAnhang[] {
  try {
    const roh = ablage?.getItem(ZITAT_ENTWURF_PRAEFIX + chat);
    const liste = roh ? JSON.parse(roh) as unknown : [];
    return Array.isArray(liste) ? liste.map(gueltigerEntwurf).filter((z): z is ZitatAnhang => z !== null) : [];
  } catch { return []; }
}

/** Leere Liste entfernt den Eintrag. */
export function merkeZitatEntwurf(ablage: ZitatAblage | null, chat: string, liste: readonly ZitatAnhang[]): void {
  try {
    if (!ablage) return;
    if (liste.length) ablage.setItem(ZITAT_ENTWURF_PRAEFIX + chat, JSON.stringify(liste));
    else ablage.removeItem(ZITAT_ENTWURF_PRAEFIX + chat);
  } catch { /* Entwurf ist Komfort */ }
}

// ───────────────────────── P22-T170: Herkunft des Lesefensters ─────────────────────────

/**
 * Herkunft eines Lesefensters: Agenten-Chat (Koordinator-Fenster, einheitliches Agentenfenster), Main-Chat, Channel-Fenster oder
 * 'ohne' (Artefakte, Top-Artefakte, Dashboard, sonst wo). Mit Herkunft landen Zitate UND Pins als Kaertchen im Entwurf genau dieses
 * Chats/Channels; ohne Herkunft wird der Pin nur gespeichert und das Zitat geht ueber die Empfaengerauswahl in die Inbox.
 */
export type ZitatHerkunft = 'agent' | 'main' | 'channel';
export type LesefensterHerkunft = ZitatHerkunft | 'ohne';

/** Herkunft aus dem Entwurfs-Schluessel eines Chatfensters ('main', 'agent:<id>', 'channel:<projekt>:<name>'). */
export function herkunftAusChat(chat: string): ZitatHerkunft {
  return chat === 'main' ? 'main' : chat.startsWith('channel:') ? 'channel' : 'agent';
}

export interface PinEingabe { thoughtId: string; projekt: string; kopf: string; titel?: string; text: string }

/**
 * Kaertchen fuer eine gerade angepinnte User-Entscheidung: Zitat art 'thought' (ID = thought), Wortlaut als Ausschnitt (gekuerzt).
 * P22-T171: pin = Kopf des Bezugs ('Task P1-T2'), titel = Titel des Bezugs (der Block nennt den Pin selbst).
 */
export function pinVorlage(pin: PinEingabe, ausschnittMax: number): ZitatVorlage {
  return {
    art: 'thought', id: pin.thoughtId, projekt: pin.projekt, titel: pin.titel ?? '',
    ausschnitt: kuerzeZitatText(pin.text, ausschnittMax).text, pin: pin.kopf,
  };
}

/** Pin als sendefertiges Zitat (ohne Anmerkung) - Empfaengerauswahl ohne Herkunft (P22-T171 Punkt 1). Rein. */
export function pinSendeZitat(pin: PinEingabe, ausschnittMax: number): SendeZitat {
  return zuSendeZitaten(fuegeZitatHinzu([], pinVorlage(pin, ausschnittMax), '', 1, 'pin').liste)[0];
}

/**
 * Empfaengerauswahl (Herkunft 'ohne'). P22-T170: genau 3 Zeilen sichtbar (User 82b61246). P22-T171 Punkt 2 (User inbox 1258): Eingabefeld,
 * Klick/Tippen oeffnet darunter hoechstens so viele Vorschlaege, mehr per Scrollen; Tippen filtert; Gewaehlte als Marken im Feld.
 */
export const EMPFAENGER_SICHTBAR = 3;
export interface ZitatEmpfaengerEintrag { identity_id: string; agent_id: string; name: string; rolle: string; project: string }

/** Filter nach Name (auch agent_id/Rolle), Gross/klein egal; die Auswahl bleibt davon unberuehrt. */
export function filtereZitatEmpfaenger(liste: readonly ZitatEmpfaengerEintrag[], filter: string): ZitatEmpfaengerEintrag[] {
  const f = filter.trim().toLowerCase();
  return f ? liste.filter((e) => (e.name + ' ' + e.agent_id + ' ' + e.rolle).toLowerCase().includes(f)) : [...liste];
}

export function schalteZitatEmpfaenger(auswahl: readonly string[], identityId: string): string[] {
  return auswahl.includes(identityId) ? auswahl.filter((x) => x !== identityId) : [...auswahl, identityId];
}

export function zitatEmpfaengerName(e: ZitatEmpfaengerEintrag): string {
  return e.rolle === 'main' ? 'Hauptagent' + (e.name && e.name !== 'main' ? ' · ' + e.name : '') : e.name || e.agent_id;
}

/** P22-T171: Markierung in der Vorschlagsliste per Pfeiltaste (rundum, -1 = keine). Rein. */
export function naechsteMarkierung(aktuell: number, anzahl: number, schritt: 1 | -1): number {
  if (anzahl <= 0) return -1;
  if (aktuell < 0) return schritt > 0 ? 0 : anzahl - 1;
  return (aktuell + schritt + anzahl) % anzahl;
}

// ───────────────────────── Block (Anzeige) ─────────────────────────

const KOPF = /^\[Synapse-Zitate: (\d+)\]\s*$/;
const ENDE = /^\[\/Synapse-Zitate\]/;
const EINTRAG = /^(\d+)\) (\S+)(?: (.+))?$/;
// P22-T171 Punkt 5: Pin-Eintrag 'N) Angepinnte User-Entscheidung an <Bezug>' mit Feldern Thought (ID) und Wortlaut (= Ausschnitt).
const PIN = /^(\d+)\) Angepinnte User-Entscheidung an (.+)$/;
const FELD = /^ {3}(Projekt|Titel|Quelle|Ausschnitt|Anmerkung|Thought|Wortlaut):(?: (.*))?$/;
const LABEL_ART = new Map<string, ZitatArt>(Object.entries(ZITAT_ART_LABEL).map(([art, label]) => [label, art as ZitatArt]));
type Feld = 'projekt' | 'titel' | 'quelle' | 'ausschnitt' | 'anmerkung' | 'thought' | 'wortlaut';

/**
 * Den (letzten) Block aus einem Text loesen. Ohne bzw. mit fehlerhaftem Block: Text unveraendert, keine Zitate. Was nach dem Ende
 * steht (z. B. eine Fusszeile), bleibt im Text. Rein.
 */
export function zerlegeZitatBlock(text: string): { text: string; zitate: AnzeigeZitat[] } {
  const zeilen = text.replace(/\r\n/g, '\n').split('\n');
  let ende = -1, kopf = -1;
  for (let i = zeilen.length - 1; i >= 0; i--) {
    if (ende < 0) { if (ENDE.test(zeilen[i])) ende = i; continue; }
    if (KOPF.test(zeilen[i])) { kopf = i; break; }
  }
  if (kopf < 0) return { text, zitate: [] };
  const zitate: AnzeigeZitat[] = [];
  const werte: Array<Partial<Record<Feld, string>>> = [];
  let feld: Feld | null = null;
  for (const z of zeilen.slice(kopf + 1, ende)) {
    const p = PIN.exec(z);
    if (p) {
      zitate.push({ art: 'thought', id: null, projekt: null, titel: '', anmerkung: '', pin: p[2].trim() });
      werte.push({});
      feld = null;
      continue;
    }
    const e = EINTRAG.exec(z);
    if (e) {
      const art = LABEL_ART.get(e[2]);
      if (!art) return { text, zitate: [] };
      zitate.push({ art, id: e[3]?.trim() || null, projekt: null, titel: '', anmerkung: '' });
      werte.push({});
      feld = null;
      continue;
    }
    const f = FELD.exec(z);
    if (f && zitate.length) {
      feld = f[1].toLowerCase() as Feld;
      werte[werte.length - 1][feld] = f[2] ?? '';
      continue;
    }
    if (feld && zitate.length && (z.startsWith('     ') || !z.trim())) {
      werte[werte.length - 1][feld] += '\n' + z.slice(5);
      continue;
    }
    return { text, zitate: [] };
  }
  if (Number(KOPF.exec(zeilen[kopf])![1]) !== zitate.length) return { text, zitate: [] };
  zitate.forEach((zitat, i) => {
    const w = werte[i];
    zitat.projekt = w.projekt?.trim() || null;
    zitat.titel = w.titel?.trim() ?? '';
    zitat.anmerkung = (w.anmerkung ?? '').trim();
    if (w.ausschnitt?.trim()) zitat.ausschnitt = w.ausschnitt.trim();
    if (w.quelle?.trim()) zitat.quelle = w.quelle.trim().replace(/^Nachricht /, '');
    if (zitat.pin) {
      zitat.id = w.thought?.trim() || null;
      if (w.wortlaut?.trim()) zitat.ausschnitt = w.wortlaut.trim();
    }
  });
  const vorher = zeilen.slice(0, kopf).join('\n').trimEnd();
  const nachher = zeilen.slice(ende + 1).join('\n').trim();
  return { text: [vorher, nachher].filter(Boolean).join('\n\n'), zitate };
}

/** Zitate einer Main-Verlaufszeile (anhaenge art 'zitat', core zitatAlsVerlaufAnhang). Rein. */
export function anzeigeAusAnhaengen(anhaenge: unknown): AnzeigeZitat[] {
  if (!Array.isArray(anhaenge)) return [];
  return anhaenge.flatMap((a): AnzeigeZitat[] => {
    const o = a && typeof a === 'object' ? a as Record<string, unknown> : null;
    if (!o || o.art !== 'zitat' || !istZitatArt(o.verweis_art)) return [];
    return [{
      art: o.verweis_art, id: typeof o.id === 'string' && o.id ? o.id : null, projekt: typeof o.projekt === 'string' ? o.projekt : null,
      titel: typeof o.titel === 'string' ? o.titel : '', anmerkung: typeof o.anmerkung === 'string' ? o.anmerkung : '',
      ...(typeof o.ausschnitt === 'string' && o.ausschnitt ? { ausschnitt: o.ausschnitt } : {}),
      ...(typeof o.quelle === 'string' && o.quelle ? { quelle: o.quelle } : {}),
      ...(o.verweis_art === 'thought' && typeof o.pin === 'string' && o.pin ? { pin: o.pin } : {}),
    }];
  });
}
