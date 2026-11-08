/**
 * MODUL: cli-verlauf.ts (P22-T133)
 * ZWECK: Lokale Claude-Code-Sitzungen (~/.claude/projects/<ordner>/<sitzung>.jsonl) in den Agenten-Verlauf der
 *        Web-UI uebertragen. Die Unterhaltung mit einem CLI-Agenten auf diesem PC (z. B. dem Koordinator) ist dann
 *        dort sichtbar, wo man auch die Container-Agenten sieht.
 *
 * SCHALTER: config.json cli_verlauf.aktiv (Tray-Haken "CLI-Verlauf an Synapse", Standard aus). Wird je Takt frisch
 *   von der Platte gelesen; aus = nichts wird gelesen oder gesendet.
 * ZUORDNUNG: der Ausweis (sai_...), mit dem sich die Sitzung per chat(anmelden) gemeldet hat. Zeilen vor der ersten
 *   Anmeldung gehoeren zum ersten Ausweis, nach einem Wechsel zum neuen. Sitzungen ohne Ausweis werden nie
 *   uebertragen. Der Server prueft den Ausweis (POST /api/daemon/cli-verlauf) und nimmt jede ref genau einmal auf.
 * STAND: ~/.synapse/file-watcher/cli-verlauf-stand.json je Datei; nur vollstaendige Zeilen gelten als gelesen.
 *   Geprueft werden Dateien, die in den letzten CLI_VERLAUF_TAGE (Standard 2) Tagen geaendert wurden.
 *   Aus: CLI_VERLAUF_DISABLED=1.
 * P22-T288 W2 CODEX: lokale Codex-Sitzungen (CODEX_HOME bzw. ~/.codex, sessions/<JJJJ>/<MM>/<TT>/rollout-*.jsonl; codex-tui und ihre
 *   Sub-Agenten, je Datei ein Agent) laufen ueber denselben Takt, dieselbe Route und dieselbe Schreibstelle (runtime codex). Leser:
 *   @synapse/agents codexEintraegeAus / codexAusweisAusZeile (Ausweis aus chat(anmelden) im exec-Code bzw. function_call). Schalter
 *   config.json cli_verlauf.codex (Standard EIN unter dem Tray-Haken; false bzw. Env CLI_VERLAUF_CODEX=0 = aus). Stand je Datei wie
 *   Claude, dazu runtime 'codex' und modell (letztes turn_context, gilt im naechsten Takt weiter).
 * P22-T288 W1 SUBAGENTEN: Harness-Subagenten (Agent-Tool/Teammates einer Sitzung) schreiben eigene Dateien
 *   <ordner>/<sitzung>/subagents/agent-<agentId>.jsonl mit eigener Anmeldung (eigener Ausweis). Sie werden mitgelesen, Schalter
 *   config.json cli_verlauf.subagenten (Standard EIN, der Tray-Haken ist die Einwilligung; false = aus; Env CLI_VERLAUF_SUBAGENTEN=0).
 *   Wird ein Teammate in einer NEUEN Sitzung wieder aufgenommen, entsteht eine Datei derselben agentId ohne Anmeldung. Sie erbt den
 *   Ausweis NUR bei belegter Wiederaufnahme (Pruefung P22-T288): die erste Zeile verweist per parentUuid auf eine uuid in der
 *   Vorgaengerdatei derselben agentId im selben Projektordner; Erbe = letzter Ausweis dieser Vorgaengerdatei. Eine neue Sitzung mit
 *   derselben agentId (gleicher Teammate-Name, parentUuid null) erbt nie - sonst landete ihr Verlauf bei einer fremden Identitaet.
 * P22-T288 NACHZUG (Option B, Grundsatz "alles in PG"): EIN Fenster - cli_verlauf.tage bzw. Env CLI_VERLAUF_TAGE (fensterTage).
 *   Dateien der letzten NORMAL_FENSTER_TAGE (2) laufen wie immer jeden Takt vollstaendig. Ist das Fenster groesser, kommen die
 *   aelteren Dateien (Claude, Subagenten, Codex gleich) GEDROSSELT dazu: je Takt hoechstens cli_verlauf.nachzug_dateien_je_takt
 *   (1..100, Standard 5) noch offene, aelteste zuerst, ueber denselben Weg (Stand je Datei + ON CONFLICT = nichts doppelt).
 *   Debug: ~/.synapse/file-watcher/cli-verlauf-nachzug.json {tage, je_takt, gesamt, offen, in_diesem_takt, erledigt, am}.
 *   Debug: Stand je Datei agent_id, ausweis_quelle (anmeldung | erbe), erbe_von (Pfad der Vorgaengerdatei). Der Server prueft den Ausweis wie immer. W7: usage je Antwort (message.id) geht genau einmal mit, auch ueber
 *   Taktgrenzen (Stand letzte_nachricht).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sitzungsEintraegeAus, codexEintraegeAus, codexAusweisAusZeile, type SitzungsEintrag } from '@synapse/agents';
import { configDir, configFilePath } from './config.js';
import { anfrage, DaemonJobsApiFehler, DAEMON_API_ID, DAEMON_HOST } from './daemon-jobs-api.js';

const TAKT_MS = 15_000;
const STAPEL_EINTRAEGE = 100;
const STAPEL_BYTES = 3 * 1024 * 1024;
const AUSWEIS = /^sai_[A-Za-z0-9_-]{1,64}$/;

interface DateiStand {
  /** Byte-Position hinter der letzten uebertragenen vollstaendigen Zeile. */
  offset: number;
  /** Ausweis der letzten Anmeldung in dieser Sitzung (null = noch keiner gesehen). */
  ausweis: string | null;
  /** Ohne Ausweis: bis hierher wurde nach einer Anmeldung gesucht. */
  gesucht_bis?: number;
  gesendet: number;
  fehler?: string | null;
  /** P22-T288: agentId eines Harness-Subagenten (Datei agent-<agentId>.jsonl), sonst fehlt das Feld. */
  agent_id?: string | null;
  /** P22-T288: Herkunft des Ausweises: eigene Anmeldung in der Datei oder Erbe derselben agentId. */
  ausweis_quelle?: 'anmeldung' | 'erbe' | null;
  /** P22-T288 W7: message.id der letzten Antwort im gelesenen Teil (deren usage ist schon gemeldet). */
  letzte_nachricht?: string | null;
  /** P22-T288: letzte Aenderung dieses Eintrags (ms, Debug). */
  am?: number;
  /** P22-T288 (Pruefung): Vorgaengerdatei, deren Ausweis geerbt wurde (belegte Wiederaufnahme). */
  erbe_von?: string | null;
  /** P22-T288 W2: 'codex' fuer Codex-Rollouts (sonst fehlt das Feld = Claude). */
  runtime?: 'codex' | null;
  /** P22-T288 W2: letztes Modell (turn_context) des gelesenen Teils, Startwert fuer den naechsten Takt. */
  modell?: string | null;
}
export type Stand = Record<string, DateiStand>;

