/**
 * P10-T90 ZWANGS-PIN (User 08.11.2026 ~15:15 Idee, ~15:20 Freigabe thought 35bf1112, ~15:22 Vorgabe thought 12507835;
 * Architektur-Befunde claude-birke a5e7af4e / Koordinator 37499):
 * Eine Pflicht-Memory haengt an einem STAMM (Ordner-Praefix oder Glob, z. B. packages/web-ui/**) - Memories am Ort verteilt statt nur
 * an Plan/Task. "Hinweis nicht gelesen blockiert den Aufruf und gibt den verlinkten Hinweis."
 *
 * PIN = MEMORY-VERKNUEPFUNG (keine eigene Pin-Tabelle): der Pin steht an der Memory selbst, wie die bestehende Pfad-Verknuepfung
 *   (memory.ts memoryLinkedPaths: Tags als Projektpfade), erweitert um Stamm-Muster + Pflicht: Tag 'pflicht:<stamm>' (mehrere moeglich)
 *   und optional 'pflicht-kurz:<Kurzfassung>' (sonst die ersten Saetze der Memory). Eigene Ablage nur fuer Quittungen und Ereignisse.
 * SPERRE (hart, nur ueberwachte Claude-Kontexte, agent-token-tools.ts mitAgentToolAufruf VOR dem Handler): schreibende files-Ops
 *   (files/files_batch: plan, create, update, search_replace..., delete, move, copy, commit, plan_update, coedit_add, restore,
 *   restore_batch) auf Pfade unter einem Stamm mit ungelesener Pflicht-Memory -> Fachfehler pflicht_memory_ungelesen mit Name, Stamm,
 *   Kurzfassung und Abruf memory(read, name). Die Sperre lehnt NUR den aktuellen Aufruf ab und aendert keinen Zustand (offene Plaene,
 *   Ops, Reservierungen, Co-Edit bleiben; User ~15:22); nach der Quittung geht es mit demselben Plan weiter.
 * QUITTUNG: memory(read|read_with_code) DERSELBEN Identitaet im aktuellen Lauf (lauf_id) + context_epoch, Hash md5(content).
 *   Erneut Pflicht nach Neuanmeldung/Kontextwechsel oder Aenderung der Memory.
 * HINWEIS (keine Sperre) ueber die bestehende Hinweisquellen-Registry (ausloeser-hinweise.ts, Quelle 'zwangs_pin', Drossel
 *   einmal_je_sitzung, hinweis_id je Pin + Lauf + Epoche): lesende Ops unter dem Stamm (files read, code_intel file/tree/..., docs
 *   get_for_file) und schreibende Ops nicht ueberwachter Kontexte. Antwortfeld ausloeser_hinweise.
 * GELTUNG (zwangsPinGeltung): Sperre nur MIT Ausweis UND ueberwachtem Kontext (Lauf der Identitaet aktiv, context_epoch > 0) UND
 *   Claude-Kennzeichen aus vorhandenen Merkmalen: Ausweis-Typ claude-* (agent_typen), Herkunft 'CLI (Claude Code)' (je Aufruf bzw.
 *   agent_identitaet_laeufe.herkunftsort), Lauf-Herkunft aus agent-lauf-herkunft.ts laufHerkunftAus (Wrapper-Anbieter anthropic bzw.
 *   Claude-Modell -> cli). Codex (Typ codex-*, Herkunft, laufHerkunftAus codex), Web-KI, API-Laeufe, extern/unbekannt und ohne Ausweis:
 *   nur Hinweis. Kennzeichen, Quelle und Merkmale in zwangs_pin_debug.
 * VERWALTUNG (bestehendes Tool admin): admin(action:'zwangs_pins', modus status|setzen|entfernen, pin_stamm, pin_memory, pin_kurzfassung,
 *   grund) setzt/entfernt die Tags an der Memory (memory.ts updateMemory). setzen/entfernen: User und Koordinator des Projekts
 *   (pruefeProfilVerwalter); status zusaetzlich Main. Mehrere Pins: spezifischster Stamm zuerst, alle unerfuellten werden genannt.
 * SCHALTER zwangs_pin (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich). AUS = keine Abfrage, kein Hinweis, keine Quittung.
 * Die Pruefung wirft nie: Lesefehler -> keine Sperre.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter, leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler, pruefeProfilVerwalter, aktuellerW1bAkteur } from './agent-profil-verwalter.js';
import { MAIN_ROLLE, type AusweisAkteur, type W1bAkteur } from './agent-profil-vertrag.js';
import { laufHerkunftAus } from './agent-lauf-herkunft.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { registriereHinweisQuelle, type AusloeserHinweis, type HinweisKontext } from './ausloeser-hinweise.js';
import { updateMemory } from './memory.js';

export const ZWANGS_PIN_FUNKTION = 'zwangs_pin' as const;
export const ZWANGS_PIN_FEHLER = 'pflicht_memory_ungelesen' as const;
/** Quelle in der Hinweisquellen-Registry (Antwortfeld ausloeser_hinweise). */
export const ZWANGS_PIN_HINWEIS_QUELLE = 'zwangs_pin' as const;
export const ZWANGS_PIN_HINWEIS_FELD = 'ausloeser_hinweise' as const;
export const ZWANGS_PIN_ADMIN_ACTIONS = ['zwangs_pins'] as const;
export const ZWANGS_PIN_MODI = ['status', 'setzen', 'entfernen'] as const;
/** Tags an der Memory: Stamm-Muster + Pflicht bzw. Kurzfassung. */
export const PFLICHT_TAG = 'pflicht:' as const;
export const PFLICHT_KURZ_TAG = 'pflicht-kurz:' as const;

/** Nur NEUE admin-Parameter (modus, grund, project bestehen schon). */
export const ZWANGS_PIN_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  pin_stamm: { type: 'string', description: 'zwangs_pins setzen/entfernen: Stamm (Ordner-Praefix oder Glob, projektrelativ, z. B. packages/web-ui/**); wird als Tag pflicht:<stamm> an der Memory gefuehrt' },
  pin_memory: { type: 'string', description: 'zwangs_pins setzen/entfernen: Name der Pflicht-Memory (muss im Projekt existieren)' },
  pin_kurzfassung: { type: 'string', description: 'zwangs_pins setzen: Kurzfassung (2-3 Saetze, 10..600 Zeichen) fuer den Sperr-Hinweis (Tag pflicht-kurz:)' },
};

