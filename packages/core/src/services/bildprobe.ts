/**
 * P13-T14: flüchtige Bildprobe für MCP-Oberflächen, keine DB/Dateipersistenz.
 * Das Sollwort existiert nur während des Renderns; gespeichert wird sein Digest.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const BILDPROBE_PARAMETER = {
  modus: { type: 'string', enum: ['inline', 'link'], description: 'Bildprobe: echtes Inline-PNG oder öffentlicher Einmal-Link (Standard inline)' },
  probe_id: { type: 'string', description: 'Bildprobe prüfen: Kennung aus dem vorherigen Aufruf' },
  wort: { type: 'string', description: 'Bildprobe prüfen: nur das im Bild gelesene Codewort; wird nicht protokolliert' },
};

export interface BildprobeKonfiguration {
  basisUrl: string;
  ttlMs: number;
  width: number;
  height: number;
  maxProben: number;
}
export function ladeBildprobeKonfiguration(env: NodeJS.ProcessEnv = process.env): BildprobeKonfiguration {
  const zahl = (name: string, fallback: number, min: number, max: number) => {
    if (env[name] === undefined) return fallback;
    const n = Number(env[name]);
    if (!Number.isInteger(n) || n < min || n > max) throw Error('bildprobe_konfiguration_ungueltig');
    return n;
  };
  const basisUrl = env.SYNAPSE_BILDPROBE_BASE_URL ?? env.SYNAPSE_PUBLIC_URL ?? env.SYNAPSE_API_URL ?? 'http://localhost:3456';
  let url: URL;
  try { url = new URL(basisUrl); } catch { throw Error('bildprobe_basisadresse_ungueltig'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error('bildprobe_basisadresse_ungueltig');
  }
  return {
    basisUrl: basisUrl.replace(/\/+$/, ''),
    ttlMs: zahl('SYNAPSE_BILDPROBE_TTL_MS', 600_000, 1, 86_400_000),
    width: zahl('SYNAPSE_BILDPROBE_WIDTH', 480, 96, 2048),
    height: zahl('SYNAPSE_BILDPROBE_HEIGHT', 160, 32, 2048),
    maxProben: zahl('SYNAPSE_BILDPROBE_MAX_PROBEN', 128, 1, 10_000),
  };
}

// Fünf Spalten, sieben Zeilen; jedes Byte beschreibt eine Zeile, Bit4 links.
const SCHRIFT: Record<string, number[]> = {
  A:[14,17,17,31,17,17,17], B:[30,17,17,30,17,17,30],
  C:[14,17,16,16,16,17,14], D:[30,17,17,17,17,17,30],
  E:[31,16,16,30,16,16,31], F:[31,16,16,30,16,16,16],
  G:[14,17,16,23,17,17,15], H:[17,17,17,31,17,17,17],
  I:[31,4,4,4,4,4,31], J:[7,2,2,2,18,18,12],
  K:[17,18,20,24,20,18,17], L:[16,16,16,16,16,16,31],
  M:[17,27,21,21,17,17,17], N:[17,25,21,19,17,17,17],
  O:[14,17,17,17,17,17,14], P:[30,17,17,30,16,16,16],
  Q:[14,17,17,17,21,18,13], R:[30,17,17,30,20,18,17],
  S:[15,16,16,14,1,1,30], T:[31,4,4,4,4,4,4],
  U:[17,17,17,17,17,17,14], V:[17,17,17,17,17,10,4],
  W:[17,17,17,21,21,21,10], X:[17,17,10,4,10,17,17],
  Y:[17,17,10,4,4,4,4], Z:[31,1,2,4,8,16,31],
  '0':[14,17,19,21,25,17,14], '1':[4,12,4,4,4,4,14],
  '2':[14,17,1,2,4,8,31], '3':[30,1,1,14,1,1,30],
  '4':[2,6,10,18,31,2,2], '5':[31,16,16,30,1,1,30],
  '6':[14,16,16,30,17,17,14], '7':[31,1,2,4,8,8,8],
  '8':[14,17,17,14,17,17,14], '9':[14,17,17,15,1,1,14],
  '-':[0,0,0,31,0,0,0],
};
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii'), head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([head, type, data, tail]);
}
export function renderBildprobePng(wort: string, width: number, height: number): Buffer {
  if (!/^[A-Z0-9-]{1,16}$/.test(wort) || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 96 || height < 32 || width > 2048 || height > 2048) throw Error('bildprobe_bildparameter_ungueltig');
  const cols = wort.length * 6 - 1;
  const scale = Math.min(Math.floor((width - 16) / cols), Math.floor((height - 16) / 7));
  if (scale < 1) throw Error('bildprobe_bild_zu_klein');
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * stride + 1 + x * 3;
    raw[at] = 13; raw[at + 1] = 17; raw[at + 2] = 23;
  }
  const left = Math.floor((width - cols * scale) / 2), top = Math.floor((height - 7 * scale) / 2);
  [...wort].forEach((char, i) => {
    SCHRIFT[char].forEach((row, y) => {
      for (let x = 0; x < 5; x++) if (row & (1 << (4 - x))) {
        for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
          const at = (top + y * scale + yy) * stride + 1 + (left + (i * 6 + x) * scale + xx) * 3;
          raw[at] = 230; raw[at + 1] = 237; raw[at + 2] = 243;
        }
      }
    });
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
type Abruf = { zeit: string; ip: string; user_agent: string; status: number };
type Probe = { digest: Buffer; png?: Buffer; token?: string; ablauf: number; verwendet: boolean; abrufe: Abruf[] };
export type BildprobeErgebnis = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: 'image/png'; data: string }>;
  structuredContent: Record<string, unknown>;
};
function antwort(payload: Record<string, unknown>, png?: Buffer): BildprobeErgebnis {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) },
      ...(png ? [{ type: 'image' as const, mimeType: 'image/png' as const, data: png.toString('base64') }] : [])],
    structuredContent: payload,
  };
}
const digest = (value: string) => createHash('sha256').update(value).digest();
export class BildprobeDienst {
  private readonly proben = new Map<string, Probe>();
  private readonly tokens = new Map<string, string>();
  private readonly jetzt: () => number;
  private readonly wort: () => string;
  private readonly kennung: string;
  constructor(private readonly config: BildprobeKonfiguration = ladeBildprobeKonfiguration(),
    optionen: { jetzt?: () => number; wort?: () => string; kennung?: 'api' | 'lokal' } = {}) {
    this.jetzt = optionen.jetzt ?? Date.now;
    this.wort = optionen.wort ?? (() => {
      const woerter = ['FALKE','WOLKE','MOND','KIEFER','LUMEN','EICHE'];
      return woerter[randomInt(woerter.length)] + '-' + randomInt(10_000).toString().padStart(4, '0');
    });
    this.kennung = optionen.kennung ?? 'lokal';
  }
  private bereinigen(): void {
    const now = this.jetzt();
    // Ablauf blockiert sofort; Metadaten bleiben ein weiteres TTL-Fenster zur Auswertung.
    for (const [id, p] of this.proben) {
      if (now >= p.ablauf) p.png = undefined;
      if (now >= p.ablauf + this.config.ttlMs) {
        this.proben.delete(id);
        if (p.token) this.tokens.delete(p.token);
      }
    }
  }
  ausfuehren(args: Record<string, unknown>): BildprobeErgebnis {
    this.bereinigen();
    if (args.probe_id !== undefined || args.wort !== undefined) {
      if (typeof args.probe_id !== 'string' || typeof args.wort !== 'string' || args.wort.length > 256) {
        return antwort({ success: false, error: 'bildprobe_pruefparameter_ungueltig' });
      }
      const p = this.proben.get(args.probe_id);
      if (!p) return antwort({ success: false, error: 'bildprobe_unbekannt' });
      const abgelaufen = this.jetzt() >= p.ablauf;
      return antwort({ success: true, probe_id: args.probe_id,
        richtig: !abgelaufen && timingSafeEqual(p.digest, digest(args.wort.trim().toUpperCase())),
        abgelaufen, abrufanzahl: p.abrufe.length, abrufe: p.abrufe.map(x => ({ ...x })) });
    }
    const modus = args.modus ?? 'inline';
    if (modus !== 'inline' && modus !== 'link') return antwort({ success: false, error: 'bildprobe_modus_ungueltig' });
    if (this.proben.size >= this.config.maxProben) return antwort({ success: false, error: 'bildprobe_kapazitaet' });
    const wort = this.wort(), png = renderBildprobePng(wort, this.config.width, this.config.height);
    const probe_id = this.kennung + '.' + randomUUID(), ablauf = this.jetzt() + this.config.ttlMs;
    const token = modus === 'link' ? randomBytes(32).toString('hex') : undefined;
    this.proben.set(probe_id, { digest: digest(wort), png, token, ablauf, verwendet: false, abrufe: [] });
    if (token) this.tokens.set(token, probe_id);
    return antwort({ success: true, probe_id, modus, ablauf: new Date(ablauf).toISOString(),
      ...(token ? { link: this.config.basisUrl + '/api/bildprobe/' + token } : {}),
      hinweis: 'Lies das Codewort im Bild und prüfe es mit admin(action:bildprobe, probe_id, wort).' },
      modus === 'inline' ? png : undefined);
  }
  abrufen(token: string, details: { ip: string; userAgent: string }): { status: 200 | 410; png?: Buffer } {
    this.bereinigen();
    const id = this.tokens.get(token), p = id ? this.proben.get(id) : undefined;
    if (!p) return { status: 410 };
    const now = this.jetzt(), status = now < p.ablauf && !p.verwendet && p.png ? 200 : 410;
    p.abrufe.push({ zeit: new Date(now).toISOString(), ip: details.ip, user_agent: details.userAgent, status });
    if (status === 410) return { status };
    // Kein await zwischen Prüfung und Verbrauch: parallele Abrufe haben genau einen Gewinner.
    p.verwendet = true;
    const png = p.png;
    p.png = undefined;
    return { status: 200, png };
  }
}
