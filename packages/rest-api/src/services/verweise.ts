/**
 * MODUL: verweise
 * ZWECK: P8-T31 - Verweise in Channel-Nachrichten (Thought-/Doc-IDs, Memory-Namen, Task-/Plan-Kurz-IDs,
 *        Event-/Nachrichten-/Chat-IDs) gebuendelt aufloesen und den Inhalt als lesbaren Klartext liefern.
 * REGELN: Es wird nur verlinkt, was die Datenbank wirklich kennt. Rein lesend, projektgebunden
 *         (Ausnahme tech_docs: projektuebergreifend). Nie rohes JSON: strukturierte Werte werden zu Feldzeilen.
 */

import { getPool, getPlan, findeTaskInPlan, getProjectRegistryRows } from '@synapse/core';

export type VerweisArt = 'thought' | 'memory' | 'task' | 'plan' | 'doc' | 'event' | 'nachricht' | 'chat' | 'asset';

export interface VerweisTreffer {
  art: VerweisArt;
  id: string;
  titel: string;
}

export interface VerweisKandidat {
  text: string;
  /** Hinweis aus dem Umfeld ("Event 9965", "#28039"): noetig, damit reine Zahlen ueberhaupt aufgeloest werden. */
  hinweis?: 'event' | 'nachricht' | 'chat' | 'memory' | 'asset';
}

export interface VerweisErgebnis {
  text: string;
  treffer: VerweisTreffer[];
}

export interface VerweisInhalt {
  art: VerweisArt;
  id: string;
  titel: string;
  meta: Array<{ label: string; wert: string }>;
  text: string;
}

export const KANDIDATEN_MAX = 60;
const ARTEN: VerweisArt[] = ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset'];

const TASK_RE = /^P\d+-T\d+$/i;
const PLAN_RE = /^P\d+$/i;
const HEX_RE = /^[0-9a-f][0-9a-f-]{7,35}$/i;
const ZAHL_RE = /^\d{1,9}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,120}$/;

export function istVerweisArt(wert: string): wert is VerweisArt {
  return (ARTEN as string[]).includes(wert);
}

