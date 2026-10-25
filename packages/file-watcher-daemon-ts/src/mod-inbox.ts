/**
 * MODUL: mod-inbox.ts (P22-T134)
 * ZWECK: Nachrichten (Job 'zustellen' der API) an interaktive Claude-Code-Sitzungen ohne Wrapper uebergeben. Eine Claude-Code-
 *        Mod in der Sitzung wartet hier, startet mit der Nachricht einen Turn ($.prompt.submit) und quittiert (Beleg thought
 *        5b2efc34). Ersetzt cc-wrap/cc-send fuer Koordinator-CLI und Subagenten mit Ausweis.
 * LOKALE ROUTEN (api.ts, nur Loopback, kein Browser-Origin):
 *   GET  /mod-inbox/warte?sitzung=<uuid>   haelt bis WARTE_MS offen, liefert { nachricht: {id,text} | null, aktiv, grund }
 *   POST /mod-inbox/quittung               { sitzung, id, gestartet, grund? } nach $.prompt.submit
 *   GET  /mod-inbox/status                 Debug: Sitzungen (ohne Ausweis; P22-T144 mit offenen Quittungen laut API), offene
 *                                          Uebergaben, letzte Abweisungen der Mod (drop-Grund von $.prompt.submit), letzter Fehler
 * ZUORDNUNG: Sitzung -> Ausweis aus dem Transcript ~/.claude/projects/<ordner>/<sitzung>.jsonl (letzte chat(anmelden)-Zeile,
 *   ausweisAusZeile wie cli-verlauf). Der Ausweis geht nur an die API (POST /api/daemon/mod-inbox), nie an die Mod.
 * ZUSTELLUNG: zustelleAnMod (specialist-job-worker, Fall 'zustellen' ohne Wrapper) reiht ein und wartet hoechstens
 *   UEBERGABE_FRIST_MS auf die Quittung. Dieselbe Nachricht (weg:message_id) wird nie zweimal uebergeben; ein spaeterer Job
 *   derselben Nachricht wartet auf die laufende Uebergabe bzw. meldet sie als zugestellt.
 * SCHALTER: Produkt-Schalter mod_inbox auf der API; sie antwortet je Sitzung mit aktiv. Ohne aktive Meldung nimmt der Daemon
 *   fuer diese Sitzung nichts an (zustelleAnMod -> null = bisheriger Weg 'nicht_verbunden'). Aus: MOD_INBOX_DISABLED=1.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ausweisAusZeile } from './cli-verlauf.js';
import { anfrage, DAEMON_API_ID, DAEMON_HOST } from './daemon-jobs-api.js';
import { istLoopback } from './skills-proxy.js';

const TAKT_MS = 15_000;
/** So lange haelt ein Abruf der Mod hoechstens offen. */
const WARTE_MS = 25_000;
/** Ohne Abruf gilt eine Sitzung nach dieser Zeit als beendet. */
const SITZUNG_WEG_MS = 60_000;
/** So lange wartet ein Job 'zustellen' auf die Quittung, danach 'beschaeftigt' (die API versucht es spaeter erneut). */
const UEBERGABE_FRIST_MS = 20_000;
/** Gestartete Uebergaben bleiben so lange bekannt, damit ein spaeterer Job derselben Nachricht 'zugestellt' erfaehrt. */
const GESTARTET_BEHALTEN_MS = 60 * 60_000;
/** Lesestueck beim Durchsuchen des Transcripts. */
const STUECK = 16 * 1024 * 1024;
const SITZUNG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ModNachricht { id: string; text: string }
interface Sitzung {
  id: string;
  zuletzt: number;
  transcript: string | null;
  gelesen_bis: number;
  ausweis: string | null;
  identity_id: string | null;
  aktiv: boolean;
  grund: string | null;
  /** P22-T144: offene Quittungen dieser Identitaet laut letzter API-Antwort (nur Schalter inbox_quittung). */
  offene_quittungen: { anzahl: number; aelteste_s: number | null } | null;
  schlange: ModNachricht[];
  /** Offener Abruf; false = der Abruf war schon abgebrochen, die Nachricht bleibt in der Schlange. */
  warter: ((n: ModNachricht | null) => boolean) | null;
}
type UebergabeStand = 'wartet' | 'uebergeben' | 'gestartet' | 'abgewiesen';
interface Uebergabe { sitzung: string; stand: UebergabeStand; grund: string | null; am: number; fertig: Array<() => void> }
// type statt interface: specialist-job-worker liefert das Ergebnis als Record<string, unknown> aus.
export type ModZustellAntwort = { success: true; zugestellt: boolean; grund?: string; weg: 'mod_inbox' };