/** Ausweis aus einer chat(anmelden)-Zeile (tool_use mit action anmelden und agent_kennung/token), sonst null. */
export function ausweisAusZeile(zeile: string): string | null {
  if (!zeile.includes('anmelden') || !zeile.includes('sai_')) return null;
  let obj: { type?: unknown; message?: { content?: unknown } };
  try { obj = JSON.parse(zeile) as typeof obj; } catch { return null; }
  if (obj.type !== 'assistant' || !Array.isArray(obj.message?.content)) return null;
  let gefunden: string | null = null;
  for (const b of obj.message.content as Array<Record<string, unknown> | null>) {
    if (!b || b.type !== 'tool_use' || typeof b.name !== 'string' || !/(^|__)chat$/.test(b.name)) continue;
    const input = (b.input ?? {}) as Record<string, unknown>;
    if (input.action !== 'anmelden') continue;
    const k = input.agent_kennung ?? input.token;
    if (typeof k === 'string' && AUSWEIS.test(k)) gefunden = k;
  }
  return gefunden;
}

/**
 * Eintraege einer Sitzung je Ausweis (rein). Zeilen vor der ersten Anmeldung gehoeren zum ersten gefundenen Ausweis
 * bzw. zu startAusweis aus einem frueheren Takt, nach einem Wechsel zum neuen. Ohne jeden Ausweis: keine Gruppen.
 */
export function eintraegeJeAusweis(zeilen: readonly string[], startAusweis: string | null = null, gezaehlt: string | null = null):
  { gruppen: Array<{ ausweis: string; eintraege: SitzungsEintrag[] }>; letzterAusweis: string | null } {
  const g = zeilenJeAusweis(zeilen, startAusweis, ausweisAusZeile);
  return {
    gruppen: g.gruppen.map((x) => ({ ausweis: x.ausweis, eintraege: sitzungsEintraegeAus(x.zeilen, { gezaehlt: gezaehlt ? [gezaehlt] : null }) }))
      .filter((x) => x.eintraege.length > 0),
    letzterAusweis: g.letzterAusweis,
  };
}

