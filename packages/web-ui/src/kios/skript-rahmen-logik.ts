/**
 * P22-T166 (Entwurf 407305f5, GO F1-F9): reine Logik des Skript-Rahmens (ohne DOM testbar, keine Importe).
 *
 * Das Skript eines Artefakts laeuft NUR in den Top-Artefakten (ausgeklappt, nach Klick auf 'Skript starten') in einem iframe:
 *   sandbox="allow-scripts" OHNE allow-same-origin (undurchsichtiger Ursprung "null": kein Zugriff auf Token/localStorage, Cookies,
 *   DOM der Web-UI), ohne forms/popups/modals/top-navigation/downloads; Permissions-Policy alles 'none'; srcdoc mit CSP-Meta ZUERST
 *   (connect-src 'none', kein externes Laden, kein eval). Daten nur ueber den MessagePort an den Rahmen, der jede Anfrage prueft und an
 *   die nur lesende Bruecke der API reicht (core artefakt-skript-bruecke.ts). Das Projekt setzt der Rahmen, nie das Skript.
 * RESTKANAL (ehrlich): Ein Skript kann sich selbst wegnavigieren; der Rahmen erkennt das (zweites load) und entfernt den iframe, die
 *   Anfrage ist dann aber schon raus. Darum begrenzt die Bruecke die Daten auf das, was der Urheber ohnehin lesen darf.
 */

export const SKRIPT_SANDBOX = 'allow-scripts';
/** Permissions-Policy des iframe: nichts erlaubt. */
export const SKRIPT_ALLOW = [
  'camera', 'microphone', 'geolocation', 'clipboard-read', 'clipboard-write', 'display-capture', 'fullscreen', 'payment', 'usb', 'serial',
  'hid', 'bluetooth', 'midi', 'autoplay', 'publickey-credentials-get', 'screen-wake-lock', 'xr-spatial-tracking',
].map((f) => f + " 'none'").join('; ');
/** CSP im srcdoc (Meta vor jedem Artefakt-Inhalt; eine CSP im Artefakt kann nur verschaerfen). */
export const SKRIPT_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:', 'media-src data: blob:',
  "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "manifest-src 'none'",
].join('; ');

export const SKRIPT_GRENZEN = {
  /** Anfrage des Skripts als JSON. */
  anfrage_bytes: 4096,
  parallel: 4,
  rate_anzahl: 30,
  rate_fenster_ms: 10_000,
  zeit_ms: 10_000,
  oeffne_abstand_ms: 1000,
  oeffne_max: 10,
  oeffne_fenster_ms: 60_000,
  hoehe_min: 80,
  hoehe_max: 2400,
  hoehe_schwelle: 2,
  hoehe_je_s: 10,
  /** Watchdog: so lange ohne Puls (bei sichtbarem Tab) -> Stopp. */
  puls_frist_ms: 5000,
  /** Watchdog: Takt des Rahmens (1 s) so viel zu spaet -> Hauptthread war blockiert (iframe im selben Prozess) -> Stopp. */
  takt_verzug_ms: 4000,
} as const;

export const SKRIPT_OPS = ['quelle', 'lese'] as const;
export type SkriptOp = typeof SKRIPT_OPS[number];
const SKRIPT_MUSTER = /<script[\s>/]/i;

/** Enthaelt das HTML ein <script>? (gleiches Muster wie core artefakt-skript-bruecke.ts) */
export function enthaeltSkript(html: unknown): boolean {
  return typeof html === 'string' && SKRIPT_MUSTER.test(html);
}

/** F1: Skript laeuft nur mit Schalter, nur fuer Artefakte (agent_artifacts), nur wenn das HTML eins enthaelt. */
export function skriptErlaubt(o: { schalter: boolean | undefined; quelleArt: string; html: unknown }): boolean {
  return o.schalter === true && o.quelleArt === 'artefakt' && enthaeltSkript(o.html);
}