function kurz(text: unknown, max = 80): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function iso(wert: unknown): string {
  if (wert instanceof Date) return wert.toISOString();
  const d = new Date(String(wert ?? ''));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

async function frage(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const res = await getPool().query(sql, params);
  return res.rows as Array<Record<string, unknown>>;
}

/**
 * P22-T150: Asset-Pfad zu einem Bildverweis aus einem Chat. Relativ wie bisher ('./' faellt weg); absolut nur unterhalb einer
 * registrierten Projektwurzel (der Rest ist der Asset-Pfad), sonst null; '..' nie.
 */
export function assetPfadAusVerweis(text: string, wurzeln: readonly string[]): string | null {
  const t = text.trim();
  if (!t || t.split(/[\\/]/).includes('..')) return null;
  if (!t.startsWith('/')) return t.replace(/^(?:\.\/)+/, '') || null;
  for (const w of [...wurzeln].sort((a, b) => b.length - a.length)) {
    const wurzel = w.replace(/\/+$/, '') + '/';
    if (wurzel !== '/' && t.startsWith(wurzel) && t.length > wurzel.length) return t.slice(wurzel.length);
  }
  return null;
}

/** Projektwurzeln aller Rechner (PC, Container) aus der Registry, ohne den virtuellen REST-Eintrag. */
async function projektWurzeln(project: string): Promise<string[]> {
  return (await getProjectRegistryRows(project)).map((r) => String(r.path ?? '')).filter((p) => p.startsWith('/') && !p.startsWith('/virtual/'));
}

export interface AssetVerweisDienste {
  frage: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
  wurzeln: (project: string) => Promise<string[]>;
}

// Nur nicht geloeschte Bilder (MIME, Format oder Endung).
const BILD_BEDINGUNG = "deleted_at IS NULL AND (mime_type LIKE 'image/%' OR lower(format) IN ('png','jpg','jpeg','gif','webp','avif')"
  + " OR lower(file_path) ~ '\\.(png|jpe?g|gif|webp|avif)$')";

/**
 * P8-T31 Nachtrag: nur indexierte Assets des Projekts (kein Pfad ausserhalb, keine Vermutung).
 * P22-T150: zusaetzlich absolute Pfade unter der Projektwurzel und asset_id (reine Zahl); nur Bilder, nicht geloescht.
 * Kein Schalter: gleiche Route, gleiche Antwortform, es werden nur mehr Schreibweisen aufgeloest (reine Anzeige).
 */
export async function loeseAssetVerweis(project: string, text: string, dienste: Partial<AssetVerweisDienste> = {}): Promise<VerweisTreffer[]> {
  const d: AssetVerweisDienste = { frage, wurzeln: projektWurzeln, ...dienste };
  const t = text.trim();
  let zeilen: Array<Record<string, unknown>>;
  if (/^\d{1,12}$/.test(t)) {
    zeilen = await d.frage('SELECT file_path, file_name FROM asset_files WHERE project = $1 AND id = $2::bigint AND ' + BILD_BEDINGUNG, [project, t]);
  } else {
    const pfad = assetPfadAusVerweis(t, t.startsWith('/') ? await d.wurzeln(project) : []);
    if (!pfad) return [];
    zeilen = await d.frage('SELECT file_path, file_name FROM asset_files WHERE project = $1 AND file_path = $2 AND ' + BILD_BEDINGUNG, [project, pfad]);
  }
  const a = zeilen[0];
  return a ? [{ art: 'asset', id: String(a.file_path), titel: String(a.file_name) }] : [];
}

async function planOderNull(project: string, ref: string) {
  try {
    return await getPlan(project, ref);
  } catch {
    return null;
  }
}

async function loeseEin(project: string, k: VerweisKandidat): Promise<VerweisTreffer[]> {
  const text = String(k.text ?? '').trim();
  // P22-T150: absolute Bildpfade sind laenger als IDs/Namen.
  if (!text || text.length > (k.hinweis === 'asset' ? 1024 : 128)) return [];
  const treffer: VerweisTreffer[] = [];

  if (k.hinweis === 'asset') return loeseAssetVerweis(project, text);
  if (TASK_RE.test(text)) {
    const plan = await planOderNull(project, text.split('-')[0].toUpperCase());
    if (plan) {
      const task = findeTaskInPlan(plan, text);
      if (typeof task !== 'string') treffer.push({ art: 'task', id: String(task.kurz_id ?? text.toUpperCase()), titel: kurz(task.title) });
    }
    return treffer;
  }
  if (PLAN_RE.test(text)) {
    const plan = await planOderNull(project, text.toUpperCase());
    if (plan) treffer.push({ art: 'plan', id: String(plan.kurz_id ?? text.toUpperCase()), titel: kurz(plan.name) });
    return treffer;
  }
  if (ZAHL_RE.test(text)) {
    const nr = Number(text);
    if (k.hinweis === 'event') {
      const r = await frage('SELECT id, event_type, payload FROM agent_events WHERE project = $1 AND id = $2', [project, nr]);
      if (r[0]) treffer.push({ art: 'event', id: String(r[0].id), titel: kurz(r[0].event_type) });
    } else if (k.hinweis === 'nachricht') {
      const r = await frage(
        `SELECT m.id, m.content, c.name FROM specialist_channel_messages m JOIN specialist_channels c ON c.id = m.channel_id
         WHERE c.project = $1 AND m.id = $2`, [project, nr]);
      if (r[0]) treffer.push({ art: 'nachricht', id: String(r[0].id), titel: '#' + String(r[0].name) + ': ' + kurz(r[0].content, 60) });
    } else if (k.hinweis === 'chat') {
      const r = await frage('SELECT id, sender_id, content FROM chat_messages WHERE project = $1 AND id = $2', [project, nr]);
      if (r[0]) treffer.push({ art: 'chat', id: String(r[0].id), titel: String(r[0].sender_id) + ': ' + kurz(r[0].content, 60) });
    }
    return treffer;
  }
  if (HEX_RE.test(text)) {
    const praefix = text.toLowerCase();
    const gedanken = await frage('SELECT id, content FROM thoughts WHERE project = $1 AND id LIKE $2 ORDER BY id LIMIT 6', [project, praefix + '%']);
    for (const g of gedanken) treffer.push({ art: 'thought', id: String(g.id), titel: kurz(g.content) });
    const docs = await frage('SELECT id, framework, version, section FROM tech_docs WHERE id LIKE $1 ORDER BY id LIMIT 6', [praefix + '%']);
    for (const d of docs) treffer.push({ art: 'doc', id: String(d.id), titel: [d.framework, d.version, d.section].filter(Boolean).join(' ') });
    return treffer;
  }
  if (NAME_RE.test(text)) {
    const m = await frage('SELECT name, category, content FROM memories WHERE project = $1 AND name = $2', [project, text]);
    if (m[0]) treffer.push({ art: 'memory', id: String(m[0].name), titel: kurz(m[0].category ? String(m[0].category) + ': ' + String(m[0].name) : m[0].name) });
  }
  return treffer;
}

/** Loest jeden Kandidaten einzeln auf; Reihenfolge und Anzahl bleiben erhalten. Mehrdeutige Praefixe liefern mehrere Treffer. */
export async function loeseVerweiseAuf(project: string, kandidaten: VerweisKandidat[]): Promise<VerweisErgebnis[]> {
  const begrenzt = kandidaten.slice(0, KANDIDATEN_MAX);
  const out: VerweisErgebnis[] = [];
  for (const k of begrenzt) {
    let treffer: VerweisTreffer[] = [];
    try {
      treffer = await loeseEin(project, k);
    } catch {
      treffer = [];
    }
    out.push({ text: String(k.text ?? ''), treffer });
  }
  return out;
}

// ───────────────────────── Klartext ─────────────────────────

/** Strukturierte Werte als lesbare Feldzeilen statt JSON. */
export function wertZuKlartext(wert: unknown, ebene = 0): string {
  const einzug = '  '.repeat(ebene);
  if (wert === null || wert === undefined || wert === '') return einzug + '-';
  if (typeof wert === 'string') return wert.split('\n').map((z) => einzug + z).join('\n');
  if (typeof wert === 'number' || typeof wert === 'boolean') return einzug + String(wert);
  if (Array.isArray(wert)) {
    if (wert.length === 0) return einzug + '-';
    return wert.map((x) => {
      if (x !== null && typeof x === 'object') return einzug + '- \n' + wertZuKlartext(x, ebene + 1);
      return einzug + '- ' + String(x);
    }).join('\n');
  }
  if (typeof wert === 'object') {
    const zeilen: string[] = [];
    for (const [schluessel, v] of Object.entries(wert as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') zeilen.push(einzug + schluessel + ':\n' + wertZuKlartext(v, ebene + 1));
      else zeilen.push(einzug + schluessel + ': ' + (v === null || v === undefined || v === '' ? '-' : String(v)));
    }
    return zeilen.length ? zeilen.join('\n') : einzug + '-';
  }
  return einzug + String(wert);
}

/** Text, der JSON sein koennte (Event-Payload, Metadaten), als Klartext; sonst unveraendert. */
export function textOderJsonZuKlartext(roh: unknown): string {
  if (roh !== null && typeof roh === 'object') return wertZuKlartext(roh);
  const s = String(roh ?? '').trim();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return wertZuKlartext(JSON.parse(s));
    } catch {
      return s;
    }
  }
  return s;
}