/** P22-T288 W2: dasselbe fuer Codex-Rollouts (Ausweis aus codexAusweisAusZeile, Eintraege aus codexEintraegeAus). Rein. */
export function codexEintraegeJeAusweis(zeilen: readonly string[], startAusweis: string | null = null, modell: string | null = null):
  { gruppen: Array<{ ausweis: string; eintraege: SitzungsEintrag[] }>; letzterAusweis: string | null } {
  const g = zeilenJeAusweis(zeilen, startAusweis, codexAusweisAusZeile);
  let m = modell;
  const gruppen = g.gruppen.map((x) => {
    const eintraege = codexEintraegeAus(x.zeilen, { modell: m });
    m = letztesCodexModell(x.zeilen) ?? m;
    return { ausweis: x.ausweis, eintraege };
  }).filter((x) => x.eintraege.length > 0);
  return { gruppen, letzterAusweis: g.letzterAusweis };
}

/** Zeilen je Ausweis (rein): Vorlauf vor der ersten Anmeldung gehoert zum ersten Ausweis bzw. zu startAusweis, Wechsel = neue Gruppe. */
function zeilenJeAusweis(zeilen: readonly string[], startAusweis: string | null, erkenne: (z: string) => string | null):
  { gruppen: Array<{ ausweis: string; zeilen: string[] }>; letzterAusweis: string | null } {
  const gruppen: Array<{ ausweis: string; zeilen: string[] }> = startAusweis ? [{ ausweis: startAusweis, zeilen: [] }] : [];
  let vorlauf: string[] = [];
  for (const z of zeilen) {
    const a = erkenne(z);
    const letzte = gruppen[gruppen.length - 1];
    if (a && a !== letzte?.ausweis) {
      gruppen.push({ ausweis: a, zeilen: letzte ? [] : vorlauf });
      vorlauf = [];
    }
    const ziel = gruppen[gruppen.length - 1];
    if (ziel) ziel.zeilen.push(z);
    else vorlauf.push(z);
  }
  return { gruppen, letzterAusweis: gruppen[gruppen.length - 1]?.ausweis ?? null };
}

/** P22-T288 W2: Modell des letzten turn_context in den Zeilen (null = keins). Rein. */
export function letztesCodexModell(zeilen: readonly string[]): string | null {
  for (let i = zeilen.length - 1; i >= 0; i--) {
    if (!zeilen[i].includes('"turn_context"')) continue;
    try {
      const o = JSON.parse(zeilen[i]) as { type?: unknown; payload?: { model?: unknown } };
      if (o.type === 'turn_context' && typeof o.payload?.model === 'string' && o.payload.model) return o.payload.model;
    } catch { /* unvollstaendig */ }
  }
  return null;
}

/** P22-T288: agentId aus dem Dateinamen eines Harness-Subagenten (agent-<agentId>.jsonl), sonst null. Rein. */
export function subagentId(dateiname: string): string | null {
  const m = /^agent-([A-Za-z0-9_.-]{1,200})\.jsonl$/.exec(dateiname);
  return m ? m[1] : null;
}

/** P22-T288 W7: message.id der letzten Modellantwort in den Zeilen (null = keine). Rein. */
export function letzteNachrichtId(zeilen: readonly string[]): string | null {
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const z = zeilen[i];
    if (!z.includes('"assistant"')) continue;
    try {
      const o = JSON.parse(z) as { type?: unknown; message?: { id?: unknown } };
      if (o.type === 'assistant' && typeof o.message?.id === 'string') return o.message.id;
    } catch { /* unvollstaendig */ }
  }
  return null;
}

/**
 * Null-Bytes raus (rein): PostgreSQL weist text mit 0x00 ab, und der Fehler kippt den ganzen Stapel (gesehen an
 * einer Werkzeug-Ausgabe der Koordinator-Sitzung, 25.10.2026). Bereinigt werden die Strings selbst, nicht der
 * JSON-Text - sonst wuerde ein woertliches "\u0000" (mit Backslash) im Inhalt zerstoert.
 */
function bereinige(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('\0') ? v.replace(/\0/g, '') : v;
  if (Array.isArray(v)) return v.map(bereinige);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, bereinige(w)]));
  return v;
}
export function ohneNullBytes(e: SitzungsEintrag): SitzungsEintrag {
  return JSON.stringify(e).includes('\\u0000') ? bereinige(e) as SitzungsEintrag : e;
}