export function istZwangsPinAdminAction(action: string | undefined): boolean {
  return typeof action === 'string' && (ZWANGS_PIN_ADMIN_ACTIONS as readonly string[]).includes(action);
}

// ---- Pfade und Staemme ------------------------------------------------------------------------------
const GLOB_ZEICHEN = /[*?]/;

/** Projektrelativ, Schraegstriche vereinheitlicht, ohne ./ und fuehrenden /. */
export function normalisierePinPfad(p: string): string {
  let s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/^\/+/, '');
}

function regexEscape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stamm -> RegExp. Ohne Glob: genau diese Datei oder alles darunter (Ordner-Praefix). Glob: ** = beliebig tief (auch der Ordner
 * selbst bei abschliessendem /**), * = innerhalb eines Segments, ? = ein Zeichen.
 */
export function stammRegex(stammRoh: string): RegExp {
  const stamm = normalisierePinPfad(stammRoh);
  if (!GLOB_ZEICHEN.test(stamm)) {
    const basis = stamm.replace(/\/+$/, '');
    return new RegExp('^' + regexEscape(basis) + '(?:/.*)?$');
  }
  let re = '';
  for (let i = 0; i < stamm.length; i++) {
    const c = stamm[i];
    if (c === '*' && stamm[i + 1] === '*') {
      const vorher = i > 0 && stamm[i - 1] === '/';
      const danach = stamm[i + 2];
      if (danach === '/') { re += '(?:.*/)?'; i += 2; continue; }
      if (vorher && danach === undefined) { re = re.replace(/\/$/, '') + '(?:/.*)?'; i += 1; continue; }
      re += '.*'; i += 1; continue;
    }
    if (c === '*') { re += '[^/]*'; continue; }
    if (c === '?') { re += '[^/]'; continue; }
    re += regexEscape(c);
  }
  return new RegExp('^' + re + '$');
}

export function stammPasst(stamm: string, pfad: string): boolean {
  try { return stammRegex(stamm).test(normalisierePinPfad(pfad)); } catch { return false; }
}

/** Spezifitaet = Laenge des woertlichen Teils vor dem ersten Glob-Zeichen (laenger = spezifischer). */
export function stammSpezifitaet(stamm: string): number {
  const s = normalisierePinPfad(stamm);
  const i = s.search(GLOB_ZEICHEN);
  return (i < 0 ? s : s.slice(0, i)).replace(/\/+$/, '').length;
}

// ---- Geltung (wer wird gesperrt) ---------------------------------------------------------------------
export type ZwangsPinGeltungsArt = 'claude_typ' | 'claude_cli' | 'claude_wrapper' | 'claude_modell' | 'codex' | 'web_ki' | 'api_lauf'
  | 'kontext_nicht_ueberwacht' | 'nicht_identifizierbar' | 'ohne_ausweis';
export interface ZwangsPinGeltung { art: ZwangsPinGeltungsArt; gesperrt: boolean; quelle: string; kontext_ueberwacht: boolean }

/** Vorhandene Merkmale der Identitaet (PG): Ausweis-Typ, Rolle, aktueller Lauf (context_epoch, herkunftsort), Wrapper-Anbieter. */
export interface ZwangsPinMerkmale {
  typ?: string | null; rolle?: string | null; lauf_epoch?: number | null; lauf_status?: string | null; lauf_herkunftsort?: string | null;
  wrapper_provider?: string | null; quelle?: string;
  /** agent_identitaeten.start_ort/start_ziel/start_ort_art: geschrieben von agent-start-ort.ts merkeStartOrt - bei chat(anmelden) mit
   *  ort 'extern' und ziel = herkunftVon(optionen) (agent-token-tools.ts), d. h. herkunftsortAusKopf(request.headers) der REST-Route
   *  (rest-api mcp.ts) bzw. 'CLI/stdio'; bei Daemon-/Container-Starts von merkeStartOrtAusJob mit ziel = target_runtime (claude|codex). */
  start_ort?: string | null; start_ziel?: string | null; start_ort_art?: string | null;
}
/** Exakte Werte aus agent-anmeldung.ts herkunftsortAusKopf (keine eigene Mustererkennung). */
const HERKUNFT_CLAUDE_CLI = 'CLI (Claude Code)';
/** herkunftsortAusKopf (agent-anmeldung.ts:90-91) liefert ohne bekanntes Muster das erste Produktwort des User-Agent; 'Claude-User' =
 *  User-Agent 'Claude-User/...' der Koordinator-Anbindung (Claude Code auf dem User-PC ueber cc-wrap, Entscheidung team-lead 08.11.).
 *  Zaehlt wie 'CLI (Claude Code)' - gesperrt wird trotzdem nur mit ueberwachtem Lauf (context_epoch). */
const HERKUNFT_CLAUDE_USER = 'Claude-User';
const istClaudeCliHerkunft = (s: string): boolean => s === HERKUNFT_CLAUDE_CLI || s === HERKUNFT_CLAUDE_USER;
const HERKUNFT_CODEX_CLI = 'CLI (Codex)';
const HERKUNFT_WEB_KI = new Set(['chatgpt.com', 'claude.ai']);

/**
 * Rein, testbar. Gesperrt nur MIT Ausweis, ueberwachtem Kontext (Lauf aktiv, context_epoch > 0) und Claude-Kennzeichen:
 *   Typ claude-* -> claude_typ; Herkunft 'CLI (Claude Code)' (Aufruf bzw. Lauf) -> claude_cli; laufHerkunftAus (agent-lauf-herkunft.ts)
 *   mit Wrapper-Anbieter anthropic -> claude_wrapper bzw. Claude-Modell -> claude_modell.
 * Vorrang (nur Hinweis): Web-KI, Codex (Typ codex-*, Herkunft, laufHerkunftAus codex), API-Lauf (laufHerkunftAus api).
 */
export function zwangsPinGeltung(e: { mitAusweis: boolean; herkunft?: string | null; modell?: string | null; merkmale?: ZwangsPinMerkmale | null }): ZwangsPinGeltung {
  const m0 = e.merkmale ?? {};
  const kontext = typeof m0.lauf_epoch === 'number' && m0.lauf_epoch > 0 && (m0.lauf_status ?? 'aktiv') === 'aktiv';
  const nein = (art: ZwangsPinGeltungsArt, quelle: string): ZwangsPinGeltung => ({ art, gesperrt: false, quelle, kontext_ueberwacht: kontext });
  if (!e.mitAusweis) return { art: 'ohne_ausweis', gesperrt: false, quelle: 'kein Ausweis (Legacy/extern)', kontext_ueberwacht: false };
  // Herkunft je Aufruf = herkunftVon(optionen) (agent-token-tools.ts) = herkunftsortAusKopf(request.headers) bzw. 'CLI/stdio'.
  const h = String(e.herkunft ?? '').trim();
  const lh = String(m0.lauf_herkunftsort ?? '').trim();
  const ort = String(m0.start_ort ?? '').trim(), ziel = String(m0.start_ziel ?? '').trim();
  const typ = String(m0.typ ?? '').toLowerCase().trim();
  // Vorhandene Lauf-Herkunft (P22-T178): Wrapper-Anbieter vor Modell.
  const lauf = laufHerkunftAus({ provider: m0.wrapper_provider ?? null, model: e.modell ?? null });
  const startQuelle = 'start_ort:' + ort + '/' + ziel;
  if (HERKUNFT_WEB_KI.has(h)) return nein('web_ki', 'herkunft:' + h);
  if (ort === 'extern' && (HERKUNFT_WEB_KI.has(ziel) || m0.start_ort_art === 'web_ki')) return nein('web_ki', startQuelle);
  if (/^codex/.test(typ)) return nein('codex', 'typ:' + m0.typ);
  if (h === HERKUNFT_CODEX_CLI) return nein('codex', 'herkunft:' + h);
  if ((ort === 'extern' && ziel === HERKUNFT_CODEX_CLI) || (ort === 'container' && ziel === 'codex')) return nein('codex', startQuelle);
  if (lauf.art === 'codex') return nein('codex', 'lauf_herkunft:' + lauf.quelle);
  if (lauf.art === 'api') return nein('api_lauf', 'lauf_herkunft:' + lauf.quelle);
  if (!h && HERKUNFT_WEB_KI.has(lh)) return nein('web_ki', 'lauf_herkunftsort:' + lh);
  if (!h && lh === HERKUNFT_CODEX_CLI) return nein('codex', 'lauf_herkunftsort:' + lh);
  let treffer: { art: ZwangsPinGeltungsArt; quelle: string } | null = null;
  if (/^claude/.test(typ)) treffer = { art: 'claude_typ', quelle: 'typ:' + m0.typ };
  else if (istClaudeCliHerkunft(h)) treffer = { art: 'claude_cli', quelle: 'herkunft:' + h };
  else if (ort === 'extern' && istClaudeCliHerkunft(ziel)) treffer = { art: 'claude_cli', quelle: startQuelle };
  else if (ort === 'container' && ziel === 'claude') treffer = { art: 'claude_wrapper', quelle: startQuelle };
  else if (istClaudeCliHerkunft(lh)) treffer = { art: 'claude_cli', quelle: 'lauf_herkunftsort:' + lh };
  else if (lauf.art === 'cli' && lauf.quelle === 'provider:anthropic') treffer = { art: 'claude_wrapper', quelle: 'lauf_herkunft:' + lauf.quelle };
  else if (lauf.art === 'cli' && lauf.quelle.startsWith('modell:') && /claude|opus|sonnet|haiku|fable/.test(lauf.quelle)) treffer = { art: 'claude_modell', quelle: 'lauf_herkunft:' + lauf.quelle };
  if (!treffer) return nein('nicht_identifizierbar', 'herkunft:' + (e.herkunft ?? '-') + ', lauf_herkunft:' + lauf.quelle + ', typ:' + (m0.typ ?? '-'));
  if (!kontext) return nein('kontext_nicht_ueberwacht', treffer.quelle + '; Lauf ohne context_epoch (' + (m0.quelle ?? 'keine Merkmale') + ')');
  return { art: treffer.art, gesperrt: true, quelle: treffer.quelle + '; context_epoch ' + m0.lauf_epoch, kontext_ueberwacht: true };
}

type Q = import('pg').QueryConfig & { query_timeout: number };
const q = (text: string, values: unknown[]): Q => ({ text, values, query_timeout: 3000 } as Q);

/** Merkmale aus PG (Ausweis-Typ der juengsten Profilrevision, Rolle, Lauf des Aufrufs, Wrapper-Anbieter). Fehler -> leere Merkmale. */
export async function ermittleZwangsPinMerkmale(a: { identity_id: string; lauf_id: string | null }): Promise<ZwangsPinMerkmale> {
  const out: ZwangsPinMerkmale = { quelle: 'pg' };
  try {
    const r = await getPool().query<{ rolle: string | null; typ: string | null; lauf_epoch: number | null; lauf_status: string | null; herkunftsort: string | null;
      start_ort: string | null; start_ziel: string | null; start_ort_art: string | null }>(q(
      `SELECT i.rolle, t.schluessel AS typ, l.context_epoch AS lauf_epoch, l.status AS lauf_status, l.herkunftsort,
              i.start_ort, i.start_ziel, i.start_ort_art
         FROM agent_identitaeten i
         LEFT JOIN LATERAL (SELECT typ_id FROM agent_profil_revisionen r WHERE r.identity_id = i.id ORDER BY r.revision DESC LIMIT 1) pr ON TRUE
         LEFT JOIN agent_typen t ON t.id = pr.typ_id
         LEFT JOIN agent_identitaet_laeufe l ON l.id = $2 AND l.identity_id = i.id
        WHERE i.id = $1`, [a.identity_id, a.lauf_id ?? '']));
    const z = r.rows[0];
    if (z) Object.assign(out, { rolle: z.rolle, typ: z.typ, lauf_epoch: z.lauf_epoch, lauf_status: z.lauf_status, lauf_herkunftsort: z.herkunftsort,
      start_ort: z.start_ort, start_ziel: z.start_ziel, start_ort_art: z.start_ort_art });
    else out.quelle = 'identitaet_unbekannt';
  } catch (e) { out.quelle = 'pg_fehler:' + String((e as Error)?.message ?? e).slice(0, 80); }
  try {
    const w = await getPool().query<{ provider: string | null }>(q(
      'SELECT provider FROM agent_identitaet_wrapper_status WHERE identity_id = $1 ORDER BY last_activity DESC NULLS LAST LIMIT 1', [a.identity_id]));
    out.wrapper_provider = w.rows[0]?.provider ?? null;
  } catch { out.wrapper_provider = null; }
  return out;
}

// ---- Relevanz der Aufrufe ----------------------------------------------------------------------------
const SCHREIB_AKTIONEN = new Set(['create', 'update', 'delete', 'move', 'copy', 'replace_lines', 'insert_after', 'delete_lines',
  'search_replace', 'search_replace_batch', 'restore', 'restore_batch', 'plan', 'commit', 'plan_update', 'coedit_add']);
const CODE_INTEL_LESEN = new Set(['file', 'tree', 'functions', 'variables', 'symbols', 'statements', 'flow', 'calls', 'references']);

export type ZwangsPinArt = 'schreiben' | 'lesen';

export function zwangsPinArt(tool: string, action: string | undefined): ZwangsPinArt | null {
  if (tool === 'files' || tool === 'files_batch') {
    if (action && SCHREIB_AKTIONEN.has(action)) return 'schreiben';
    return action === 'read' ? 'lesen' : null;
  }
  if (tool === 'code_intel') return action && CODE_INTEL_LESEN.has(action) ? 'lesen' : null;
  if (tool === 'docs') return action === 'get_for_file' ? 'lesen' : null;
  return null;
}

function texte(v: unknown): string[] {
  if (typeof v === 'string' && v.trim()) return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim());
  return [];
}

