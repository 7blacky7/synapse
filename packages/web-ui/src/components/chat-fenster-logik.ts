/**
 * P22-T146 (User 25.10.2026): Chatfenster ohne Neuladen. Reine Logik des Fensters, ohne React/DOM (testbar):
 * - Stand je Identitaet: Verlauf und Inbox nach id, Lesestand (max_rev, aelteste/neueste id, mehr).
 * - Uebernehmen: gleiche id = an Ort und Stelle ersetzt (aeltere rev nie ueber neuere), nichts Neues = DERSELBE Stand (kein
 *   setState, kein Neuaufbau). Abgleich voll (Kappung des Servers) bzw. Verlauf geleert = Luecke, der Aufrufer laedt neu.
 * - Ladegrenze: angezeigt wird nur, was nicht aelter ist als die juengste Ladegrenze der Quellen, die noch aeltere haben
 *   (sonst Luecken beim zeitlichen Mischen, wenn eine Quelle dichter ist).
 * - fensterAusschnitt: gleitendes Fenster der juengsten 50; hochgescrollt gleitet nichts; nach 'Aeltere Beitraege anzeigen'
 *   fest ab der obersten nachgeladenen Nachricht. Nutzt auch der Main-Chat.
 */
import type { AgentChatInboxNachricht, MainAgentVerlauf, MainAgentVerlaufEintrag } from '../api/agent-runtime';

export const CHAT_FENSTER_GROESSE = 50;
/** Der Abgleich (seit_rev) des Servers ist gekappt (core VERLAUF_SEITE_MAX); eine volle Antwort kann eine Luecke haben. */
export const VERLAUF_ABGLEICH_KAPPUNG = 200;
/** Inbox-Abgleich (ab_id): hoechstens so viele je Takt, der Rest kommt im naechsten Takt (aufsteigend, also lueckenlos). */
export const INBOX_ABGLEICH_LIMIT = 100;
/** Hoechstens so viele Abrufe je Klick auf 'Aeltere Beitraege anzeigen'. */
export const AELTERE_RUNDEN_MAX = 3;

export interface ChatFensterStand {
  verlauf: ReadonlyMap<string, MainAgentVerlaufEintrag>;
  verlaufGeladen: boolean;
  maxRev: string;
  geleertRev: string | null;
  verlaufAelteste: string | null;
  verlaufMehr: boolean;
  /** Schalter verlauf_tool_karten laut letzter Antwort. */
  karten: boolean;
  inbox: ReadonlyMap<number, AgentChatInboxNachricht>;
  inboxGeladen: boolean;
  inboxNeueste: number;
  inboxAelteste: number | null;
  inboxMehr: boolean;
  /** Aeltere nachgeladen: das Fenster gleitet nicht mehr (bis Logout). */
  aeltereGeladen: boolean;
  /** Schluessel der obersten angezeigten Nachricht bei festem Fenster. */
  anzeigeAb: string | null;
}

export type InboxAntwort = { aktiv: boolean; nachrichten: AgentChatInboxNachricht[]; mehr?: boolean };

export function leererStand(): ChatFensterStand {
  return { verlauf: new Map(), verlaufGeladen: false, maxRev: '0', geleertRev: null, verlaufAelteste: null, verlaufMehr: false, karten: false,
    inbox: new Map(), inboxGeladen: false, inboxNeueste: 0, inboxAelteste: null, inboxMehr: false, aeltereGeladen: false, anzeigeAb: null };
}

const ganz = (v: unknown): string => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : typeof v === 'string' ? v.trim() : '';
  return /^\d{1,18}$/.test(s) ? String(Number(s)) : '0';
};
const groesste = (a: string, b: string): string => (Number(b) > Number(a) ? b : a);

/** Nur geaenderte Felder uebernehmen; sonst derselbe Stand. */
function aendere(s: ChatFensterStand, teil: Partial<ChatFensterStand>): ChatFensterStand {
  for (const k of Object.keys(teil) as Array<keyof ChatFensterStand>) if (teil[k] !== s[k]) return { ...s, ...teil };
  return s;
}

const gleich = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Nach id zusammenfuehren: neue anhaengen, geaenderte ersetzen, aeltere rev nie ueber eine neuere. Unveraendert = dieselbe Map. */
function fuehreVerlaufZusammen(alt: ReadonlyMap<string, MainAgentVerlaufEintrag>, eintraege: MainAgentVerlaufEintrag[]): ReadonlyMap<string, MainAgentVerlaufEintrag> {
  let neu: Map<string, MainAgentVerlaufEintrag> | null = null;
  for (const e of eintraege) {
    const bekannt = (neu ?? alt).get(e.id);
    if (bekannt && (Number(ganz(bekannt.rev)) > Number(ganz(e.rev)) || gleich(bekannt, e))) continue;
    if (!neu) neu = new Map(alt);
    neu.set(e.id, e);
  }
  return neu ?? alt;
}