/** Stapel fuer den Versand: hoechstens STAPEL_EINTRAEGE Eintraege bzw. etwa STAPEL_BYTES (rein), ohne Null-Bytes. */
export function inStapeln(eintraege: readonly SitzungsEintrag[]): SitzungsEintrag[][] {
  const stapel: SitzungsEintrag[][] = [];
  let aktuell: SitzungsEintrag[] = [];
  let bytes = 0;
  for (const roh of eintraege) {
    const e = ohneNullBytes(roh);
    const n = Buffer.byteLength(JSON.stringify(e), 'utf8');
    if (aktuell.length && (aktuell.length >= STAPEL_EINTRAEGE || bytes + n > STAPEL_BYTES)) { stapel.push(aktuell); aktuell = []; bytes = 0; }
    aktuell.push(e);
    bytes += n;
  }
  if (aktuell.length) stapel.push(aktuell);
  return stapel;
}

/** P22-T288 Option B: Dateien der letzten so vielen Tage laufen jeden Takt vollstaendig; aeltere (bis cli_verlauf.tage) gedrosselt. */
export const NORMAL_FENSTER_TAGE = 2;

/** P22-T288 Option B: Drosselung des Nachzugs, config cli_verlauf.nachzug_dateien_je_takt, 1..100, Standard 5. Rein. */
export function nachzugJeTakt(wert: unknown): number {
  const j = typeof wert === 'number' || (typeof wert === 'string' && wert.trim() !== '') ? Number(wert) : NaN;
  return Number.isFinite(j) && j >= 1 ? Math.min(Math.floor(j), 100) : 5;
}

/** P22-T288 Option B: Datei noch nicht fertig gelesen? Mit Ausweis zaehlt offset, ohne Ausweis gesucht_bis. Rein. */
export function nachzugOffen(s: DateiStand | undefined, groesse: number): boolean {
  if (!s) return true;
  return (s.ausweis ? s.offset : (s.gesucht_bis ?? 0)) < groesse;
}

/** P22-T288 Option B: Auswahl je Takt - aelter als normalAb, noch offen, aelteste zuerst, hoechstens jeTakt. Rein. */
export function waehleNachzug<T extends { pfad: string; groesse: number; mtime: number }>(kandidaten: readonly T[], normalAb: number,
  stand: Stand, jeTakt: number): { gewaehlt: T[]; offen: number; gesamt: number } {
  const alt = kandidaten.filter((d) => d.mtime < normalAb);
  const offen = alt.filter((d) => nachzugOffen(stand[d.pfad], d.groesse)).sort((a, b) => a.mtime - b.mtime);
  return { gewaehlt: offen.slice(0, Math.max(0, jeTakt)), offen: offen.length, gesamt: alt.length };
}

/** Schalter je Takt frisch: aktiv (Tray-Haken, Standard aus), P22-T288 subagenten und codex (je Standard EIN, false/Env 0 = aus), Nachzug-Drosselung. */
function leseSchalter(): { aktiv: boolean; subagenten: boolean; codex: boolean; nachzug_je_takt: number } {
  try {
    const j = JSON.parse(fs.readFileSync(configFilePath(), 'utf-8')) as { cli_verlauf?: { aktiv?: unknown; subagenten?: unknown; codex?: unknown;
      nachzug_dateien_je_takt?: unknown } };
    return { aktiv: j?.cli_verlauf?.aktiv === true,
      subagenten: j?.cli_verlauf?.subagenten !== false && process.env.CLI_VERLAUF_SUBAGENTEN !== '0',
      codex: j?.cli_verlauf?.codex !== false && process.env.CLI_VERLAUF_CODEX !== '0',
      nachzug_je_takt: nachzugJeTakt(j?.cli_verlauf?.nachzug_dateien_je_takt) };
  } catch { return { aktiv: false, subagenten: false, codex: false, nachzug_je_takt: 5 }; }
}

const nachzugPfad = (): string => path.join(configDir(), 'cli-verlauf-nachzug.json');
function schreibeNachzugStand(d: Record<string, unknown>): void {
  try { fs.writeFileSync(nachzugPfad(), JSON.stringify(d, null, 2), { mode: 0o600 }); }
  catch (err) { console.error('[cli-verlauf] Nachzug-Debug nicht geschrieben:', (err as Error).message); }
}

const standPfad = (): string => path.join(configDir(), 'cli-verlauf-stand.json');
function leseStand(): Stand {
  try { const j = JSON.parse(fs.readFileSync(standPfad(), 'utf-8')); return j && typeof j === 'object' && !Array.isArray(j) ? j as Stand : {}; }
  catch { return {}; }
}
function schreibeStand(s: Stand): void {
  const tmp = standPfad() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, standPfad());
}