/** Alle Zielpfade eines Aufrufs (direkt, ops[], Plan bei commit/plan_update/coedit_add, Versionen bei restore). */
export async function sammleZwangsPinPfade(tool: string, action: string | undefined, args: Record<string, unknown>, project: string): Promise<string[]> {
  const pfade = new Set<string>();
  const dazu = (v: unknown) => { for (const p of texte(v)) { const n = normalisierePinPfad(p); if (n) pfade.add(n); } };
  dazu(args.file_path); dazu(args.files); dazu(args.new_path);
  if (tool === 'code_intel') dazu(args.path);
  if (Array.isArray(args.ops)) for (const op of args.ops) {
    if (op && typeof op === 'object') { dazu((op as Record<string, unknown>).file_path); dazu((op as Record<string, unknown>).new_path); }
  }
  const planId = typeof args.plan_id === 'string' || typeof args.plan_id === 'number' ? String(args.plan_id).trim() : '';
  if (planId && (action === 'commit' || action === 'plan_update' || action === 'coedit_add') && /^\d+$/.test(planId)) {
    const r = await getPool().query<{ p: string | null }>(q(
      `SELECT DISTINCT x.p FROM file_batch_plans fp
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(fp.ops)='array' THEN fp.ops ELSE '[]'::jsonb END) o
         CROSS JOIN LATERAL (VALUES (o->>'file_path'), (o->>'new_path')) x(p)
        WHERE fp.id = $1::bigint AND fp.project = $2 AND x.p IS NOT NULL`, [planId, project]));
    for (const z of r.rows) dazu(z.p);
  }
  if (action === 'restore' && (typeof args.version_id === 'string' || typeof args.version_id === 'number')) {
    const r = await getPool().query<{ file_path: string }>(q('SELECT file_path FROM file_versions WHERE id::text = $1 AND project = $2', [String(args.version_id), project]));
    for (const z of r.rows) dazu(z.file_path);
  }
  if (action === 'restore_batch' && (typeof args.batch_id === 'string' || typeof args.batch_id === 'number')) {
    const r = await getPool().query<{ file_path: string }>(q('SELECT DISTINCT file_path FROM file_versions WHERE batch_id::text = $1 AND project = $2', [String(args.batch_id), project]));
    for (const z of r.rows) dazu(z.file_path);
  }
  return [...pfade];
}

