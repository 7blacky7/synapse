/**
 * MODUL: api-weiterleitung.ts (P9-T28)
 * ZWECK: Lokale Weiterleitung http://127.0.0.1:<port>/... zur Synapse-API, damit
 *        Claude Code, Codex und andere MCP-Clients im LAN den schnellen Weg nehmen
 *        und ohne LAN automatisch den Tunnel.
 *
 * ADRESSKETTE: dieselbe Reihenfolge wie apiBases() im Tray (tray/api_client.go) und
 * loadApiConfig() in scripts/synapse-api.mjs (Commit 39f782df):
 *   1. SYNAPSE_API_URL (Umgebung)
 *   2. synapse_api_url aus ~/.synapse/file-watcher/config.json (im LAN die LAN-Adresse)
 *   3. https://synapse.moosynapse.org (Tunnel)
 *   4. SYNAPSE_API_FALLBACK_URL bzw. synapse_api_fallback_url, sonst http://192.168.50.65:3456
 * Wie im Tray wird die zuletzt erfolgreiche Basis zuerst probiert. Zusaetzlich prueft ein
 * Zeitgeber die bevorzugten Adressen (GET /health) und schaltet zurueck, sobald eine
 * hoeher stehende wieder antwortet. Laufende Anfragen behalten ihre Basis (kein Abbruch).
 *
 * TRANSPORT, KEINE ZWEITE WAHRHEIT: alle Basen zeigen auf dieselbe API. Reiner HTTP-Proxy,
 * kein DB-Zugriff, keine eigenen Tokens: der Authorization-Header des Clients geht
 * unveraendert durch. Bodies werden nie geloggt.
 *
 * RUECKFALL nur bei Transportfehlern, bevor eine Verbindung stand (Verbindung abgelehnt,
 * DNS, Netz unerreichbar, Verbindungs-Timeout). Antwortet eine Basis (auch 4xx/5xx), geht
 * die Antwort an den Client — ein tools/call wird nie doppelt ausgefuehrt.
 *
 * OAUTH/DISCOVERY: Die API bildet Issuer, resource und resource_metadata aus dem Host, den
 * sie sieht (Tunnel- bzw. LAN-Adresse). Damit ein Client mit der Server-URL
 * http://127.0.0.1:<port>/ die Anmeldung findet, ersetzt die Weiterleitung in
 * WWW-Authenticate-, Location- und Link-Headern sowie in JSON-Antworten unter /.well-known/
 * die Upstream-Herkunft durch die lokale. Alles andere (auch SSE) wird unveraendert
 * gestreamt.
 *
 * SCHUTZ: bindet nur an 127.0.0.1, lehnt Nicht-Loopback-Absender ab und Browser-Anfragen
 * mit jedem Origin-Header (kein Browser-Zugriff).
 */

import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { istLoopback } from './skills-proxy.js';

import { apiBasenAusConfig, normalisiereBasis, gueltigeBasis } from './api-adressen.js';
export { apiBasenAusConfig, normalisiereBasis, API_TUNNEL_STANDARD, API_LAN_STANDARD } from './api-adressen.js';
export const WEITERLEITUNG_STANDARD_PORT = 7879;
export const WEITERLEITUNG_STATUS_PFAD = '/__synapse-weiterleitung/status';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
]);
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'EADDRNOTAVAIL', 'ECONNRESET', 'EPIPE', 'VERBINDUNG_TIMEOUT',
]);

export type AdressArt = 'lokal' | 'lan' | 'tunnel';

/** Port der Weiterleitung: SYNAPSE_API_WEITERLEITUNG_PORT, sonst config.json api_weiterleitung_port, sonst 7879. 0 = aus. */
export function weiterleitungsPortAusConfig(env: NodeJS.ProcessEnv = process.env): number {
  const roh = env.SYNAPSE_API_WEITERLEITUNG_PORT;
  if (roh !== undefined && roh.trim() !== '') {
    const n = Number(roh);
    return Number.isInteger(n) && n >= 0 && n < 65536 ? n : WEITERLEITUNG_STANDARD_PORT;
  }
  try {
    const p = loadConfig().api_weiterleitung_port;
    if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < 65536) return p;
  } catch { /* Standard */ }
  return WEITERLEITUNG_STANDARD_PORT;
}

