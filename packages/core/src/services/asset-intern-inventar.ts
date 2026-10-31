/**
 * P22-T241 (USER-GRUNDSATZ 31.10.2026, thought 5e4ac6f7): Reverse-Daten liegen nur im Reverse-Share. In einen Projekt-Share kommt
 * Reverse-Inhalt ausschliesslich ueber reverse(uebernehmen) als normales Projekt-Asset.
 *
 * BEFUND (Code, gelesen): AssetSpeicher trennt die Wurzeln seit A3 (043fe8cd): Bereich 'reverse' -> SYNAPSE_REVERSE_ROOT
 *   (reverseKontext, _eingang/_direkt/_arbeit, reverse-journal). Unter <projekt>/.intern schreibt NUR der Bereich 'projekt'.
 *   Der einzige Reverse-Weg dorthin ist uebernehmeReverseAsset (Upload-Kern, host_id 'reverse-api'): je Chunk ein
 *   Staging (.intern/staging/<id>.part) + Journal, dazu das zusammengesetzte Staging und Revisionskopien. Diese Teile wurden
 *   bisher NIE entfernt (auch nicht nach Erfolg) und bei gescheiterten Versuchen (z. B. seit 26.10. an der Publikationssperre
 *   P22-T206) blieb je Versuch eine volle Kopie liegen. Bindungen (reverse_bindungen) geben nur Sichtbarkeit/Recht
 *   (reverseEintragSichtbar, P18-T109), sie kopieren nichts.
 *
 * WIRKUNG:
 *  - inventarProjektIntern(project): Ordner unter <projekt>/.intern mit Anzahl/Bytes/aeltester/neuester Datei; Staging, Journal
 *    und Revisionen nach Herkunft (reverse_uebernehmen | pc | share | user | unbekannt) ueber asset_upload_teile/-sitzungen;
 *    fremde Ordner (nicht journal/staging/revisionen/locks) ausdruecklich gelistet. Nur lesen.
 *  - raeumeReverseAltbestandAuf(project): NUR Staging/Journal mit Herkunft reverse_uebernehmen, deren Sitzung abgeschlossen ist
 *    (finalisiert | fehler | abgebrochen | Lease abgelaufen) und deren Journal nicht prepared/published ist; nie die Sperre,
 *    nie Revisionen (Asset-Historie), nie sichtbare Assets. Standard Vorschau; Loeschen nur mit ausfuehren+bestaetigt.
 * SCHALTER: Produkt-Schalter 'asset_intern_aufraeumen' (Standard AUS, nur ausdruecklich) fuer das Ausfuehren; Inventar immer.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getPool } from '../db/client.js';
import { getAssetKonfiguration } from '../config/asset-konfig.js';
import type { AssetKonfiguration } from '../config/asset-konfig.js';
import type { AssetUploadDb } from './asset-upload.js';
import { leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';

export const ASSET_INTERN_AUFRAEUMEN = 'asset_intern_aufraeumen' as const;
type Db = Pick<AssetUploadDb, 'query'>;
export type InternHerkunft = 'reverse_uebernehmen' | 'pc' | 'share' | 'user' | 'unbekannt';
const PROJEKT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEKANNT = new Set(['journal', 'staging', 'revisionen', 'locks']);
const CHUNK = 5000;

export function herkunftVonHost(host: unknown): InternHerkunft {
  const h = String(host ?? '');
  if (h === 'reverse-api') return 'reverse_uebernehmen';
  if (h === 'share-scanner') return 'share';
  if (h.startsWith('user:')) return 'user';
  return h ? 'pc' : 'unbekannt';
}

interface Sitzungsbezug { herkunft: InternHerkunft; status: string; lease_aktiv: boolean }
async function bezuege(db: Db, project: string, ids: string[]): Promise<Map<string, Sitzungsbezug>> {
  const out = new Map<string, Sitzungsbezug>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const teil = ids.slice(i, i + CHUNK);
    const rows = (await db.query(
      `SELECT t.staging_id::text AS id, s.host_id, s.status, (s.lease_bis>clock_timestamp() OR COALESCE(s.finalisierer_bis>clock_timestamp(),false)) AS lease_aktiv
         FROM asset_upload_teile t JOIN asset_upload_sitzungen s ON s.id=t.upload_id
        WHERE s.bereich='projekt' AND s.ziel_ref=$1 AND t.staging_id::text = ANY($2::text[])
       UNION ALL
       SELECT s.publish_operation->>'id' AS id, s.host_id, s.status, (s.lease_bis>clock_timestamp() OR COALESCE(s.finalisierer_bis>clock_timestamp(),false)) AS lease_aktiv
         FROM asset_upload_sitzungen s WHERE s.bereich='projekt' AND s.ziel_ref=$1 AND s.publish_operation->>'id' = ANY($2::text[])`,
      [project, teil])).rows;
    for (const r of rows) out.set(String(r.id), { herkunft: herkunftVonHost(r.host_id), status: String(r.status), lease_aktiv: r.lease_aktiv === true });
  }
  return out;
}

/** Zusammengesetzte Stagings (kein Teil, noch kein publish_operation) ueber ihr Journal (Pfad + SHA256) der Sitzung zuordnen. */
async function bezuegeUeberJournal(db: Db, project: string, b: string, ids: string[], bez: Map<string, Sitzungsbezug>, grenze: number): Promise<void> {
  const paare: Array<{ id: string; pfad: string; sha: string }> = [];
  for (const id of ids) {
    if (bez.has(id) || paare.length >= grenze) continue;
    try {
      const j = JSON.parse(await fs.readFile(path.join(b, 'journal', id + '.json'), 'utf8')) as { sha256?: string; adresse?: { logischer_pfad?: string } };
      if (j.adresse?.logischer_pfad && typeof j.sha256 === 'string' && /^[0-9a-f]{64}$/.test(j.sha256)) paare.push({ id, pfad: j.adresse.logischer_pfad, sha: j.sha256 });
    } catch { /* kein Journal */ }
  }
  for (let i = 0; i < paare.length; i += CHUNK) {
    const teil = paare.slice(i, i + CHUNK);
    const rows = (await db.query(
      `SELECT DISTINCT ON (logischer_pfad, sha256) logischer_pfad, sha256, host_id, status,
              (lease_bis>clock_timestamp() OR COALESCE(finalisierer_bis>clock_timestamp(),false)) AS lease_aktiv
         FROM asset_upload_sitzungen WHERE bereich='projekt' AND ziel_ref=$1
          AND (logischer_pfad, sha256) IN (SELECT * FROM unnest($2::text[], $3::text[]))
        ORDER BY logischer_pfad, sha256, created_at DESC`,
      [project, teil.map((p) => p.pfad), teil.map((p) => p.sha)])).rows;
    const m = new Map(rows.map((r) => [String(r.logischer_pfad) + '\u0000' + String(r.sha256), r]));
    for (const p of teil) {
      const r = m.get(p.pfad + '\u0000' + p.sha);
      if (r) bez.set(p.id, { herkunft: herkunftVonHost(r.host_id), status: String(r.status), lease_aktiv: r.lease_aktiv === true });
    }
  }
}