// ---- Pins = Memory-Verknuepfung (Tags pflicht:/pflicht-kurz:) ----------------------------------------
export interface ZwangsPin { id: string; project: string; stamm: string; memory_name: string; memory_id: string; kurzfassung: string; quelle: 'memory_tag'; aktualisiert_am: string }
const PIN_PUFFER = new Map<string, { bis: number; pins: ZwangsPin[] }>();
const PIN_TTL_MS = 5_000;
/** Puffer verwerfen (Tests; automatisch nach setzen/entfernen im eigenen Prozess). */
export function leereZwangsPinCache(): void { PIN_PUFFER.clear(); }

/** Kurzfassung: Tag pflicht-kurz:, sonst die ersten zwei Saetze der Memory (hoechstens 300 Zeichen). */
export function pinKurzfassung(content: string, tags: readonly string[]): string {
  const tag = tags.find(t => t.startsWith(PFLICHT_KURZ_TAG));
  if (tag && tag.slice(PFLICHT_KURZ_TAG.length).trim()) return tag.slice(PFLICHT_KURZ_TAG.length).trim();
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  const saetze = text.match(/[^.!?]+[.!?]+/g)?.slice(0, 2).map(s => s.trim()).join(' ') || text;
  return saetze.slice(0, 300);
}

/** Pins aus den Pflicht-Tags der Memories (PG, 5 s gepuffert). */
export async function ladeZwangsPins(project: string, ungepuffert = false): Promise<ZwangsPin[]> {
  const c = ungepuffert ? undefined : PIN_PUFFER.get(project);
  if (c && c.bis > Date.now()) return c.pins;
  const r = await getPool().query<{ id: string; name: string; content: string; tags: string[] | null; updated_at: Date }>(q(
    `SELECT id, name, content, tags, updated_at FROM memories
      WHERE project = $1 AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'pflicht:%') ORDER BY name, id`, [project]));
  const pins: ZwangsPin[] = [];
  for (const z of r.rows) {
    const tags = z.tags ?? [];
    for (const t of tags) {
      if (!t.startsWith(PFLICHT_TAG)) continue;
      const stamm = normalisierePinPfad(t.slice(PFLICHT_TAG.length));
      if (!stamm) continue;
      pins.push({ id: z.id + '#' + stamm, project, stamm, memory_name: z.name, memory_id: z.id, kurzfassung: pinKurzfassung(z.content, tags),
        quelle: 'memory_tag', aktualisiert_am: new Date(z.updated_at).toISOString() });
    }
  }
  PIN_PUFFER.set(project, { bis: Date.now() + PIN_TTL_MS, pins });
  return pins;
}

export interface PinTreffer { pin: ZwangsPin; pfade: string[] }
/** Pins, deren Stamm einen der Pfade umfasst; spezifischster Stamm zuerst. */
export function treffendeZwangsPins(pins: ZwangsPin[], pfade: string[]): PinTreffer[] {
  const out: PinTreffer[] = [];
  for (const pin of pins) {
    const t = pfade.filter(p => stammPasst(pin.stamm, p));
    if (t.length) out.push({ pin, pfade: t });
  }
  return out.sort((a, b) => stammSpezifitaet(b.pin.stamm) - stammSpezifitaet(a.pin.stamm) || a.pin.memory_name.localeCompare(b.pin.memory_name));
}