/** P9-T28/1a: nur FREIE Sockets begrenzen, niemals laufende SSE/Tool-Aufrufe.
 * Standard 1s liegt mit Abstand unter dem ueblichen Node-Server-Keep-Alive von 5s.
 * Bei kuerzerem Upstream-Timeout muss der Betreiber die Frist entsprechend senken.
 */
export function weiterleitungsIdleMsAusConfig(o: {
  env?: NodeJS.ProcessEnv;
  cfg?: { api_weiterleitung_idle_ms?: unknown };
} = {}): number {
  const gueltig = (v: unknown): number | null => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (typeof v === 'string' && !v.trim()) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
  };
  const env = o.env ?? process.env;
  const ausEnv = gueltig(env.SYNAPSE_API_WEITERLEITUNG_IDLE_MS);
  if (ausEnv !== null) return ausEnv;
  let cfg = o.cfg;
  if (!cfg) { try { cfg = { api_weiterleitung_idle_ms: loadConfig().api_weiterleitung_idle_ms }; } catch { cfg = {}; } }
  return gueltig(cfg.api_weiterleitung_idle_ms) ?? 1_000;
}

/** lokal (Loopback), lan (private Adresse, .local/.lan) oder tunnel (alles andere). */
export function artDerAdresse(basis: string): AdressArt {
  let host: string;
  try { host = new URL(basis).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return 'tunnel'; }
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'lokal';
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'lan';
  if (/^(fd|fc)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return 'lan';
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.')) return 'lan';
  return 'tunnel';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ersetzt http(s)://<upstream-host>[:port] durch die lokale Herkunft. */
export function ersetzeUpstreamHerkunft(text: string, basis: string, lokal: string): string {
  let host: string;
  try { host = new URL(basis).hostname; } catch { return text; }
  const re = new RegExp(`https?://${escapeRegex(host)}(?::\\d+)?(?![\\w.-])`, 'gi');
  return text.replace(re, lokal);
}

export interface WeiterleitungOptionen {
  /** Port, 0 = freier Port (Tests). Standard: weiterleitungsPortAusConfig(). */
  port?: number;
  host?: string;
  /** Liefert die Adresskette; Standard apiBasenAusConfig() (liest config.json bei jeder Anfrage). */
  basen?: () => string[];
  pruefIntervallMs?: number;
  verbindungsTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Freie Upstream-Sockets vor dem Server schliessen; Standard aus Env/config. */
  idleSocketTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface AdressStand {
  url: string;
  art: AdressArt;
  erreichbar: boolean | null;
  letzter_fehler: string | null;
  letzte_pruefung: string | null;
}

interface Wechsel { zeit: string; von: string | null; nach: string; grund: string }

class TransportFehler extends Error {
  constructor(message: string, readonly code: string, readonly verbunden: boolean) { super(message); }
}

export class ApiWeiterleitung {
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private aktiv: string | null = null;
  private readonly stand = new Map<string, AdressStand>();
  private readonly wechsel: Wechsel[] = [];
  private laufend = 0;
  private port = 0;
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  private readonly idleObserved = new WeakSet<Socket>();
  private readonly idleTimers = new Map<Socket, NodeJS.Timeout>();
  private readonly idleSocketTimeoutMs: number;

  constructor(private readonly o: WeiterleitungOptionen = {}) {
    this.idleSocketTimeoutMs = o.idleSocketTimeoutMs ?? weiterleitungsIdleMsAusConfig();
    if (!Number.isInteger(this.idleSocketTimeoutMs) || this.idleSocketTimeoutMs <= 0 || this.idleSocketTimeoutMs > 2_147_483_647) {
      throw new TypeError('Idle-Frist muss eine positive Millisekunden-Zahl sein.');
    }
    for (const agent of [this.httpAgent, this.httpsAgent]) {
      agent.on('free', (socket: Socket) => {
        this.beendeIdleTimer(socket);
        // Der interne Agent-Listener kann einen wartenden Request sofort bedienen.
        // Dann ist der Socket bereits aktiv und darf keine Idle-Frist erhalten.
        if (!Object.values(agent.freeSockets).some((sockets) => sockets?.includes(socket))) return;
        const timer = setTimeout(() => {
          this.idleTimers.delete(socket);
          socket.destroy();
        }, this.idleSocketTimeoutMs);
        timer.unref();
        this.idleTimers.set(socket, timer);
        if (!this.idleObserved.has(socket)) {
          this.idleObserved.add(socket);
          socket.once('close', () => this.beendeIdleTimer(socket));
        }
      });
    }
  }

  private beendeIdleTimer(socket: Socket): void {
    const timer = this.idleTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(socket);
  }

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.error(m)))(`[api-weiterleitung] ${msg}`);
  }

  /** Konfigurierte Kette ohne Adressen, die auf die Weiterleitung selbst zeigen (Schleifenschutz). */
  basen(): string[] {
    const roh = this.o.basen ? this.o.basen() : apiBasenAusConfig();
    return roh.map(normalisiereBasis).filter((b) => {
      if (!b || !gueltigeBasis(b)) return false;
      if (!this.port) return true;
      try {
        const u = new URL(b);
        return !(artDerAdresse(b) === 'lokal' && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === this.port);
      } catch { return false; }
    });
  }

  /** Reihenfolge fuer eine Anfrage: aktive Basis zuerst, dann die Kette. */
  private reihenfolge(): string[] {
    const kette = this.basen();
    if (this.aktiv && kette.includes(this.aktiv)) return [this.aktiv, ...kette.filter((b) => b !== this.aktiv)];
    return kette;
  }

  private standFuer(url: string): AdressStand {
    let s = this.stand.get(url);
    if (!s) {
      s = { url, art: artDerAdresse(url), erreichbar: null, letzter_fehler: null, letzte_pruefung: null };
      this.stand.set(url, s);
    }
    return s;
  }

  private setzeAktiv(nach: string, grund: string): void {
    if (this.aktiv === nach) return;
    const von = this.aktiv;
    this.aktiv = nach;
    this.wechsel.push({ zeit: new Date().toISOString(), von, nach, grund });
    if (this.wechsel.length > 20) this.wechsel.shift();
    this.log(`Weg: ${von ?? '-'} -> ${nach} (${artDerAdresse(nach)}, ${grund})`);
  }

  private markiere(url: string, ok: boolean, fehler: string | null): void {
    const s = this.standFuer(url);
    s.erreichbar = ok;
    s.letzter_fehler = ok ? null : fehler;
    s.letzte_pruefung = new Date().toISOString();
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    if (this.o.host !== undefined && this.o.host !== '127.0.0.1') {
      throw new TypeError('API-Weiterleitung darf nur an 127.0.0.1 binden.');
    }
    const wunsch = this.o.port ?? weiterleitungsPortAusConfig();
    const server = http.createServer((req, res) => { void this.behandle(req, res); });
    // Lange Tool-Aufrufe, Long-Polls (50 s) und SSE duerfen nicht am Server-Timeout sterben.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(wunsch, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    await this.pruefe().catch(() => undefined);
    const intervall = this.o.pruefIntervallMs ?? 30_000;
    if (intervall > 0) {
      this.timer = setInterval(() => { void this.pruefe().catch(() => undefined); }, intervall);
      this.timer.unref();
    }
    this.log(`lauscht auf http://127.0.0.1:${this.port} (aktiv: ${this.aktiv ?? 'noch keiner'})`);
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.server;
    this.server = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /**
   * Prueft die Kette per GET /health. Erste antwortende Adresse in Ketten-Reihenfolge wird aktiv
   * — damit kehrt der Weg zum LAN zurueck, sobald es wieder da ist. Laufende Anfragen bleiben.
   */
  async pruefe(): Promise<string | null> {
    for (const basis of this.basen()) {
      if (await this.health(basis)) {
        this.setzeAktiv(basis, this.aktiv ? 'Pruefung: bevorzugte Adresse erreichbar' : 'Start');
        return basis;
      }
    }
    return null;
  }

  private async health(basis: string): Promise<boolean> {
    try {
      const res = await fetch(`${basis}/health`, {
        signal: AbortSignal.timeout(this.o.verbindungsTimeoutMs ?? 3_000),
        redirect: 'manual',
      });
      await res.arrayBuffer().catch(() => undefined);
      const ok = res.status >= 200 && res.status < 300;
      this.markiere(basis, ok, ok ? null : `HTTP ${res.status}`);
      return ok;
    } catch (err) {
      this.markiere(basis, false, (err as Error).name === 'TimeoutError' ? 'Timeout' : String((err as Error).message).slice(0, 200));
      return false;
    }
  }

  status(): Record<string, unknown> {
    const kette = this.basen();
    return {
      success: true,
      port: this.port,
      lauscht: this.server !== null,
      aktiv: this.aktiv ? { url: this.aktiv, art: artDerAdresse(this.aktiv) } : null,
      adressen: kette.map((u) => ({ ...this.standFuer(u) })),
      laufende_anfragen: this.laufend,
      wechsel: [...this.wechsel],
      pruef_intervall_ms: this.o.pruefIntervallMs ?? 30_000,
    };
  }

  /** Herkunft, unter der der Client die Weiterleitung anspricht (fuer Discovery-Umschreibung). */
  private lokaleHerkunft(req: http.IncomingMessage): string {
    const host = String(req.headers.host ?? '');
    if (/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i.test(host)) return `http://${host}`;
    return `http://127.0.0.1:${this.port}`;
  }

  private async behandle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const json = (code: number, body: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!istLoopback(req.socket.remoteAddress)) {
      json(403, { success: false, error: 'nur_lokal', message: 'Nur von 127.0.0.1 erlaubt.' });
      return;
    }
    const lokal = this.lokaleHerkunft(req);
    const origin = req.headers.origin;
    if (origin !== undefined) {
      json(403, { success: false, error: 'browser_abgelehnt', message: 'Browser-Origin ist nicht erlaubt.' });
      return;
    }
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === WEITERLEITUNG_STATUS_PFAD) {
      json(200, this.status());
      return;
    }

    let body: Buffer;
    try {
      body = await this.sammle(req);
    } catch (err) {
      json((err as Error).message === 'zu_gross' ? 413 : 400, { success: false, error: (err as Error).message === 'zu_gross' ? 'body_zu_gross' : 'body_fehler' });
      return;
    }

    this.laufend++;
    res.once('close', () => { this.laufend--; });
    const versuche: string[] = [];
    for (const basis of this.reihenfolge()) {
      if (res.destroyed) return;
      try {
        const { upReq, upRes } = await this.sende(basis, req, body);
        this.markiere(basis, true, null);
        if (basis !== this.aktiv) this.setzeAktiv(basis, versuche.length ? 'Rueckfall nach Transportfehler' : 'erste erfolgreiche Anfrage');
        this.antworte(basis, lokal, req, res, upReq, upRes);
        return;
      } catch (err) {
        const e = err as TransportFehler;
        versuche.push(`${basis}: ${e.code ?? 'fehler'}`);
        if (e.verbunden) {
          // Verbindung stand schon: Anfrage koennte angekommen sein -> kein Rueckfall (keine Doppelausfuehrung).
          json(502, { success: false, error: 'api_verbindung_abgebrochen', message: `Synapse-API (${basis}) hat die Verbindung abgebrochen: ${e.code}` });
          return;
        }
        this.markiere(basis, false, e.code ?? e.message);
        if (this.aktiv === basis) this.log(`${basis} nicht erreichbar (${e.code}), versuche naechste Adresse`);
      }
    }
    json(502, { success: false, error: 'api_nicht_erreichbar', message: 'Keine Synapse-API-Adresse erreichbar.', versuche });
  }

  private sammle(req: http.IncomingMessage): Promise<Buffer> {
    const max = this.o.maxBodyBytes ?? 64 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const teile: Buffer[] = [];
      let laenge = 0;
      req.on('data', (c: Buffer) => {
        laenge += c.length;
        if (laenge > max) { reject(new Error('zu_gross')); req.destroy(); return; }
        teile.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(teile)));
      req.on('error', reject);
    });
  }

  /** Schickt die Anfrage an eine Basis; loest mit den Antwort-Headern auf. */
  private sende(basis: string, req: http.IncomingMessage, body: Buffer, frisch = false): Promise<{ upReq: http.ClientRequest; upRes: http.IncomingMessage }> {
    const ziel = new URL(basis);
    const istHttps = ziel.protocol === 'https:';
    const pfad = ziel.pathname.replace(/\/+$/, '') + (req.url ?? '/');
    const headers: http.OutgoingHttpHeaders = {};
    const connectionHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()));
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || connectionHeaders.has(k) || k === 'host' || k === 'content-length') continue;
      headers[k] = v;
    }
    headers.host = ziel.host;
    if (body.length > 0 || req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined) {
      headers['content-length'] = String(body.length);
    }
    // Discovery-Antworten werden umgeschrieben -> unkomprimiert anfordern.
    if ((req.url ?? '').startsWith('/.well-known/')) headers['accept-encoding'] = 'identity';

    const timeoutMs = this.o.verbindungsTimeoutMs ?? 3_000;
    return new Promise((resolve, reject) => {
      let verbunden = false;
      let fertig = false;
      const upReq = (istHttps ? https : http).request({
        protocol: ziel.protocol,
        hostname: ziel.hostname.replace(/^\[|\]$/g, ''),
        port: ziel.port || (istHttps ? 443 : 80),
        method: req.method,
        path: pfad,
        headers,
        agent: frisch ? false : (istHttps ? this.httpsAgent : this.httpAgent),
        servername: istHttps ? ziel.hostname : undefined,
      });
      upReq.on('socket', (sock) => {
        this.beendeIdleTimer(sock);
        if (upReq.reusedSocket || !(sock as unknown as { connecting?: boolean }).connecting) { verbunden = true; return; }
        const t = setTimeout(() => upReq.destroy(Object.assign(new Error('Verbindungs-Timeout'), { code: 'VERBINDUNG_TIMEOUT' })), timeoutMs);
        sock.once(istHttps ? 'secureConnect' : 'connect', () => { verbunden = true; clearTimeout(t); });
        sock.once('close', () => clearTimeout(t));
      });
      upReq.once('response', (upRes) => { fertig = true; resolve({ upReq, upRes }); });
      upReq.once('error', (err: NodeJS.ErrnoException) => {
        if (fertig) return;
        fertig = true;
        const code = err.code ?? 'FEHLER';
        // Genau ein frischer Versuch an dieselbe Basis, nur fuer sichere Methoden.
        // Schreibende Methoden bleiben auch bei reusedSocket-Reset ohne Wiederholung.
        if (upReq.reusedSocket && code === 'ECONNRESET' && !frisch &&
            ['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) {
          this.sende(basis, req, body, true).then(resolve, reject);
          return;
        }
        const transport = TRANSPORT_CODES.has(code) || /certificate|SSL|TLS/i.test(err.message);
        reject(new TransportFehler(err.message, code, verbunden || !transport));
      });
      upReq.end(body.length > 0 ? body : undefined);
    });
  }

  private antworte(basis: string, lokal: string, req: http.IncomingMessage, res: http.ServerResponse, upReq: http.ClientRequest, upRes: http.IncomingMessage): void {
    const headers: http.OutgoingHttpHeaders = {};
    const connectionHeaders = new Set(String(upRes.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim()));
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || connectionHeaders.has(k)) continue;
      if (k === 'www-authenticate' || k === 'location' || k === 'link') {
        (headers as Record<string, string | string[]>)[k] = Array.isArray(v) ? v.map((x) => ersetzeUpstreamHerkunft(x, basis, lokal)) : ersetzeUpstreamHerkunft(v, basis, lokal);
      } else {
        headers[k] = v;
      }
    }
    // Client weg -> Upstream abbrechen (SSE, lange Aufrufe).
    res.once('close', () => { if (!res.writableFinished) upReq.destroy(); });
    upRes.once('error', () => res.destroy());

    const ct = String(upRes.headers['content-type'] ?? '');
    const umschreiben = (req.url ?? '').startsWith('/.well-known/') && /json/i.test(ct) && !upRes.headers['content-encoding'];
    if (umschreiben) {
      const teile: Buffer[] = [];
      upRes.on('data', (c: Buffer) => teile.push(c));
      upRes.on('end', () => {
        const text = ersetzeUpstreamHerkunft(Buffer.concat(teile).toString('utf8'), basis, lokal);
        headers['content-length'] = String(Buffer.byteLength(text));
        res.writeHead(upRes.statusCode ?? 502, headers);
        res.end(text);
      });
      return;
    }
    res.writeHead(upRes.statusCode ?? 502, headers);
    res.flushHeaders();
    upRes.pipe(res);
  }
}