export type SkriptThema = 'hell' | 'dunkel';

/** CSS-Variablen fuer das Artefakt (--synapse-<name>); nur harmlose Namen/Werte, sonst weggelassen. Rein. */
export function farbVariablen(farben: Record<string, string> | undefined): string {
  return Object.entries(farben ?? {})
    .filter(([k, v]) => /^[a-z][a-z0-9-]{0,30}$/.test(k) && typeof v === 'string' && /^[#(),.%\w\s-]{1,80}$/.test(v.trim()))
    .map(([k, v]) => '--synapse-' + k + ':' + v.trim())
    .join(';');
}

/**
 * srcdoc des iframe: Kopf ZUERST (charset, CSP, referrer, color-scheme, Grundstil, Helfer), dann das Artefakt in #synapse-inhalt.
 * helfer = skriptHelfer(kanal) aus skript-helfer.ts. Rein.
 */
export function baueSrcdoc(html: string, o: { helfer: string; thema: SkriptThema; farben?: Record<string, string> }): string {
  if (/<\/script/i.test(o.helfer)) throw new Error('Helfer darf kein </script> enthalten');
  const schema = o.thema === 'hell' ? 'light' : 'dark';
  const vars = farbVariablen(o.farben);
  return '<!doctype html><html lang="de" data-thema="' + o.thema + '"><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + SKRIPT_CSP + '">'
    + '<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="' + schema + '">'
    + '<style>:root{color-scheme:' + schema + (vars ? ';' + vars : '') + '}html,body{margin:0;padding:0;background:transparent}'
    + 'body{color:var(--synapse-text,inherit);font:14px system-ui,sans-serif}#synapse-inhalt{display:flow-root}</style>'
    + '<script>' + o.helfer + '</script></head><body><div id="synapse-inhalt">' + html + '</div></body></html>';
}

/** Erste Nachricht des Helfers (window-Ebene): nur mit passender Kanal-ID. Rein. */
export function istHallo(d: unknown, kanal: string): boolean {
  const m = d as Record<string, unknown> | null;
  return !!m && typeof m === 'object' && m.synapse === 1 && m.typ === 'hallo' && m.kanal === kanal;
}

export type RahmenNachricht =
  | { typ: 'puls' }
  | { typ: 'hoehe'; px: number }
  | { typ: 'oeffne'; verweis: string }
  | { typ: 'anfrage'; id: number; op: SkriptOp; daten: Record<string, unknown> }
  | { typ: 'abgelehnt'; grund: string; id?: number };

const groesse = (v: unknown): number => { try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch { return Infinity; } };

/** Prueft eine Nachricht vom Port. Alles Unbekannte -> abgelehnt mit Grund. Rein. */
export function pruefeRahmenNachricht(d: unknown): RahmenNachricht {
  const m = d as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.synapse !== 1) return { typ: 'abgelehnt', grund: 'format' };
  if (m.typ === 'puls') return { typ: 'puls' };
  if (m.typ === 'hoehe') return typeof m.px === 'number' && Number.isFinite(m.px) ? { typ: 'hoehe', px: m.px } : { typ: 'abgelehnt', grund: 'hoehe' };
  if (m.typ === 'oeffne') {
    return typeof m.verweis === 'string' && m.verweis.trim() && m.verweis.length <= 300 ? { typ: 'oeffne', verweis: m.verweis.trim() } : { typ: 'abgelehnt', grund: 'verweis' };
  }
  if (m.typ === 'anfrage') {
    const id = m.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > 1e9) return { typ: 'abgelehnt', grund: 'id' };
    if (groesse(m) > SKRIPT_GRENZEN.anfrage_bytes) return { typ: 'abgelehnt', grund: 'groesse', id };
    if (typeof m.op !== 'string' || !(SKRIPT_OPS as readonly string[]).includes(m.op)) return { typ: 'abgelehnt', grund: 'op_unbekannt', id };
    const daten = m.daten && typeof m.daten === 'object' && !Array.isArray(m.daten) ? m.daten as Record<string, unknown> : {};
    return { typ: 'anfrage', id, op: m.op as SkriptOp, daten };
  }
  return { typ: 'abgelehnt', grund: 'typ' };
}