export interface ZwangsPinAufrufer { identity_id: string; agent_id: string; lauf_id: string | null; context_epoch: number; modell: string | null }
const laufSchluessel = (a: ZwangsPinAufrufer): string => a.lauf_id ?? 'ohne-lauf';

type OffenGrund = 'nicht_gelesen' | 'geaendert';
/** Je Memory-Name: quittiert (im Lauf + Epoche, gleicher Inhalt) oder offen mit Grund. */
async function offeneMemories(project: string, a: ZwangsPinAufrufer | null, namen: string[]): Promise<Map<string, OffenGrund | null>> {
  const r = await getPool().query<{ name: string; hash: string | null; q_hash: string | null }>(q(
    `SELECT n.name, m.hash, qt.memory_hash AS q_hash
       FROM unnest($2::text[]) AS n(name)
       LEFT JOIN LATERAL (SELECT md5(content) AS hash FROM memories WHERE project = $1 AND name = n.name ORDER BY updated_at DESC, id LIMIT 1) m ON TRUE
       LEFT JOIN zwangs_pin_quittungen qt ON qt.project = $1 AND qt.identity_id = $3 AND qt.lauf_id = $4 AND qt.context_epoch = $5
        AND qt.memory_name = n.name`,
    [project, namen, a?.identity_id ?? '', a ? laufSchluessel(a) : '', a?.context_epoch ?? -1]));
  const out = new Map<string, OffenGrund | null>();
  for (const z of r.rows) out.set(z.name, !z.q_hash ? 'nicht_gelesen' : z.q_hash === z.hash ? null : 'geaendert');
  return out;
}