const sitzungsWurzel = (): string => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
/**
 * P22-T288 (Pruefung): Lesefenster in Tagen fuer Claude-, Subagenten- und Codex-Dateien. Env CLI_VERLAUF_TAGE geht vor, sonst
 * config.json cli_verlauf.tage, sonst 2. Einmaliger Nachzug aelterer Sitzungen (Grundsatz "alles in PG"): cli_verlauf.tage hoch
 * setzen (z. B. 400); Dateien aelter als NORMAL_FENSTER_TAGE kommen gedrosselt (nachzug_dateien_je_takt) dazu; wenn
 * cli-verlauf-nachzug.json offen 0 zeigt, wieder entfernen - der Stand je Datei und ON CONFLICT der Schreibstelle verhindern
 * Doppeltes. Hoechstens 3650. Rein.
 */
export function fensterTage(envWert: string | undefined, configWert: unknown): number {
  const e = envWert !== undefined && envWert.trim() !== '' ? Number(envWert) : NaN;
  if (Number.isFinite(e) && e > 0) return Math.min(e, 3650);
  const c = typeof configWert === 'number' || typeof configWert === 'string' ? Number(configWert) : NaN;
  if (Number.isFinite(c) && c > 0) return Math.min(c, 3650);
  return 2;
}
const fensterAb = (): number => {
  let konfig: unknown = null;
  try { konfig = (JSON.parse(fs.readFileSync(configFilePath(), 'utf-8')) as { cli_verlauf?: { tage?: unknown } })?.cli_verlauf?.tage; } catch { /* Standard */ }
  return Date.now() - fensterTage(process.env.CLI_VERLAUF_TAGE, konfig) * 86_400_000;
};

/** P22-T288 W2: frische Codex-Rollouts (CODEX_HOME bzw. ~/.codex, sessions/<JJJJ>/<MM>/<TT>/rollout-*.jsonl), aelteste zuerst. */
export function codexDateien(ab: number = fensterAb()): Array<{ pfad: string; groesse: number; mtime: number }> {
  const wurzel = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const aus: Array<{ pfad: string; groesse: number; mtime: number }> = [];
  const kinder = (p: string): string[] => { try { return fs.readdirSync(p); } catch { return []; } };
  for (const j of kinder(wurzel)) for (const mo of kinder(path.join(wurzel, j))) for (const t of kinder(path.join(wurzel, j, mo))) {
    const tag = path.join(wurzel, j, mo, t);
    for (const n of kinder(tag)) {
      if (!n.startsWith('rollout-') || !n.endsWith('.jsonl')) continue;
      try { const st = fs.statSync(path.join(tag, n)); if (st.isFile() && st.mtimeMs >= ab) aus.push({ pfad: path.join(tag, n), groesse: st.size, mtime: st.mtimeMs }); } catch { /* weg */ }
    }
  }
  return aus.sort((a, b) => a.mtime - b.mtime);
}

/**
 * Frische Sitzungsdateien: <ordner>/*.jsonl und (P22-T288, subagenten) <ordner>/<sitzung>/subagents/agent-*.jsonl. Aelteste zuerst,
 * damit die Erstdatei eines Teammates ihren Ausweis im Stand hat, bevor seine Wiederaufnahme-Datei ihn erbt.
 */
export function sitzungsDateien(subagenten: boolean, ab: number = fensterAb()): Array<{ pfad: string; groesse: number; agent_id: string | null; mtime: number }> {
  const wurzel = sitzungsWurzel();
  const aus: Array<{ pfad: string; groesse: number; agent_id: string | null; mtime: number }> = [];
  const nimm = (pfad: string, agent_id: string | null): void => {
    try { const st = fs.statSync(pfad); if (st.isFile() && st.mtimeMs >= ab) aus.push({ pfad, groesse: st.size, agent_id, mtime: st.mtimeMs }); } catch { /* weg */ }
  };
  let ordner: string[] = [];
  try { ordner = fs.readdirSync(wurzel); } catch { return aus; }
  for (const o of ordner) {
    let namen: string[] = [];
    try { namen = fs.readdirSync(path.join(wurzel, o)); } catch { continue; }
    for (const n of namen) {
      if (n.endsWith('.jsonl')) { nimm(path.join(wurzel, o, n), null); continue; }
      if (!subagenten) continue;
      let sub: string[] = [];
      try { sub = fs.readdirSync(path.join(wurzel, o, n, 'subagents')); } catch { continue; }
      for (const s of sub) { const id = subagentId(s); if (id) nimm(path.join(wurzel, o, n, 'subagents', s), id); }
    }
  }
  return aus.sort((a, b) => a.mtime - b.mtime);
}

