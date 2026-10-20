/**
 * P22-T75 B3: Token-Stand eines Codex-Threads aus der Rollout-Datei der CLI ($CODEX_HOME/sessions/JJJJ/MM/TT/rollout-<zeit>-<thread>.jsonl).
 * `codex exec --json` meldet in turn.completed nur total_token_usage: die Summe ALLER Anfragen des Threads (jede Werkzeugrunde zaehlt ihren
 * ganzen Kontext erneut, jeder Resume-Turn bleibt in der Summe). Als Kontextstand ergab das '156 % von 272k' bzw. wechselnde Werte.
 * Der echte Kontext ist die LETZTE Anfrage: das token_count-Ereignis der Rollout-Datei traegt neben total_token_usage auch
 * last_token_usage (Eingabe inkl. Cache + Ausgabe der letzten Anfrage) und model_context_window. Abrechnung = Zuwachs der Summe je Turn.
 */
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CodexNutzung { input: number; cached: number; output: number }
export interface CodexTokenInfo { gesamt: CodexNutzung; letzte: CodexNutzung; fenster: number | null }
export interface ClaudeUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const zahl = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.round(x) : 0);

function nutzung(u: unknown): CodexNutzung | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  return { input: zahl(o.input_tokens), cached: zahl(o.cached_input_tokens), output: zahl(o.output_tokens) };
}

/** Letztes token_count mit Angaben aus Zeilen einer Rollout-Datei (rein). */
export function letzteTokenInfoAus(zeilen: readonly string[]): CodexTokenInfo | null {
  for (let i = zeilen.length - 1; i >= 0; i--) {
    const z = zeilen[i];
    if (!z || !z.includes('token_count')) continue;
    try {
      const obj = JSON.parse(z) as { payload?: Record<string, unknown> } & Record<string, unknown>;
      const p = (obj.payload ?? obj) as { type?: unknown; info?: Record<string, unknown> | null };
      if (p.type !== 'token_count' || !p.info) continue;
      const gesamt = nutzung(p.info.total_token_usage);
      const letzte = nutzung(p.info.last_token_usage);
      if (gesamt && letzte) return { gesamt, letzte, fenster: zahl(p.info.model_context_window) || null };
    } catch { /* keine JSON-Zeile */ }
  }
  return null;
}

/** Claude-Form (input OHNE Cache, Cache getrennt) - Codex zaehlt cached_input_tokens bereits in input_tokens. */
export function alsClaudeUsage(n: CodexNutzung): ClaudeUsage {
  return { input_tokens: Math.max(0, n.input - n.cached), output_tokens: n.output, cache_read_input_tokens: n.cached, cache_creation_input_tokens: 0 };
}

/**
 * Zeilen-Usage eines Turns: abrechnung = Zuwachs der Thread-Summe seit dem letzten Turn (alle Anfragen des Turns, einmal gebucht),
 * kontext = die letzte Anfrage (Eingabe + deren Ausgabe = Kontext des naechsten Turns).
 */
export function turnNutzung(info: CodexTokenInfo, vorher: CodexNutzung | null): { abrechnung: ClaudeUsage; kontext: ClaudeUsage } {
  const v = vorher ?? { input: 0, cached: 0, output: 0 };
  const delta: CodexNutzung = {
    input: Math.max(0, info.gesamt.input - v.input), cached: Math.max(0, info.gesamt.cached - v.cached), output: Math.max(0, info.gesamt.output - v.output),
  };
  return { abrechnung: alsClaudeUsage(delta), kontext: alsClaudeUsage(info.letzte) };
}

const pfade = new Map<string, string>();
const absteigend = (namen: string[]): string[] => namen.filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a));

async function findeRolloutDatei(threadId: string, home: string): Promise<string | null> {
  const schluessel = home + '\0' + threadId;
  const bekannt = pfade.get(schluessel);
  if (bekannt) return bekannt;
  const wurzel = join(home, 'sessions');
  try {
    for (const jahr of absteigend(await readdir(wurzel))) {
      for (const monat of absteigend(await readdir(join(wurzel, jahr)))) {
        for (const tag of absteigend(await readdir(join(wurzel, jahr, monat)))) {
          const treffer = (await readdir(join(wurzel, jahr, monat, tag))).find((n) => n.endsWith('-' + threadId + '.jsonl'));
          if (treffer) { const pfad = join(wurzel, jahr, monat, tag, treffer); pfade.set(schluessel, pfad); return pfad; }
        }
      }
    }
  } catch { /* kein sessions-Verzeichnis */ }
  return null;
}

const ENDE_BYTES = 512 * 1024;

/** Letzter Token-Stand des Threads (liest nur das Ende der Datei). null: Datei oder Ereignis nicht vorhanden. */
export async function leseCodexTokenInfo(threadId: string, home: string = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<CodexTokenInfo | null> {
  const pfad = await findeRolloutDatei(threadId, home);
  if (!pfad) return null;
  const datei = await open(pfad, 'r');
  try {
    const { size } = await datei.stat();
    const start = Math.max(0, size - ENDE_BYTES);
    const puffer = Buffer.alloc(size - start);
    await datei.read(puffer, 0, puffer.length, start);
    const zeilen = puffer.toString('utf8').split('\n');
    if (start > 0) zeilen.shift(); // angeschnittene erste Zeile
    return letzteTokenInfoAus(zeilen);
  } finally {
    await datei.close();
  }
}