async function protokolliere(e: { project: string; art: 'sperre' | 'quittung' | 'hinweis_schreiben'; a: ZwangsPinAufrufer | null; tool?: string; action?: string;
  pfade?: string[]; memories: string[]; geltung?: string; herkunft?: string | null }): Promise<void> {
  try {
    await getPool().query(q(
      `INSERT INTO zwangs_pin_ereignisse (project, art, identity_id, agent_id, lauf_id, context_epoch, tool, action, pfade, memories, geltung, herkunft)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [e.project, e.art, e.a?.identity_id ?? null, e.a?.agent_id ?? null, e.a ? laufSchluessel(e.a) : null, e.a?.context_epoch ?? null,
        e.tool ?? null, e.action ?? null, (e.pfade ?? []).slice(0, 20), e.memories, e.geltung ?? null, e.herkunft ?? null]));
  } catch { /* Debug ist Zugabe */ }
}

// ---- Befund je Aufruf (gemeinsam fuer Sperre und Hinweisquelle) ---------------------------------------
interface ZwangsPinBefund {
  art: ZwangsPinArt; pfade: string[]; offen: PinTreffer[]; stand: Map<string, OffenGrund | null>; geltung: ZwangsPinGeltung;
  merkmale: ZwangsPinMerkmale | null; schalter: { quelle: string; ebene: string | null };
}
async function ermittleBefund(e: {
  tool: string; action?: string; args: Readonly<Record<string, unknown>>; project: string | null; aufrufer: ZwangsPinAufrufer | null;
  herkunft?: string | null; merkmale?: ZwangsPinMerkmale | null;
}): Promise<ZwangsPinBefund | null> {
  const art = zwangsPinArt(e.tool, e.action);
  if (!art || !e.project || typeof e.args.artefakt_id === 'string') return null;
  const schalter = await leseProfilProduktSchalterGepuffert(ZWANGS_PIN_FUNKTION, e.project);
  if (!schalter.aktiv) return null;
  const pins = await ladeZwangsPins(e.project);
  if (!pins.length) return null;
  const pfade = await sammleZwangsPinPfade(e.tool, e.action, e.args as Record<string, unknown>, e.project);
  if (!pfade.length) return null;
  const treffer = treffendeZwangsPins(pins, pfade);
  if (!treffer.length) return null;
  const stand = await offeneMemories(e.project, e.aufrufer, [...new Set(treffer.map(t => t.pin.memory_name))]);
  const offen = treffer.filter(t => !!stand.get(t.pin.memory_name));
  if (!offen.length) return null;
  const merkmale = e.aufrufer ? (e.merkmale ?? await ermittleZwangsPinMerkmale(e.aufrufer)) : null;
  const geltung = zwangsPinGeltung({ mitAusweis: !!e.aufrufer, herkunft: e.herkunft, modell: e.aufrufer?.modell, merkmale });
  return { art, pfade, offen, stand, geltung, merkmale, schalter: { quelle: schalter.quelle, ebene: schalter.ebene } };
}

export interface ZwangsPinErgebnis { sperre?: Record<string, unknown> }
function abruf(name: string): string { return `memory(action:"read", name:"${name}")`; }

/**
 * SPERRE vor dem Handler (agent-token-tools.ts). null = keine Sperre (Hinweise liefert die Registry-Quelle). sperre = Fachfehler
 * (der Aufrufer setzt ihn als Antwort, nichts wird ausgefuehrt, kein Zustand geaendert). Wirft nie.
 */
export async function pruefeZwangsPin(e: {
  tool: string; action?: string; args: Record<string, unknown>; project: string | null; aufrufer: ZwangsPinAufrufer | null;
  herkunft?: string | null; schluessel?: string | null;
  /** Tests/Aufrufer mit bekannten Merkmalen; sonst aus PG (ermittleZwangsPinMerkmale). */
  merkmale?: ZwangsPinMerkmale | null;
}): Promise<ZwangsPinErgebnis | null> {
  try {
    const b = await ermittleBefund(e);
    if (!b || b.art !== 'schreiben' || !b.geltung.gesperrt) return null;
    const offeneNamen = [...new Set(b.offen.map(t => t.pin.memory_name))];
    await protokolliere({ project: e.project!, art: 'sperre', a: e.aufrufer, tool: e.tool, action: e.action, pfade: b.pfade, memories: offeneNamen,
      geltung: b.geltung.art, herkunft: e.herkunft });
    const erste = b.offen[0].pin;
    return { sperre: {
      success: false, error: ZWANGS_PIN_FEHLER, tool: e.tool, ...(e.action ? { action: e.action } : {}),
      message: `Gesperrt: Unter "${erste.stamm}" gilt die Pflicht-Memory "${erste.memory_name}"`
        + (offeneNamen.length > 1 ? ` (insgesamt ${offeneNamen.length} ungelesen: ${offeneNamen.join(', ')})` : '')
        + `. Kurzfassung: ${erste.kurzfassung} Lies sie vollstaendig mit ${abruf(erste.memory_name)}`
        + (offeneNamen.length > 1 ? ' (und die weiteren)' : '')
        + ' und wiederhole dann denselben Aufruf. Nichts wurde geschrieben; offene Plaene, Ops und Reservierungen bleiben unveraendert.',
      pflicht_memories: b.offen.map(t => ({ name: t.pin.memory_name, stamm: t.pin.stamm, kurzfassung: t.pin.kurzfassung,
        grund: b.stand.get(t.pin.memory_name), pfade: t.pfade.slice(0, 5), abruf: abruf(t.pin.memory_name) })),
      zustand_unveraendert: true,
      zwangs_pin_debug: { schalter: b.schalter, geltung: b.geltung, merkmale: b.merkmale, herkunft: e.herkunft ?? null,
        modell: e.aufrufer?.modell ?? null, lauf_id: e.aufrufer?.lauf_id ?? null, context_epoch: e.aufrufer?.context_epoch ?? null,
        pins: b.offen.map(t => ({ id: t.pin.id, stamm: t.pin.stamm, memory: t.pin.memory_name, grund: b.stand.get(t.pin.memory_name) })) },
    } };
  } catch {
    return null;
  }
}

/**
 * HINWEISQUELLE fuer die bestehende Registry (ausloeser-hinweise.ts): lesende Ops und nicht gesperrte schreibende Ops unter einem Stamm
 * mit ungelesener Pflicht-Memory. Drossel der Registry (einmal_je_sitzung); hinweis_id enthaelt Pins + Lauf + Epoche, damit ein neuer
 * Kontext den Hinweis erneut bekommt. Aufrufer aus dem bezeugten Principal des laufenden Aufrufs.
 */
export async function zwangsPinHinweise(k: HinweisKontext): Promise<AusloeserHinweis[]> {
  try {
    const p = aktuellerAgentPrincipal();
    const aufrufer: ZwangsPinAufrufer | null = p && p.art === 'identity'
      ? { identity_id: p.identity_id, agent_id: p.agent_id, lauf_id: p.lauf_id, context_epoch: p.context_epoch, modell: p.modell } : null;
    const b = await ermittleBefund({ tool: k.tool, action: k.aktion, args: k.argumente, project: k.projekt || null, aufrufer });
    if (!b || (b.art === 'schreiben' && b.geltung.gesperrt)) return [];
    const namen = [...new Set(b.offen.map(t => t.pin.memory_name))];
    if (b.art === 'schreiben') await protokolliere({ project: k.projekt, art: 'hinweis_schreiben', a: aufrufer, tool: k.tool, action: k.aktion,
      pfade: b.pfade, memories: namen, geltung: b.geltung.art });
    const erste = b.offen[0].pin;
    const text = `Zwangs-Pin: Pflicht-Memory "${erste.memory_name}" fuer ${erste.stamm}`
      + (namen.length > 1 ? ` (+${namen.length - 1} weitere: ${namen.slice(1).join(', ')})` : '')
      + ` ungelesen. Vor Aenderungen vollstaendig lesen: ${abruf(erste.memory_name)}.`
      + (b.art === 'lesen' ? ' Reine Suche darf das ignorieren.' : ` Keine Sperre fuer diesen Kontext (${b.geltung.art}).`);
    return [{
      hinweis_id: `${b.offen.map(t => t.pin.id).join(',')}|${aufrufer ? laufSchluessel(aufrufer) + '|' + aufrufer.context_epoch : 'legacy'}|${b.art}`,
      modus: 'einmal_je_sitzung', text, kurztext: `Pflicht-Memory ${erste.memory_name} ungelesen (${erste.stamm})`,
      spezifitaet: stammSpezifitaet(erste.stamm),
      folgeaktion: { tool: 'memory', aktion: 'read', argumente: { name: erste.memory_name } },
    }];
  } catch {
    return [];
  }
}

let hinweisRegistriert = false;
/** Beim Prozessstart (REST mcpRoutes, stdio createServer) wie die anderen Hinweisquellen registrieren. */
export function initialisiereZwangsPinHinweise(): void {
  if (hinweisRegistriert) return;
  try { registriereHinweisQuelle({ quelle_id: ZWANGS_PIN_HINWEIS_QUELLE, pruefe: zwangsPinHinweise }); hinweisRegistriert = true; } catch { /* doppelt */ }
}

/** Erfolgreiche Tool-Antwort (MCP-Ergebnis oder Objekt)? Fehler: isError oder success:false im ersten Textblock. */
export function zwangsPinAntwortErfolgreich(ergebnis: unknown): boolean {
  try {
    if (!ergebnis || typeof ergebnis !== 'object') return false;
    const r = ergebnis as { isError?: boolean; success?: boolean; content?: Array<{ type?: string; text?: string }> };
    if (r.isError === true || r.success === false) return false;
    const t = Array.isArray(r.content) ? r.content[0]?.text : undefined;
    if (typeof t === 'string' && t.trimStart().startsWith('{')) {
      const j = JSON.parse(t) as { success?: unknown };
      if (j && j.success === false) return false;
    }
    return true;
  } catch { return true; }
}

/**
 * Quittung nach memory(read|read_with_code) DERSELBEN Identitaet: nur Namen, die im Projekt Pflicht-Memory sind.
 * Hash = md5(content) jetzt. Liefert die quittierten Namen. Schalter AUS -> nichts. Wirft nie.
 */
export async function quittiereZwangsPinLesen(e: { project: string | null; aufrufer: ZwangsPinAufrufer | null; namen: unknown; id?: unknown }): Promise<string[]> {
  if (!e.project || !e.aufrufer) return [];
  try {
    const schalter = await leseProfilProduktSchalterGepuffert(ZWANGS_PIN_FUNKTION, e.project);
    if (!schalter.aktiv) return [];
    const pins = await ladeZwangsPins(e.project);
    if (!pins.length) return [];
    let namen = texte(e.namen);
    if (!namen.length && typeof e.id === 'string' && e.id.trim().length >= 8) {
      const r = await getPool().query<{ name: string }>(q(
        'SELECT name FROM memories WHERE project = $1 AND lower(left(id, length($2))) = lower($2) LIMIT 2', [e.project, e.id.trim()]));
      if (r.rows.length === 1) namen = [r.rows[0].name];
    }
    const gepinnt = new Set(pins.map(p => p.memory_name));
    namen = [...new Set(namen.filter(n => gepinnt.has(n)))];
    if (!namen.length) return [];
    const a = e.aufrufer;
    const r = await getPool().query<{ memory_name: string }>(q(
      `INSERT INTO zwangs_pin_quittungen (project, identity_id, lauf_id, context_epoch, memory_name, memory_hash, agent_id)
       SELECT $1, $2, $3, $4, n.name, m.hash, $6
         FROM unnest($5::text[]) AS n(name)
         JOIN LATERAL (SELECT md5(content) AS hash FROM memories WHERE project = $1 AND name = n.name ORDER BY updated_at DESC, id LIMIT 1) m ON TRUE
       ON CONFLICT (project, identity_id, lauf_id, context_epoch, memory_name)
       DO UPDATE SET memory_hash = EXCLUDED.memory_hash, quittiert_am = NOW()
       RETURNING memory_name`,
      [e.project, a.identity_id, laufSchluessel(a), a.context_epoch, namen, a.agent_id]));
    const quittiert = r.rows.map(z => z.memory_name);
    if (quittiert.length) await protokolliere({ project: e.project, art: 'quittung', a, tool: 'memory', action: 'read', memories: quittiert });
    return quittiert;
  } catch {
    return [];
  }
}

// ---- Schutz der Pflicht-Tags (Entscheidung team-lead 08.11.: nur User/Koordinator) ---------------------------
export const PFLICHT_TAG_FEHLER = 'pflicht_tags_nur_koordinator' as const;
const istPflichtTag = (t: string): boolean => t.startsWith(PFLICHT_TAG) || t.startsWith(PFLICHT_KURZ_TAG);
const pflichtMenge = (tags: unknown): string => JSON.stringify([...new Set(texte(tags).filter(istPflichtTag))].sort());

/**
 * memory write/update/delete (auch items[]) VOR dem Handler (agent-token-tools.ts): Hinzufuegen, Aendern oder Entfernen von
 * pflicht:/pflicht-kurz:-Tags und das Loeschen einer gepinnten Memory duerfen nur User und Koordinator des Projekts
 * (pruefeProfilVerwalter) - sonst koennte sich ein gesperrter Agent selbst freischalten. Uebrige Aenderungen bleiben erlaubt.
 * write ist ein Upsert: fehlende tags zaehlen als leer (wuerden vorhandene Pflicht-Tags entfernen). Schalter zwangs_pin AUS -> keine
 * Pruefung (Bestand). null = erlaubt; sonst Fachfehler pflicht_tags_nur_koordinator. Eigene Lesefehler -> null (wirft nie).
 */
export async function pruefePflichtTagSchutz(e: {
  tool: string; action?: string; args: Record<string, unknown>; project: string | null; legacyAgent?: string | null;
}): Promise<Record<string, unknown> | null> {
  if (e.tool !== 'memory' || !e.project || !['write', 'update', 'delete'].includes(e.action ?? '')) return null;
  const project = e.project;
  try {
    const schalter = await leseProfilProduktSchalterGepuffert(ZWANGS_PIN_FUNKTION, project);
    if (!schalter.aktiv) return null;
    type Eintrag = { name?: string; id?: string; tags?: unknown; tagsGesetzt: boolean };
    const eintraege: Eintrag[] = [];
    const nameAus = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    if (e.action === 'write') {
      if (Array.isArray(e.args.items)) {
        for (const it of e.args.items) if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>;
          eintraege.push({ name: nameAus(o.name), tags: o.tags, tagsGesetzt: true });
        }
      } else eintraege.push({ name: nameAus(e.args.name), tags: e.args.tags, tagsGesetzt: true });
    } else if (e.action === 'update') {
      eintraege.push({ name: nameAus(e.args.name), id: nameAus(e.args.id), tags: e.args.tags, tagsGesetzt: e.args.tags !== undefined });
    } else {
      for (const n of texte(e.args.name)) eintraege.push({ name: n.trim(), tagsGesetzt: false });
      if (nameAus(e.args.id)) eintraege.push({ id: nameAus(e.args.id), tagsGesetzt: false });
    }
    const betroffen: string[] = [];
    for (const x of eintraege) {
      if (!x.name && !x.id) continue;
      const r = await getPool().query<{ name: string; tags: string[] | null }>(q(
        `SELECT name, tags FROM memories WHERE project = $1
            AND (name = $2 OR ($3::text <> '' AND lower(left(id, length($3))) = lower($3)))
          ORDER BY updated_at DESC, id LIMIT 1`, [project, x.name ?? '', x.id ?? '']));
      const alt = r.rows[0];
      const altMenge = pflichtMenge(alt?.tags ?? []);
      if (e.action === 'delete') { if (alt && altMenge !== '[]') betroffen.push(alt.name); continue; }
      if (x.tagsGesetzt && pflichtMenge(x.tags) !== altMenge) betroffen.push(x.name ?? alt?.name ?? '?');
    }
    if (!betroffen.length) return null;
    const akteur: AusweisAkteur | null = aktuellerW1bAkteur()
      ?? (e.legacyAgent ? { art: 'legacy_koordinator', agent_id: e.legacyAgent } : null);
    try {
      if (!akteur) throw new ProfilVerwaltungFehler('recht_fehlt');
      await pruefeProfilVerwalter(akteur, project);
      return null;
    } catch {
      return { success: false, error: PFLICHT_TAG_FEHLER, tool: 'memory', action: e.action, memories: betroffen,
        message: 'Pflicht-Tags (pflicht:/pflicht-kurz:) setzen, aendern oder entfernen und gepinnte Memories loeschen duerfen nur User und '
          + 'Koordinator des Projekts (admin(action:"zwangs_pins")). Betroffen: ' + betroffen.join(', ')
          + '. Nichts wurde geschrieben; Aenderungen ohne Pflicht-Tags sind weiter erlaubt.' };
    }
  } catch {
    return null;
  }
}

// ---- Verwaltung (admin zwangs_pins) -> Tags an der Memory -------------------------------------------------
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

function pflichtStamm(v: unknown): string {
  const s = normalisierePinPfad(typeof v === 'string' ? v : '');
  if (!s || s === '**' || s.length > 300 || s.split('/').includes('..')) fehler('pin_stamm_ungueltig', { beispiel: 'packages/web-ui/**' });
  try { stammRegex(s); } catch { fehler('pin_stamm_ungueltig', { beispiel: 'packages/web-ui/**' }); }
  return s;
}
function pflichtName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 200) fehler('pin_memory_fehlt');
  return s;
}

async function statusAntwort(project: string): Promise<Record<string, unknown>> {
  const schalter = await leseProfilProduktSchalter(ZWANGS_PIN_FUNKTION, project);
  const pins = await ladeZwangsPins(project, true);
  const pool = getPool();
  const quittungen = await pool.query(q(
    `SELECT qt.identity_id, qt.agent_id, qt.lauf_id, qt.context_epoch, qt.memory_name, qt.quittiert_am,
            (qt.memory_hash = (SELECT md5(content) FROM memories m WHERE m.project = qt.project AND m.name = qt.memory_name ORDER BY updated_at DESC, id LIMIT 1)) AS aktuell
       FROM zwangs_pin_quittungen qt WHERE qt.project = $1 ORDER BY qt.quittiert_am DESC LIMIT 30`, [project]));
  const sperren = await pool.query(q(
    `SELECT id::text AS id, wann, agent_id, identity_id, lauf_id, context_epoch, tool, action, pfade, memories, geltung, herkunft
       FROM zwangs_pin_ereignisse WHERE project = $1 AND art = 'sperre' ORDER BY wann DESC LIMIT 20`, [project]));
  const zaehler = await pool.query<{ art: string; n: string }>(q(
    `SELECT art, count(*)::text AS n FROM zwangs_pin_ereignisse WHERE project = $1 AND wann > NOW() - INTERVAL '7 days' GROUP BY art`, [project]));
  return {
    project, schalter: { aktiv: schalter.aktiv, quelle: schalter.quelle, ebene: schalter.ebene, letzter_fehler: schalter.letzter_fehler },
    pins: pins.map(p => ({ ...p, spezifitaet: stammSpezifitaet(p.stamm) })),
    quittungen: quittungen.rows, letzte_sperren: sperren.rows,
    ereignisse_7_tage: Object.fromEntries(zaehler.rows.map(z => [z.art, Number(z.n)])),
    ablage: 'Pins = Tags pflicht:<stamm> / pflicht-kurz:<text> an der Memory; Quittungen/Ereignisse in zwangs_pin_quittungen/zwangs_pin_ereignisse.',
    geltung: 'Sperre nur mit Ausweis, ueberwachtem Lauf (context_epoch) und Claude-Kennzeichen (Typ claude-*, Herkunft CLI (Claude Code), Lauf-Herkunft cli/anthropic); sonst nur Hinweis.',
  };
}

/** admin(action:'zwangs_pins'): status (User, Koordinator des Projekts, Main), setzen/entfernen (User, Koordinator des Projekts). */
export async function fuehreZwangsPinAdminAus(action: string, args: Record<string, unknown>, akteur: W1bAkteur | AusweisAkteur | null): Promise<Record<string, unknown>> {
  try {
    if (!akteur) fehler('recht_fehlt');
    const wer = akteur as AusweisAkteur;
    const projektArg = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
    const project = projektArg ?? (wer.art === 'identitaet' ? wer.principal.project : null);
    if (!project) fehler('project_fehlt');
    const modus = args.modus === undefined || args.modus === null || args.modus === '' ? 'status' : String(args.modus);
    if (!(ZWANGS_PIN_MODI as readonly string[]).includes(modus)) fehler('modus_unbekannt', { erlaubt: ZWANGS_PIN_MODI });
    const istMain = wer.art === 'identitaet' && wer.principal.rolle === MAIN_ROLLE;
    if (modus === 'status') {
      if (!istMain) await pruefeProfilVerwalter(wer, project);
      return { success: true, action, modus, ...(await statusAntwort(project)) };
    }
    const v = await pruefeProfilVerwalter(wer, project);
    const stamm = pflichtStamm(args.pin_stamm);
    const name = pflichtName(args.pin_memory);
    const m = await getPool().query<{ tags: string[] | null }>(q(
      'SELECT tags FROM memories WHERE project = $1 AND name = $2 ORDER BY updated_at DESC, id LIMIT 1', [project, name]));
    if (!m.rows.length) fehler('memory_unbekannt', { name });
    const alt = m.rows[0].tags ?? [];
    const pinTag = PFLICHT_TAG + stamm;
    let neu: string[];
    if (modus === 'setzen') {
      const kurz = typeof args.pin_kurzfassung === 'string' ? args.pin_kurzfassung.trim() : '';
      if (kurz.length < 10 || kurz.length > 600) fehler('pin_kurzfassung_fehlt', { min: 10, max: 600 });
      neu = [...alt.filter(t => t !== pinTag && !t.startsWith(PFLICHT_KURZ_TAG)), pinTag, PFLICHT_KURZ_TAG + kurz];
    } else {
      if (!alt.includes(pinTag)) fehler('pin_unbekannt', { stamm, memory: name });
      neu = alt.filter(t => t !== pinTag);
      if (!neu.some(t => t.startsWith(PFLICHT_TAG))) neu = neu.filter(t => !t.startsWith(PFLICHT_KURZ_TAG));
    }
    // Bestehender Memory-Schreibweg (Versionierung/Index), nur die Tags aendern sich; der Inhalt (Quittungs-Hash) bleibt.
    await updateMemory(project, name, { tags: neu });
    leereZwangsPinCache();
    const schalter = await leseProfilProduktSchalter(ZWANGS_PIN_FUNKTION, project);
    return { success: true, action, modus, pin: { stamm, memory: name, tag: pinTag }, tags: neu, von: v.wer, ...(typeof args.grund === 'string' && args.grund.trim() ? { grund: args.grund.trim() } : {}),
      schalter: { aktiv: schalter.aktiv, quelle: schalter.quelle, ebene: schalter.ebene },
      ...(schalter.aktiv || modus === 'entfernen' ? {} : { hinweis: "Produkt-Schalter zwangs_pin ist AUS: der Pin wirkt erst nach admin(action:'profil_schalter_setzen', profil_funktion:'zwangs_pin', aktiv:true, ebene, grund)." }) };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, action, error: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, action, error: 'zwangs_pin_fehler', message: ((err as { message?: string } | null)?.message ?? '').slice(0, 160) };
  }
}