const sitzungen = new Map<string, Sitzung>();
const uebergaben = new Map<string, Uebergabe>();
let letzterFehler: string | null = null;
let letzteMeldung: string | null = null;
/** P22-T144: letzte Abweisungen der Mod (Grund aus $.prompt.submit drop), neueste zuletzt. */
const abweisungen: Array<{ id: string; sitzung: string; grund: string; am: string }> = [];
const ABWEISUNGEN_MAX = 20;

function sitzungFuer(id: string, jetzt = Date.now()): Sitzung {
  let s = sitzungen.get(id);
  if (!s) {
    s = { id, zuletzt: jetzt, transcript: null, gelesen_bis: 0, ausweis: null, identity_id: null, aktiv: false, grund: 'noch_nicht_gemeldet', offene_quittungen: null, schlange: [], warter: null };
    sitzungen.set(id, s);
  }
  s.zuletzt = jetzt;
  return s;
}

function lebt(s: Sitzung, jetzt = Date.now()): boolean {
  return s.warter !== null || jetzt - s.zuletzt <= SITZUNG_WEG_MS;
}

function markiere(id: string, stand: UebergabeStand, grund: string | null = null): void {
  const u = uebergaben.get(id);
  if (!u) return;
  u.stand = stand;
  u.grund = grund;
  u.am = Date.now();
  if (stand === 'gestartet' || stand === 'abgewiesen') for (const f of u.fertig.splice(0)) f();
}

/** Erste wartende Nachricht an einen offenen Abruf geben. */
function reicheWeiter(s: Sitzung): void {
  if (!s.warter || s.schlange.length === 0) return;
  const n = s.schlange.shift() as ModNachricht;
  if (s.warter(n)) markiere(n.id, 'uebergeben');
  else s.schlange.unshift(n);
}

/** Abruf der Mod: naechste Nachricht oder nach ms null. Ein neuer Abruf derselben Sitzung beendet den alten (mit null). */
export function warte(id: string, ms = WARTE_MS): { ergebnis: Promise<ModNachricht | null>; abbrechen: () => void } {
  const s = sitzungFuer(id);
  let abgebrochen = false;
  let ende: (n: ModNachricht | null) => boolean = () => false;
  const ergebnis = new Promise<ModNachricht | null>((resolve) => {
    const timer = setTimeout(() => { ende(null); }, ms);
    timer.unref?.();
    ende = (n) => {
      if (s.warter === ende) s.warter = null;
      clearTimeout(timer);
      if (n && abgebrochen) return false;
      resolve(n);
      return true;
    };
  });
  s.warter?.(null);
  s.warter = ende;
  reicheWeiter(s);
  return { ergebnis, abbrechen: () => { abgebrochen = true; ende(null); } };
}

/** Quittung der Mod nach $.prompt.submit. false = unbekannte Uebergabe oder fremde Sitzung. */
export function quittiere(sitzung: string, id: string, gestartet: boolean, grund: string | null): boolean {
  const u = uebergaben.get(id);
  if (!u || u.sitzung !== sitzung) return false;
  sitzungFuer(sitzung);
  markiere(id, gestartet ? 'gestartet' : 'abgewiesen', gestartet ? null : (grund ?? 'abgewiesen').slice(0, 200));
  if (!gestartet) {
    abweisungen.push({ id, sitzung, grund: (grund ?? 'abgewiesen').slice(0, 200), am: new Date().toISOString() });
    if (abweisungen.length > ABWEISUNGEN_MAX) abweisungen.splice(0, abweisungen.length - ABWEISUNGEN_MAX);
  }
  return true;
}

function raeumeAuf(jetzt = Date.now()): void {
  for (const [id, s] of sitzungen) {
    if (lebt(s, jetzt)) continue;
    sitzungen.delete(id);
    // Offene Uebergaben einer beendeten Sitzung freigeben: die API stellt sie spaeter erneut (ggf. an eine neue Sitzung) zu.
    for (const [k, u] of uebergaben) if (u.sitzung === id && u.stand !== 'gestartet') { uebergaben.delete(k); for (const f of u.fertig.splice(0)) f(); }
  }
  for (const [k, u] of uebergaben) if (u.stand === 'gestartet' && jetzt - u.am > GESTARTET_BEHALTEN_MS) uebergaben.delete(k);
}

/** true = fuer diese Identitaet wartet eine lebende, freigegebene Mod-Sitzung (specialist-job-worker: ohne Startumgebung). */
export function hatModSitzung(identityId: string | null | undefined): boolean {
  if (!identityId) return false;
  for (const s of sitzungen.values()) if (s.aktiv && s.identity_id === identityId && lebt(s)) return true;
  return false;
}