/** P22-T288 (Pruefung): parentUuid der ersten Zeile (neue Harness-Sitzung: null; Wiederaufnahme: letzte uuid des Vorgaengers). */
export function ersteParentUuid(pfad: string, groesse: number): string | null {
  try {
    const erste = liesZeilenAb(pfad, 0, Math.min(groesse, 8 * 1024 * 1024)).zeilen[0];
    if (!erste) return null;
    const o = JSON.parse(erste) as { parentUuid?: unknown };
    return typeof o.parentUuid === 'string' && o.parentUuid ? o.parentUuid : null;
  } catch { return null; }
}

/**
 * P22-T288 (Pruefung claude-linde): Ausweis-Erbe NUR bei belegter Wiederaufnahme. Die erste Zeile verweist per parentUuid auf eine
 * uuid, die in einer Schwesterdatei DERSELBEN agentId im selben Projektordner steht; Erbe = letzter Ausweis dieser Vorgaengerdatei
 * (aus dem Stand, sonst aus ihren Zeilen). Neue Sitzung (parentUuid null), fehlender Beleg oder Vorgaenger ohne Ausweis -> null:
 * der Verlauf wird nie einer fremden Identitaet zugeordnet (eine neue Sitzung mit gleichem Teammate-Namen hat dieselbe agentId).
 */
export function ausweisErbe(stand: Stand, pfad: string, agentId: string, groesse: number): { ausweis: string; von: string } | null {
  const parent = ersteParentUuid(pfad, groesse);
  if (!parent) return null;
  const nadel = '"uuid":"' + parent + '"';
  const ordner = path.dirname(path.dirname(path.dirname(pfad)));
  let sitzungen: string[] = [];
  try { sitzungen = fs.readdirSync(ordner); } catch { return null; }
  for (const sz of sitzungen) {
    const p = path.join(ordner, sz, 'subagents', 'agent-' + agentId + '.jsonl');
    if (p === pfad) continue;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      const { zeilen } = liesZeilenAb(p, 0, st.size);
      if (!zeilen.some((z) => z.includes(nadel))) continue;
      const ausStand = stand[p]?.ausweis;
      let a: string | null = ausStand && AUSWEIS.test(ausStand) ? ausStand : null;
      if (!a) for (const z of zeilen) a = ausweisAusZeile(z) ?? a;
      return a ? { ausweis: a, von: p } : null;
    } catch { /* weg */ }
  }
  return null;
}

/** Vollstaendige Zeilen ab Byte-Position; ende = Position hinter der letzten vollstaendigen Zeile. */
function liesZeilenAb(pfad: string, ab: number, bis: number): { zeilen: string[]; ende: number } {
  if (bis <= ab) return { zeilen: [], ende: ab };
  const fd = fs.openSync(pfad, 'r');
  try {
    const puffer = Buffer.alloc(bis - ab);
    const n = fs.readSync(fd, puffer, 0, puffer.length, ab);
    const letzte = puffer.subarray(0, n).lastIndexOf(0x0a);
    if (letzte < 0) return { zeilen: [], ende: ab };
    return { zeilen: puffer.subarray(0, letzte).toString('utf8').split('\n'), ende: ab + letzte + 1 };
  } finally { fs.closeSync(fd); }
}

async function sende(ausweis: string, eintraege: SitzungsEintrag[], runtime: 'claude' | 'codex' = 'claude'): Promise<number> {
  let aufgenommen = 0;
  for (const stapel of inStapeln(eintraege)) {
    const r = await anfrage<{ aufgenommen?: unknown }>('/api/daemon/cli-verlauf',
      { method: 'POST', body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, ausweis, runtime, eintraege: stapel } }, 60_000);
    aufgenommen += typeof r.aufgenommen === 'number' ? r.aufgenommen : 0;
  }
  return aufgenommen;
}