/** Seite des Verlaufs (Erstladen limit bzw. aeltere per vor_id) uebernehmen. */
export function uebernimmVerlaufSeite(s: ChatFensterStand, r: MainAgentVerlauf): ChatFensterStand {
  if (!r.verfuegbar) return s;
  const erste = r.eintraege.length ? r.eintraege[0].id : null;
  const aelteste = erste !== null && (s.verlaufAelteste === null || Number(erste) < Number(s.verlaufAelteste)) ? erste : s.verlaufAelteste;
  // 'mehr' gilt fuer die Seite, die gerade die aelteste ist (bzw. die erste und leere Seiten).
  const mehr = !s.verlaufGeladen || erste === null || erste === aelteste ? r.mehr === true : s.verlaufMehr;
  return aendere(s, { verlauf: fuehreVerlaufZusammen(s.verlauf, r.eintraege), verlaufGeladen: true, maxRev: groesste(s.maxRev, ganz(r.max_rev)),
    geleertRev: s.geleertRev ?? ganz(r.geleert_rev), verlaufAelteste: aelteste, verlaufMehr: mehr, karten: r.tool_karten?.aktiv === true });
}

/**
 * Abgleich (seit_rev, ab_id) uebernehmen. luecke = Verlauf geleert oder Antwort an der Kappung: dann bleibt der Stand, und der
 * Aufrufer setzt den Verlauf zurueck (ohneVerlauf) und laedt neu.
 */
export function uebernimmVerlaufAbgleich(s: ChatFensterStand, r: MainAgentVerlauf): { stand: ChatFensterStand; luecke: boolean } {
  if (!r.verfuegbar) return { stand: s, luecke: false };
  const geleert = ganz(r.geleert_rev);
  if ((s.geleertRev !== null && Number(geleert) > Number(s.geleertRev)) || r.eintraege.length >= VERLAUF_ABGLEICH_KAPPUNG) return { stand: s, luecke: true };
  const ab = s.verlaufAelteste;
  const eintraege = ab === null ? r.eintraege : r.eintraege.filter((e) => Number(e.id) >= Number(ab));
  return { stand: aendere(s, { verlauf: fuehreVerlaufZusammen(s.verlauf, eintraege), maxRev: groesste(s.maxRev, ganz(r.max_rev)), geleertRev: geleert,
    karten: r.tool_karten?.aktiv === true }), luecke: false };
}

/** Verlaufsteil verwerfen (Luecke/geleert); die Inbox bleibt. */
export function ohneVerlauf(s: ChatFensterStand): ChatFensterStand {
  const leer = leererStand();
  return { ...s, verlauf: leer.verlauf, verlaufGeladen: false, maxRev: '0', geleertRev: null, verlaufAelteste: null, verlaufMehr: false, aeltereGeladen: false, anzeigeAb: null };
}

/** Inbox uebernehmen: 'letzte' (Erstladen), 'ab' (nur juengere), 'vor' (aeltere). Zeilen aendern sich nie, bekannte bleiben. */
export function uebernimmInbox(s: ChatFensterStand, r: InboxAntwort, art: 'letzte' | 'ab' | 'vor', limit: number): ChatFensterStand {
  if (!r.aktiv) return aendere(s, { inbox: s.inbox.size ? new Map() : s.inbox, inboxGeladen: true, inboxNeueste: 0, inboxAelteste: null, inboxMehr: false });
  let inbox = s.inbox as Map<number, AgentChatInboxNachricht>;
  let neueste = s.inboxNeueste;
  let kleinste: number | null = null;
  for (const n of r.nachrichten) {
    if (!inbox.has(n.id)) { if (inbox === s.inbox) inbox = new Map(s.inbox); inbox.set(n.id, n); }
    if (n.id > neueste) neueste = n.id;
    if (kleinste === null || n.id < kleinste) kleinste = n.id;
  }
  const aelteste = kleinste !== null && (s.inboxAelteste === null || kleinste < s.inboxAelteste) ? kleinste : s.inboxAelteste;
  const seiteMehr = typeof r.mehr === 'boolean' ? r.mehr : r.nachrichten.length >= limit;
  const mehr = art === 'ab' ? (s.inboxGeladen ? s.inboxMehr : seiteMehr) : kleinste === null || kleinste === aelteste ? seiteMehr : s.inboxMehr;
  return aendere(s, { inbox, inboxGeladen: true, inboxNeueste: neueste, inboxAelteste: aelteste, inboxMehr: mehr });
}