/** REST-Koerper fuer die Bruecke: project setzt der RAHMEN (ein project aus dem Skript wird ignoriert). Rein. */
export function brueckeKoerper(op: SkriptOp, daten: Record<string, unknown>, project: string): Record<string, unknown> {
  if (op === 'quelle') {
    const args = daten.args && typeof daten.args === 'object' && !Array.isArray(daten.args) ? daten.args : {};
    return { op, vertrag: String(daten.vertrag ?? ''), args, project };
  }
  return { op, art: String(daten.art ?? ''), ref: String(daten.ref ?? ''), project };
}

/** Gleitendes Fenster: hoechstens anzahl Ereignisse je fensterMs. Rein (Zeit von aussen). */
export function erzeugeEimer(anzahl: number, fensterMs: number): { nehmen(jetzt: number): boolean } {
  const zeiten: number[] = [];
  return {
    nehmen(jetzt: number): boolean {
      while (zeiten.length && jetzt - zeiten[0] >= fensterMs) zeiten.shift();
      if (zeiten.length >= anzahl) return false;
      zeiten.push(jetzt);
      return true;
    },
  };
}

/** Neue Hoehe des iframe (gedeckelt) oder null, wenn die Aenderung unter der Schwelle liegt (gegen Aufschaukeln). Rein. */
export function hoeheBegrenzen(px: number, bisher: number): number | null {
  const neu = Math.round(Math.min(SKRIPT_GRENZEN.hoehe_max, Math.max(SKRIPT_GRENZEN.hoehe_min, px)));
  return Math.abs(neu - bisher) <= SKRIPT_GRENZEN.hoehe_schwelle ? null : neu;
}

/**
 * Watchdog: unsichtbarer Tab -> 'reset' (Browser drosseln Timer im Hintergrund, sonst Fehlalarm); laenger als die Frist ohne Puls ->
 * 'stopp'; sonst 'ok'. Rein.
 */
export function watchdog(o: { letzterPuls: number; jetzt: number; sichtbar: boolean; frist?: number; letzterTakt?: number }): 'ok' | 'reset' | 'stopp' {
  if (!o.sichtbar) return 'reset';
  // Befund 25.10.2026 (KI-Browser): Der sandboxed iframe kann im SELBEN Prozess laufen; eine Schleife im Skript blockiert dann auch
  // die Web-UI. Kommt der Takt des Rahmens (1 s) viel zu spaet, war der Hauptthread blockiert -> sofort stoppen (sonst gewinnt der
  // nachgereichte Puls das Rennen).
  if (o.letzterTakt !== undefined && o.jetzt - o.letzterTakt > SKRIPT_GRENZEN.takt_verzug_ms) return 'stopp';
  return o.jetzt - o.letzterPuls > (o.frist ?? SKRIPT_GRENZEN.puls_frist_ms) ? 'stopp' : 'ok';
}

export type StoppGrund = 'watchdog' | 'navigation' | 'nutzer';
export const STOPP_TEXT: Record<StoppGrund, string> = {
  watchdog: 'Skript reagiert nicht (kein Lebenszeichen bzw. Seite blockiert) und wurde gestoppt.',
  navigation: 'Skript hat versucht, wegzunavigieren, und wurde gestoppt.',
  nutzer: 'Skript gestoppt.',
};
export const SKRIPT_WARNUNG = 'Dieses Artefakt enthält ein Skript eines Agenten. Es läuft abgeschottet ohne Zugriff auf deine Anmeldung und kann nur lesen. '
  + 'Gib in einem Artefakt nie Codes oder Passwörter ein.';