interface Ordnerstand { name: string; dateien: number; bytes: number; aelteste: string | null; neueste: string | null }
async function zaehle(dir: string, tiefe = 0): Promise<Omit<Ordnerstand, 'name'>> {
  const z = { dateien: 0, bytes: 0, aelteste: null as number | null, neueste: null as number | null };
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (tiefe < 4) { const s = await zaehle(p, tiefe + 1); z.dateien += s.dateien; z.bytes += s.bytes;
      if (s.aelteste) z.aelteste = Math.min(z.aelteste ?? Infinity, Date.parse(s.aelteste)); if (s.neueste) z.neueste = Math.max(z.neueste ?? 0, Date.parse(s.neueste)); } continue; }
    if (!e.isFile()) continue;
    const st = await fs.lstat(p); z.dateien++; z.bytes += st.size;
    z.aelteste = Math.min(z.aelteste ?? Infinity, st.mtimeMs); z.neueste = Math.max(z.neueste ?? 0, st.mtimeMs);
  }
  return { dateien: z.dateien, bytes: z.bytes, aelteste: z.aelteste === null ? null : new Date(z.aelteste).toISOString(), neueste: z.neueste === null ? null : new Date(z.neueste).toISOString() };
}

async function basis(project: string, cfg: AssetKonfiguration): Promise<string | null> {
  if (!PROJEKT.test(project)) throw new Error('Ungueltiger Projektname.');
  if (!cfg.speicher.root) return null;
  const root = await fs.realpath(cfg.speicher.root);
  const b = path.join(root, project, '.intern');
  try { const st = await fs.lstat(b); if (!st.isDirectory() || st.isSymbolicLink()) return null; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  if ((await fs.realpath(b)) !== b) return null;
  return b;
}

const leereHerkunft = () => ({ reverse_uebernehmen: { dateien: 0, bytes: 0 }, pc: { dateien: 0, bytes: 0 }, share: { dateien: 0, bytes: 0 }, user: { dateien: 0, bytes: 0 }, unbekannt: { dateien: 0, bytes: 0 } } as Record<InternHerkunft, { dateien: number; bytes: number }>);

export interface InternInventar {
  project: string; vorhanden: boolean; ordner: Ordnerstand[]; fremde_ordner: string[];
  staging: { dateien: number; bytes: number; nach_herkunft: Record<InternHerkunft, { dateien: number; bytes: number }> };
  journal: { dateien: number; tmp: number; nach_herkunft: Record<InternHerkunft, { dateien: number; bytes: number }>; status: Record<string, number>; geparst: number };
  revisionen: { dateien: number; bytes: number; nach_herkunft: Record<InternHerkunft, { dateien: number; bytes: number }> };
  sperre: { publish: string | null };
}

export async function inventarProjektIntern(project: string, o: { db?: Db; konfiguration?: AssetKonfiguration; journalLimit?: number } = {}): Promise<InternInventar> {
  const cfg = o.konfiguration ?? getAssetKonfiguration(), db = o.db ?? (getPool() as unknown as Db);
  const leer: InternInventar = { project, vorhanden: false, ordner: [], fremde_ordner: [], sperre: { publish: null },
    staging: { dateien: 0, bytes: 0, nach_herkunft: leereHerkunft() }, journal: { dateien: 0, tmp: 0, nach_herkunft: leereHerkunft(), status: {}, geparst: 0 },
    revisionen: { dateien: 0, bytes: 0, nach_herkunft: leereHerkunft() } };
  const b = await basis(project, cfg);
  if (!b) return leer;
  const inv: InternInventar = { ...leer, vorhanden: true };
  for (const e of await fs.readdir(b, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    inv.ordner.push({ name: e.name, ...(await zaehle(path.join(b, e.name))) });
    if (!BEKANNT.has(e.name)) inv.fremde_ordner.push(e.name);
  }
  try { inv.sperre.publish = (await fs.readFile(path.join(b, 'locks', 'publish'), 'utf8')).trim() || null; } catch { /* keine Sperre */ }
  const liste = async (sub: string) => { try { return await fs.readdir(path.join(b, sub)); } catch { return [] as string[]; } };
  const staging = (await liste('staging')).filter((n) => n.endsWith('.part'));
  const journal = await liste('journal');
  const revisionen = await liste('revisionen');
  const idVon = (n: string) => n.slice(0, 36);
  const ids = [...new Set([...staging, ...journal.filter((n) => n.endsWith('.json')), ...revisionen].map(idVon).filter((x) => ID.test(x)))];
  const grenze = o.journalLimit ?? 20000;
  const bez = await bezuege(db, project, ids);
  await bezuegeUeberJournal(db, project, b, ids, bez, grenze);
  const zuordnen = async (sub: string, n: string, ziel: Record<InternHerkunft, { dateien: number; bytes: number }>) => {
    const st = await fs.lstat(path.join(b, sub, n)).catch(() => null); if (!st?.isFile()) return 0;
    const h = bez.get(idVon(n))?.herkunft ?? 'unbekannt'; ziel[h].dateien++; ziel[h].bytes += st.size; return st.size;
  };
  for (const n of staging) { inv.staging.dateien++; inv.staging.bytes += await zuordnen('staging', n, inv.staging.nach_herkunft); }
  for (const n of revisionen) { inv.revisionen.dateien++; inv.revisionen.bytes += await zuordnen('revisionen', n, inv.revisionen.nach_herkunft); }
  for (const n of journal) {
    if (n.endsWith('.tmp')) { inv.journal.tmp++; continue; }
    if (!n.endsWith('.json')) continue;
    inv.journal.dateien++;
    await zuordnen('journal', n, inv.journal.nach_herkunft);
    if (inv.journal.geparst < grenze) {
      try { const j = JSON.parse(await fs.readFile(path.join(b, 'journal', n), 'utf8')) as { status?: string }; inv.journal.status[String(j.status)] = (inv.journal.status[String(j.status)] ?? 0) + 1; inv.journal.geparst++; } catch { /* unlesbar */ }
    }
  }
  return inv;
}

export interface AltbestandBericht { project: string; ausgefuehrt: boolean; staging: { dateien: number; bytes: number }; journal: { dateien: number }; beispiele: string[]; behalten_aktiv: number }

/** Reverse-Altbestand im Projekt-.intern (nur Herkunft reverse_uebernehmen, nur abgeschlossene Sitzungen). */
export async function raeumeReverseAltbestandAuf(project: string, o: { db?: Db; konfiguration?: AssetKonfiguration; ausfuehren?: boolean; bestaetigt?: boolean } = {}): Promise<AltbestandBericht> {
  const cfg = o.konfiguration ?? getAssetKonfiguration(), db = o.db ?? (getPool() as unknown as Db);
  const ausfuehren = o.ausfuehren === true && o.bestaetigt === true;
  const bericht: AltbestandBericht = { project, ausgefuehrt: ausfuehren, staging: { dateien: 0, bytes: 0 }, journal: { dateien: 0 }, beispiele: [], behalten_aktiv: 0 };
  const b = await basis(project, cfg);
  if (!b) return bericht;
  let sperre: string | null = null;
  try { sperre = (await fs.readFile(path.join(b, 'locks', 'publish'), 'utf8')).trim() || null; } catch { /* frei */ }
  const liste = async (sub: string) => { try { return await fs.readdir(path.join(b, sub)); } catch { return [] as string[]; } };
  const staging = (await liste('staging')).filter((n) => n.endsWith('.part') && ID.test(n.slice(0, 36)));
  const journal = (await liste('journal')).filter((n) => n.endsWith('.json') && ID.test(n.slice(0, 36)));
  const alleIds = [...new Set([...staging, ...journal].map((n) => n.slice(0, 36)))];
  const bez = await bezuege(db, project, alleIds);
  await bezuegeUeberJournal(db, project, b, alleIds, bez, Number.MAX_SAFE_INTEGER);
  const abgeschlossen = (x: Sitzungsbezug) => x.herkunft === 'reverse_uebernehmen' && (['finalisiert', 'fehler', 'abgebrochen'].includes(x.status) || !x.lease_aktiv);
  for (const n of staging) {
    const id = n.slice(0, 36), x = bez.get(id);
    if (!x || x.herkunft !== 'reverse_uebernehmen' || id === sperre) continue;
    if (!abgeschlossen(x)) { bericht.behalten_aktiv++; continue; }
    const p = path.join(b, 'staging', n), st = await fs.lstat(p).catch(() => null);
    if (!st?.isFile()) continue;
    bericht.staging.dateien++; bericht.staging.bytes += st.size; if (bericht.beispiele.length < 20) bericht.beispiele.push('staging/' + n);
    if (ausfuehren) await fs.unlink(p);
  }
  for (const n of journal) {
    const id = n.slice(0, 36), x = bez.get(id);
    if (!x || x.herkunft !== 'reverse_uebernehmen' || id === sperre || !abgeschlossen(x)) continue;
    const p = path.join(b, 'journal', n);
    let status = '';
    try { status = String((JSON.parse(await fs.readFile(p, 'utf8')) as { status?: string }).status); } catch { continue; }
    if (['prepared', 'published'].includes(status)) { bericht.behalten_aktiv++; continue; } // gehoert zur Recovery
    bericht.journal.dateien++; if (bericht.beispiele.length < 20) bericht.beispiele.push('journal/' + n);
    if (ausfuehren) await fs.unlink(p);
  }
  return bericht;
}

export async function leseAssetInternAufraeumenSchalter(project: string): Promise<{ aktiv: boolean; quelle: string; letzter_fehler: string | null }> {
  const p = await leseProfilProduktSchalterGepuffert(ASSET_INTERN_AUFRAEUMEN, project);
  return { aktiv: p.aktiv && !p.letzter_fehler, quelle: p.quelle, letzter_fehler: p.letzter_fehler };
}