/**
 * Fall 'zustellen' ohne Wrapper: an die juengste lebende, freigegebene Sitzung dieser Identitaet uebergeben und auf die
 * Quittung warten. null = keine solche Sitzung (Aufrufer antwortet wie bisher 'nicht_verbunden').
 */
export async function zustelleAnMod(identityId: string, schluessel: string, text: string, fristMs = UEBERGABE_FRIST_MS): Promise<ModZustellAntwort | null> {
  raeumeAuf();
  let u = uebergaben.get(schluessel);
  if (u?.stand === 'gestartet') return { success: true, zugestellt: true, weg: 'mod_inbox' };
  if (!u) {
    const s = [...sitzungen.values()].filter((x) => x.aktiv && x.identity_id === identityId && lebt(x)).sort((a, b) => b.zuletzt - a.zuletzt)[0];
    if (!s) return null;
    u = { sitzung: s.id, stand: 'wartet', grund: null, am: Date.now(), fertig: [] };
    uebergaben.set(schluessel, u);
    s.schlange.push({ id: schluessel, text });
    reicheWeiter(s);
  }
  const offen = u;
  if (offen.stand === 'wartet' || offen.stand === 'uebergeben') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, fristMs);
      offen.fertig.push(() => { clearTimeout(t); resolve(); });
    });
  }
  if (offen.stand === 'gestartet') return { success: true, zugestellt: true, weg: 'mod_inbox' };
  if (offen.stand === 'abgewiesen') {
    uebergaben.delete(schluessel);
    return { success: true, zugestellt: false, grund: 'abgewiesen', weg: 'mod_inbox' };
  }
  if (offen.stand === 'wartet') {
    // Nie abgeholt: zurueckziehen, die API versucht es spaeter erneut.
    const s = sitzungen.get(offen.sitzung);
    if (s) s.schlange = s.schlange.filter((n) => n.id !== schluessel);
    uebergaben.delete(schluessel);
  }
  // 'uebergeben': die Mod hat sie, die Sitzung arbeitet noch; die Quittung kommt spaeter, ein neuer Job sieht sie.
  return { success: true, zugestellt: false, grund: 'beschaeftigt', weg: 'mod_inbox' };
}