/** Fenster fest ab einer Nachricht (nach 'Aeltere Beitraege anzeigen' bzw. wiederhergestellter Ladetiefe). */
export function fixiere(s: ChatFensterStand, anzeigeAb: string | null): ChatFensterStand {
  return aendere(s, { aeltereGeladen: true, anzeigeAb });
}

/** Verlaufseintraege aufsteigend nach id (Map-Reihenfolge ist Einfuege-Reihenfolge). */
export function eintraegeAus(s: ChatFensterStand): MainAgentVerlaufEintrag[] {
  return [...s.verlauf.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
export function inboxAus(s: ChatFensterStand): AgentChatInboxNachricht[] {
  return [...s.inbox.values()].sort((a, b) => a.id - b.id);
}

const zeitwert = (iso: string | undefined): number => { const t = iso ? Date.parse(iso) : Number.NaN; return Number.isFinite(t) ? t : Number.NaN; };
const verlaufGrenze = (s: ChatFensterStand): number => (s.verlaufMehr && s.verlaufAelteste !== null ? zeitwert(s.verlauf.get(s.verlaufAelteste)?.erstellt_am) : Number.NaN);
const inboxGrenze = (s: ChatFensterStand): number => (s.inboxMehr && s.inboxAelteste !== null ? zeitwert(s.inbox.get(s.inboxAelteste)?.erstellt_am) : Number.NaN);

/** Juengste Ladegrenze (ms) der Quellen, die noch aeltere haben; -Infinity = keine Grenze. */
export function ladegrenze(s: ChatFensterStand): number {
  const g = [verlaufGrenze(s), inboxGrenze(s)].filter((t) => Number.isFinite(t));
  return g.length ? Math.max(...g) : Number.NEGATIVE_INFINITY;
}

/** Nachrichten unterhalb der Ladegrenze ausblenden (ohne Zeit bleiben sie). Nichts gefiltert = dieselbe Liste. */
export function innerhalbGrenze<T extends { zeit?: string }>(nachrichten: T[], grenze: number): T[] {
  if (!Number.isFinite(grenze)) return nachrichten;
  const rest = nachrichten.filter((m) => { const t = zeitwert(m.zeit); return !Number.isFinite(t) || t >= grenze; });
  return rest.length === nachrichten.length ? nachrichten : rest;
}

/** Welche Quelle(n) fuer aeltere zuerst abrufen: die mit der juengeren Grenze (sie bindet die Anzeige), bei Gleichstand beide. */
export function aeltereQuellen(s: ChatFensterStand): { verlauf: boolean; inbox: boolean } {
  const v = s.verlaufMehr && s.verlaufAelteste !== null, i = s.inboxMehr && s.inboxAelteste !== null;
  if (!v || !i) return { verlauf: v, inbox: i };
  const tv = verlaufGrenze(s), ti = inboxGrenze(s);
  if (!Number.isFinite(tv) || !Number.isFinite(ti)) return { verlauf: true, inbox: true };
  return { verlauf: tv >= ti, inbox: ti >= tv };
}

export interface FensterAuswahl {
  /** Aeltere nachgeladen: fest ab anzeigeAb, kein Gleiten. */
  fest: boolean;
  anzeigeAb: string | null;
  /** User ist unten: gleitet. Hochgescrollt: die bisher oberste bleibt oben (kein Sprung). */
  unten: boolean;
  bisherAb: string | null;
  groesse?: number;
}

/** Sichtbarer Ausschnitt; ab = Schluessel der obersten sichtbaren Nachricht, versteckt = Anzahl lokal ausgeblendeter. */
export function fensterAusschnitt<T>(nachrichten: T[], schluessel: (m: T) => string, f: FensterAuswahl): { sichtbar: T[]; ab: string | null; versteckt: number } {
  const groesse = f.groesse ?? CHAT_FENSTER_GROESSE;
  const finde = (k: string | null): number => (k === null ? -1 : nachrichten.findIndex((m) => schluessel(m) === k));
  let start: number;
  if (f.fest) {
    const i = finde(f.anzeigeAb);
    start = i >= 0 ? i : 0;
  } else {
    start = Math.max(0, nachrichten.length - groesse);
    const i = f.unten ? -1 : finde(f.bisherAb);
    if (i >= 0) start = i;
  }
  const sichtbar = start > 0 ? nachrichten.slice(start) : nachrichten;
  return { sichtbar, ab: sichtbar.length ? schluessel(sichtbar[0]) : null, versteckt: start };
}