/** Ein Takt: alle frischen Sitzungsdateien nachziehen. Transportfehler: Stand bleibt, naechster Takt versucht es erneut. */
export async function cliVerlaufTakt(): Promise<void> {
  const schalter = leseSchalter();
  if (!schalter.aktiv) return;
  const stand = leseStand();
  let geaendert = false;
  let transportFehler = false;
  // P22-T288 Option B: EIN Fenster (fensterAb = cli_verlauf.tage). Die letzten NORMAL_FENSTER_TAGE laufen voll, aeltere gedrosselt.
  const gesamtAb = fensterAb();
  const normalAb = Math.max(gesamtAb, Date.now() - NORMAL_FENSTER_TAGE * 86_400_000);
  let claudeListe = sitzungsDateien(schalter.subagenten, normalAb);
  let codexListe = schalter.codex ? codexDateien(normalAb) : [];
  // Pruefer birke (P22-T288 Option B): Nachzug-Dateien laufen NACH dem Lesefenster; ihr Fehler stoppt nur den Nachzug des Takts.
  const nachzugPfade = new Set<string>();
  let nachzugFehler = false;
  if (normalAb - gesamtAb > 60_000) {
    const kandidaten = [...sitzungsDateien(schalter.subagenten, gesamtAb).map((d) => ({ ...d, art: 'claude' as const })),
      ...(schalter.codex ? codexDateien(gesamtAb).map((d) => ({ ...d, agent_id: null, art: 'codex' as const })) : [])];
    const w = waehleNachzug(kandidaten, normalAb, stand, schalter.nachzug_je_takt);
    claudeListe = [...claudeListe, ...w.gewaehlt.filter((d) => d.art === 'claude')];
    codexListe = [...codexListe, ...w.gewaehlt.filter((d) => d.art === 'codex')];
    for (const d of w.gewaehlt) nachzugPfade.add(d.pfad);
    const tage = Math.round((Date.now() - gesamtAb) / 86_400_000);
    schreibeNachzugStand({ tage, je_takt: schalter.nachzug_je_takt, gesamt: w.gesamt, offen: w.offen,
      in_diesem_takt: w.gewaehlt.length, erledigt: w.gesamt - w.offen, am: new Date().toISOString() });
    if (w.gewaehlt.length) console.error(`[cli-verlauf] Nachzug: ${w.gewaehlt.length} von ${w.offen} offenen Dateien (Fenster ${tage} Tage)`);
  }
  for (const { pfad, groesse, agent_id } of claudeListe) {
    const s: DateiStand = stand[pfad] ?? { offset: 0, ausweis: null, gesendet: 0, ...(agent_id ? { agent_id } : {}) };
    // P22-T288: Wiederaufnahme ohne eigene Anmeldung erbt den Ausweis nur bei belegter Kette (ausweisErbe).
    let erbe: string | null = null;
    let erbeVon: string | null = null;
    if (s.offset >= groesse && (s.gesucht_bis ?? 0) >= groesse) continue;
    if (!s.ausweis) {
      // Noch kein Ausweis: nur den neuen Teil nach einer Anmeldung durchsuchen, erst bei einem Fund (oder Erbe) alles lesen.
      const neu = liesZeilenAb(pfad, s.gesucht_bis ?? 0, groesse);
      if (neu.zeilen.some((z) => ausweisAusZeile(z))) erbe = null; // eigene Anmeldung geht dem Erbe vor
      else {
        if (agent_id && neu.zeilen.length) {
          const e = ausweisErbe(stand, pfad, agent_id, groesse);
          erbe = e?.ausweis ?? null;
          erbeVon = e?.von ?? null;
        }
        if (!erbe) {
          if (neu.ende !== (s.gesucht_bis ?? 0)) { stand[pfad] = { ...s, gesucht_bis: neu.ende, am: Date.now() }; geaendert = true; }
          continue;
        }
      }
    }
    const { zeilen, ende } = liesZeilenAb(pfad, s.offset, groesse);
    if (!zeilen.length) continue;
    const { gruppen, letzterAusweis } = eintraegeJeAusweis(zeilen, s.ausweis ?? erbe, s.letzte_nachricht ?? null);
    const ausweis_quelle: DateiStand['ausweis_quelle'] = zeilen.some((z) => ausweisAusZeile(z)) ? 'anmeldung'
      : s.ausweis ? (s.ausweis_quelle ?? 'anmeldung') : erbe ? 'erbe' : null;
    const zusatz: Partial<DateiStand> = { ...(agent_id ? { agent_id } : {}), ausweis_quelle,
      letzte_nachricht: letzteNachrichtId(zeilen) ?? s.letzte_nachricht ?? null, am: Date.now(),
      ...((erbeVon ?? s.erbe_von) ? { erbe_von: erbeVon ?? s.erbe_von } : {}) };
    if (erbe && !s.ausweis) console.error(`[cli-verlauf] ${path.basename(pfad)}: Ausweis von agentId ${agent_id} geerbt (belegte Wiederaufnahme, Vorgaenger ${erbeVon ? path.basename(path.dirname(path.dirname(erbeVon))) : '?'})`);
    try {
      let gesendet = 0;
      for (const g of gruppen) gesendet += await sende(g.ausweis, g.eintraege);
      stand[pfad] = { offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, gesendet: s.gesendet + gesendet, fehler: null, ...zusatz };
      geaendert = true;
      if (gesendet) console.error(`[cli-verlauf] ${path.basename(pfad)}: ${gesendet} Eintrag/Eintraege uebertragen`);
    } catch (err) {
      const code = err instanceof DaemonJobsApiFehler ? err.code : undefined;
      if (code === 'ausweis_ungueltig') {
        // Ausweis widerrufen/unbekannt: diese Zeilen nie wieder senden, aber sichtbar vermerken.
        stand[pfad] = { ...s, offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, fehler: 'ausweis_ungueltig', ...zusatz };
        geaendert = true;
        continue;
      }
      stand[pfad] = { ...s, fehler: (err as Error).message.slice(0, 300) };
      geaendert = true;
      console.error(`[cli-verlauf] ${path.basename(pfad)}: Uebertragung fehlgeschlagen, naechster Takt versucht es erneut: ${(err as Error).message}`);
      if (nachzugPfade.has(pfad)) nachzugFehler = true; else transportFehler = true;
      break;
    }
  }
  // P22-T288 W2: lokale Codex-Rollouts ueber denselben Weg (runtime codex); bei Transportfehler erst im naechsten Takt.
  if (schalter.codex && !transportFehler) {
    for (const { pfad, groesse } of codexListe) {
      if (nachzugFehler && nachzugPfade.has(pfad)) continue;
      const s: DateiStand = stand[pfad] ?? { offset: 0, ausweis: null, gesendet: 0, runtime: 'codex' };
      if (s.offset >= groesse && (s.gesucht_bis ?? 0) >= groesse) continue;
      if (!s.ausweis) {
        const neu = liesZeilenAb(pfad, s.gesucht_bis ?? 0, groesse);
        if (!neu.zeilen.some((z) => codexAusweisAusZeile(z))) {
          if (neu.ende !== (s.gesucht_bis ?? 0)) { stand[pfad] = { ...s, runtime: 'codex', gesucht_bis: neu.ende, am: Date.now() }; geaendert = true; }
          continue;
        }
      }
      const { zeilen, ende } = liesZeilenAb(pfad, s.offset, groesse);
      if (!zeilen.length) continue;
      const { gruppen, letzterAusweis } = codexEintraegeJeAusweis(zeilen, s.ausweis, s.modell ?? null);
      const zusatz: Partial<DateiStand> = { runtime: 'codex', ausweis_quelle: 'anmeldung', modell: letztesCodexModell(zeilen) ?? s.modell ?? null, am: Date.now() };
      try {
        let gesendet = 0;
        for (const g of gruppen) gesendet += await sende(g.ausweis, g.eintraege, 'codex');
        stand[pfad] = { offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, gesendet: s.gesendet + gesendet, fehler: null, ...zusatz };
        geaendert = true;
        if (gesendet) console.error(`[cli-verlauf] codex ${path.basename(pfad)}: ${gesendet} Eintrag/Eintraege uebertragen`);
      } catch (err) {
        const code = err instanceof DaemonJobsApiFehler ? err.code : undefined;
        if (code === 'ausweis_ungueltig') {
          stand[pfad] = { ...s, offset: ende, ausweis: letzterAusweis, gesucht_bis: ende, fehler: 'ausweis_ungueltig', ...zusatz };
          geaendert = true;
          continue;
        }
        stand[pfad] = { ...s, runtime: 'codex', fehler: (err as Error).message.slice(0, 300) };
        geaendert = true;
        console.error(`[cli-verlauf] codex ${path.basename(pfad)}: Uebertragung fehlgeschlagen, naechster Takt versucht es erneut: ${(err as Error).message}`);
        break;
      }
    }
  }
  if (geaendert) schreibeStand(stand);
}

export interface CliVerlaufHandle { stop(): void }

export function startCliVerlauf(): CliVerlaufHandle {
  let laeuft = false;
  const takt = async () => {
    if (laeuft) return;
    laeuft = true;
    try { await cliVerlaufTakt(); }
    catch (err) { console.error('[cli-verlauf] Takt fehlgeschlagen:', (err as Error).message); }
    finally { laeuft = false; }
  };
  const timer = setInterval(() => { void takt(); }, TAKT_MS);
  timer.unref();
  void takt();
  return { stop: () => clearInterval(timer) };
}