function findeTranscript(id: string): string | null {
  const wurzel = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let ordner: string[] = [];
  try { ordner = fs.readdirSync(wurzel); } catch { return null; }
  for (const o of ordner) {
    const p = path.join(wurzel, o, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Neue vollstaendige Zeilen des Transcripts nach der letzten Anmeldung durchsuchen (Ausweiswechsel inklusive). */
function leseAusweis(s: Sitzung): void {
  if (!s.transcript) s.transcript = findeTranscript(s.id);
  if (!s.transcript) return;
  let groesse = 0;
  try { groesse = fs.statSync(s.transcript).size; } catch { s.transcript = null; return; }
  if (groesse < s.gelesen_bis) s.gelesen_bis = 0;
  const fd = fs.openSync(s.transcript, 'r');
  try {
    while (s.gelesen_bis < groesse) {
      const puffer = Buffer.alloc(Math.min(STUECK, groesse - s.gelesen_bis));
      const n = fs.readSync(fd, puffer, 0, puffer.length, s.gelesen_bis);
      const letzte = puffer.subarray(0, n).lastIndexOf(0x0a);
      if (letzte < 0) {
        // Eine Zeile laenger als ein Stueck kann keine Anmeldung sein: ueberspringen; sonst unvollstaendig, naechster Takt.
        if (n === STUECK) { s.gelesen_bis += n; continue; }
        break;
      }
      for (const z of puffer.subarray(0, letzte).toString('utf8').split('\n')) {
        const a = ausweisAusZeile(z);
        if (a) s.ausweis = a;
      }
      s.gelesen_bis += letzte + 1;
    }
  } finally { fs.closeSync(fd); }
}

/** P22-T144: offene Quittungen aus der API-Antwort (nur Anzeige im Status). */
function leseOffeneQuittungen(v: unknown): Sitzung['offene_quittungen'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as { anzahl?: unknown; aelteste_s?: unknown };
  return typeof o.anzahl === 'number' ? { anzahl: o.anzahl, aelteste_s: typeof o.aelteste_s === 'number' ? o.aelteste_s : null } : null;
}

/** Ein Takt: Ausweise nachlesen und die lebenden Sitzungen der API melden. Transportfehler: alter Stand bleibt. */
export async function modInboxTakt(): Promise<void> {
  const jetzt = Date.now();
  raeumeAuf(jetzt);
  const liste: Array<{ sitzung: string; ausweis: string }> = [];
  for (const s of sitzungen.values()) {
    try { leseAusweis(s); } catch (err) { s.aktiv = false; s.grund = 'transcript_fehler'; letzterFehler = (err as Error).message.slice(0, 300); continue; }
    if (s.ausweis) liste.push({ sitzung: s.id, ausweis: s.ausweis });
    else { s.aktiv = false; s.grund = s.transcript ? 'kein_ausweis' : 'transcript_fehlt'; }
  }
  if (liste.length === 0) return;
  try {
    const r = await anfrage<{ sitzungen?: Array<{ sitzung?: unknown; aktiv?: unknown; identity_id?: unknown; grund?: unknown; offene_quittungen?: unknown }> }>(
      '/api/daemon/mod-inbox', { method: 'POST', body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, sitzungen: liste } }, 30_000);
    for (const e of r.sitzungen ?? []) {
      const s = typeof e.sitzung === 'string' ? sitzungen.get(e.sitzung) : undefined;
      if (!s) continue;
      s.aktiv = e.aktiv === true;
      s.identity_id = typeof e.identity_id === 'string' ? e.identity_id : null;
      s.grund = typeof e.grund === 'string' ? e.grund : null;
      s.offene_quittungen = leseOffeneQuittungen(e.offene_quittungen);
    }
    letzteMeldung = new Date().toISOString();
    letzterFehler = null;
  } catch (err) {
    letzterFehler = (err as Error).message.slice(0, 300);
    console.error('[mod-inbox] Meldung an die API fehlgeschlagen:', letzterFehler);
  }
}

let taktLaeuft = false;
async function takt(): Promise<void> {
  if (taktLaeuft) return;
  taktLaeuft = true;
  try { await modInboxTakt(); }
  catch (err) { console.error('[mod-inbox] Takt fehlgeschlagen:', (err as Error).message); }
  finally { taktLaeuft = false; }
}

export interface ModInboxHandle { stop(): void }

export function startModInbox(): ModInboxHandle {
  const timer = setInterval(() => { void takt(); }, TAKT_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function nurLokal(req: FastifyRequest, reply: FastifyReply): boolean {
  if (istLoopback(req.ip) && req.headers.origin === undefined) return true;
  reply.code(403).send({ success: false, error: 'nur_lokal' });
  return false;
}

export function registriereModInbox(app: FastifyInstance): void {
  app.get<{ Querystring: { sitzung?: string } }>('/mod-inbox/warte', async (req, reply) => {
    if (!nurLokal(req, reply)) return reply;
    const id = String(req.query.sitzung ?? '');
    if (!SITZUNG_ID.test(id)) return reply.code(400).send({ success: false, error: 'sitzung_ungueltig' });
    const neu = !sitzungen.has(id);
    const w = warte(id);
    // Bricht die Mod den Abruf ab (Sitzung beendet, Neuladen), bleibt eine noch nicht gelieferte Nachricht in der Schlange.
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) w.abbrechen(); });
    if (neu) void takt();
    const nachricht = await w.ergebnis;
    const s = sitzungen.get(id);
    return { success: true, nachricht, aktiv: s?.aktiv ?? false, grund: s?.grund ?? null };
  });

  app.post<{ Body: { sitzung?: unknown; id?: unknown; gestartet?: unknown; grund?: unknown } }>('/mod-inbox/quittung', async (req, reply) => {
    if (!nurLokal(req, reply)) return reply;
    const b = req.body ?? {};
    if (typeof b.sitzung !== 'string' || typeof b.id !== 'string') return reply.code(400).send({ success: false, error: 'quittung_ungueltig' });
    const bekannt = quittiere(b.sitzung, b.id, b.gestartet === true, typeof b.grund === 'string' ? b.grund : null);
    return { success: true, bekannt };
  });

  app.get('/mod-inbox/status', async (req, reply) => {
    if (!nurLokal(req, reply)) return reply;
    const jetzt = Date.now();
    return {
      success: true,
      sitzungen: [...sitzungen.values()].map((s) => ({ sitzung: s.id, aktiv: s.aktiv, grund: s.grund, identity_id: s.identity_id,
        ausweis_bekannt: s.ausweis !== null, wartet: s.warter !== null, schlange: s.schlange.length, zuletzt_vor_s: Math.round((jetzt - s.zuletzt) / 1000),
        offene_quittungen: s.offene_quittungen })),
      uebergaben: [...uebergaben].map(([id, u]) => ({ id, sitzung: u.sitzung, stand: u.stand, grund: u.grund, vor_s: Math.round((jetzt - u.am) / 1000) })),
      abweisungen,
      letzte_meldung: letzteMeldung,
      letzter_fehler: letzterFehler,
    };
  });
}