function meta(paare: Array<[string, unknown]>): Array<{ label: string; wert: string }> {
  return paare
    .filter(([, w]) => w !== null && w !== undefined && String(w) !== '')
    .map(([label, w]) => ({ label, wert: Array.isArray(w) ? w.map(String).join(', ') : String(w) }));
}

const STATUS_TEXT: Record<string, string> = { todo: 'offen', in_progress: 'in Arbeit', done: 'erledigt', blocked: 'blockiert' };

/** Liest einen Verweis; null, wenn es ihn im Projekt nicht gibt. */
export async function leseVerweis(project: string, art: VerweisArt, id: string): Promise<VerweisInhalt | null> {
  switch (art) {
    case 'thought': {
      const r = await frage('SELECT id, source, content, tags, timestamp, task_id FROM thoughts WHERE project = $1 AND id = $2', [project, id]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.id), titel: kurz(x.content, 70),
        meta: meta([['Quelle', x.source], ['Zeit', iso(x.timestamp)], ['Tags', x.tags], ['Task', x.task_id]]),
        text: String(x.content ?? ''),
      };
    }
    case 'memory': {
      const r = await frage('SELECT name, category, content, tags, updated_at FROM memories WHERE project = $1 AND name = $2', [project, id]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.name), titel: String(x.name),
        meta: meta([['Kategorie', x.category], ['Zeit', iso(x.updated_at)], ['Tags', x.tags]]),
        text: String(x.content ?? ''),
      };
    }
    case 'task': {
      const plan = await planOderNull(project, id.split('-')[0].toUpperCase());
      if (!plan) return null;
      const task = findeTaskInPlan(plan, id);
      if (typeof task === 'string') return null;
      return {
        art, id: String(task.kurz_id ?? id), titel: String(task.title ?? ''),
        meta: meta([
          ['Plan', (plan.kurz_id ?? '') + ' ' + plan.name], ['Status', STATUS_TEXT[String(task.status)] ?? task.status],
          ['Prioritaet', task.priority], ['Geaendert', iso(task.updatedAt)],
          ['Beteiligte', Array.isArray(task.beteiligte) ? (task.beteiligte as Array<Record<string, unknown>>).map((b) => String(b.agent_id ?? b.agentId ?? '')).filter(Boolean) : ''],
        ]),
        text: String(task.description ?? ''),
      };
    }
    case 'plan': {
      const plan = await planOderNull(project, id.toUpperCase());
      if (!plan) return null;
      const teile: string[] = [];
      if (plan.description) teile.push(plan.description);
      if (plan.goals?.length) teile.push('Ziele\n' + plan.goals.map((z) => '- ' + z).join('\n'));
      if (plan.architecture) teile.push('Architektur\n' + plan.architecture);
      if (plan.tasks?.length) {
        teile.push('Tasks\n' + plan.tasks.map((t) => '- ' + String(t.kurz_id ?? '') + ' [' + (STATUS_TEXT[String(t.status)] ?? t.status) + '] ' + t.title).join('\n'));
      }
      return {
        art, id: String(plan.kurz_id ?? id), titel: plan.name,
        meta: meta([['Prioritaet', plan.prioritaet], ['Aktiv', plan.aktiv ? 'ja' : 'nein'], ['Geaendert', iso(plan.updatedAt)]]),
        text: teile.join('\n\n'),
      };
    }
    case 'doc': {
      const r = await frage('SELECT id, framework, version, section, content, type, source, indexed_at FROM tech_docs WHERE id = $1', [id]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.id), titel: [x.framework, x.version, x.section].filter(Boolean).join(' '),
        meta: meta([['Framework', x.framework], ['Version', x.version], ['Typ', x.type], ['Quelle', x.source], ['Zeit', iso(x.indexed_at)]]),
        text: String(x.content ?? ''),
      };
    }
    case 'event': {
      if (!ZAHL_RE.test(id)) return null;
      const r = await frage('SELECT id, event_type, priority, scope, source_id, payload, created_at FROM agent_events WHERE project = $1 AND id = $2', [project, Number(id)]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.id), titel: String(x.event_type),
        meta: meta([['Prioritaet', x.priority], ['Ziel', x.scope], ['Absender', x.source_id], ['Zeit', iso(x.created_at)]]),
        text: textOderJsonZuKlartext(x.payload),
      };
    }
    case 'nachricht': {
      if (!ZAHL_RE.test(id)) return null;
      const r = await frage(
        `SELECT m.id, m.sender, m.content, m.created_at, c.name FROM specialist_channel_messages m
         JOIN specialist_channels c ON c.id = m.channel_id WHERE c.project = $1 AND m.id = $2`, [project, Number(id)]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.id), titel: '#' + String(x.name) + ' von ' + String(x.sender),
        meta: meta([['Channel', x.name], ['Absender', x.sender], ['Zeit', iso(x.created_at)]]),
        text: String(x.content ?? ''),
      };
    }
    case 'asset': {
      const r = await frage('SELECT file_path, file_name, asset_type, format, file_size, mime_type, metadata, mtime FROM asset_files WHERE project = $1 AND file_path = $2', [project, id]);
      if (!r[0]) return null;
      const x = r[0];
      const md = (x.metadata ?? {}) as Record<string, unknown>;
      const masse = md.width && md.height ? String(md.width) + '×' + String(md.height) : '';
      return {
        art, id: String(x.file_path), titel: String(x.file_name),
        meta: meta([['Typ', x.asset_type], ['Format', x.format], ['Größe', x.file_size ? String(Math.round(Number(x.file_size) / 1024)) + ' KB' : ''], ['Maße', masse], ['Zeit', iso(x.mtime)]]),
        text: '',
      };
    }
    case 'chat': {
      if (!ZAHL_RE.test(id)) return null;
      const r = await frage('SELECT id, sender_id, recipient_id, content, timestamp FROM chat_messages WHERE project = $1 AND id = $2', [project, Number(id)]);
      if (!r[0]) return null;
      const x = r[0];
      return {
        art, id: String(x.id), titel: 'Chat von ' + String(x.sender_id),
        meta: meta([['Von', x.sender_id], ['An', x.recipient_id ?? 'alle'], ['Zeit', iso(x.timestamp)]]),
        text: String(x.content ?? ''),
      };
    }
    default:
      return null;
  }
}
