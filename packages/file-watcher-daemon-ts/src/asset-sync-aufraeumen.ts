/**
 * P22-T240 (d): Aufraeumen des Asset-Sync-Zustandsordners <projekt>/.synapse/asset-sync nach der Download-Schleife
 * (bis 31.10.2026: 317k pc-before-install-<auftrag>, 103 GB; dazu leere download-<uuid> und alte *.json.<uuid>.tmp).
 *
 * STANDARD = VORSCHAU (nichts wird geloescht). Ausfuehren nur mit ausfuehren:true UND bestaetigt:true (USER-FREIGABE, Route
 * POST /projects/:name/asset-sync/aufraeumen nur lokal). Entfernt NUR:
 *  - pc-before-install-*, deren Inhalt GLEICH einer aktuellen PC-Datei des Projekts ist (gleicher Inode oder gleicher SHA256 einer
 *    bekannten bzw. per Auftrag referenzierten Datei) -> 'gleich_pc';
 *  - weitere Kopien desselben Inhalts unter den uebrigen Sicherungen (je Inhalt bleibt genau eine) -> 'doppelt';
 *  - download-<uuid> ohne laufenden/offenen Auftrag -> 'temp_download';
 *  - <zustand>.json.<uuid>.tmp aelter als tmpAlterMs -> 'temp_zustand'.
 * NIE: die Zustandsdatei selbst, deleted-*, Sicherungen mit einmaligem Inhalt (bleiben als PC-Fassung erhalten).
 * Freigegebene Bytes werden nur gezaehlt, wenn die Datei der letzte Link ihres Inodes ist (nlink 1).
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type AufraeumArt = 'gleich_pc' | 'doppelt' | 'temp_download' | 'temp_zustand';
export interface AufraeumBericht {
  ausgefuehrt: boolean;
  geprueft: number;
  behalten: number;
  /** je Art: Anzahl, Bytes (nur letzter Link), Beispiele. */
  arten: Record<AufraeumArt, { anzahl: number; bytes: number; beispiele: string[] }>;
  fehler: Array<{ datei: string; fehler: string }>;
  /** true = limit erreicht, weiterer Lauf noetig. */
  weiter: boolean;
}
export interface AufraeumOptionen {
  dir: string;
  root: string;
  /** Projektpfade, deren aktuelle PC-Datei als Vergleich dient (bekannte Assets + Pfade offener Auftraege). */
  pfade: string[];
  /** IDs offener Auftraege (download-<id> bleibt). */
  aktiveJobIds: Set<string>;
  ausfuehren?: boolean;
  bestaetigt?: boolean;
  tmpAlterMs?: number;
  limit?: number;
  jetzt?: number;
}

async function sha256Datei(p: string): Promise<string> {
  const h = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const hash = createHash('sha256'); for await (const b of h.createReadStream({ autoClose: false })) hash.update(b); return hash.digest('hex'); }
  finally { await h.close(); }
}
const leer = () => ({ anzahl: 0, bytes: 0, beispiele: [] as string[] });

export async function raeumeAssetSyncAuf(o: AufraeumOptionen): Promise<AufraeumBericht> {
  const ausfuehren = o.ausfuehren === true && o.bestaetigt === true;
  const tmpAlter = o.tmpAlterMs ?? 3_600_000, jetzt = o.jetzt ?? Date.now(), limit = o.limit ?? Number.MAX_SAFE_INTEGER;
  const bericht: AufraeumBericht = { ausgefuehrt: ausfuehren, geprueft: 0, behalten: 0,
    arten: { gleich_pc: leer(), doppelt: leer(), temp_download: leer(), temp_zustand: leer() }, fehler: [], weiter: false };
  // Vergleichsbasis: aktuelle PC-Dateien (Inode und Hash).
  const pcInodes = new Set<string>(), pcHashes = new Set<string>();
  for (const rel of new Set(o.pfade)) {
    const abs = path.join(o.root, rel);
    if (!path.resolve(abs).startsWith(path.resolve(o.root) + path.sep)) continue;
    try {
      const st = await fs.lstat(abs);
      if (!st.isFile()) continue;
      pcInodes.add(st.dev + ':' + st.ino); pcHashes.add(await sha256Datei(abs));
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bericht.fehler.push({ datei: rel, fehler: (e as Error).message }); }
  }
  const gesehen = new Set<string>();
  const namen = (await fs.readdir(o.dir)).sort(); // sortiert: pc-before-install-<sha> (dedupliziert) bleibt vor Auftrags-Namen erhalten
  // Bereits deduplizierte Sicherungen (Name = Hash) zuerst als vorhanden merken.
  for (const n of namen) { const m = /^pc-before-install-([a-f0-9]{64})$/.exec(n); if (m) gesehen.add(m[1]); }
  const weg = async (n: string, art: AufraeumArt, st: { nlink: number; size: number }) => {
    const a = bericht.arten[art]; a.anzahl++; if (st.nlink <= 1) a.bytes += st.size; if (a.beispiele.length < 20) a.beispiele.push(n);
    if (ausfuehren) await fs.unlink(path.join(o.dir, n));
  };
  for (const n of namen) {
    if (bericht.geprueft >= limit) { bericht.weiter = true; break; }
    const p = path.join(o.dir, n);
    try {
      const st = await fs.lstat(p);
      if (!st.isFile()) continue;
      if (n.startsWith('pc-before-install-')) {
        bericht.geprueft++;
        const eigenerHash = /^pc-before-install-([a-f0-9]{64})$/.exec(n)?.[1];
        if (pcInodes.has(st.dev + ':' + st.ino)) { await weg(n, 'gleich_pc', st); continue; }
        const sha = eigenerHash ?? await sha256Datei(p);
        if (pcHashes.has(sha)) { await weg(n, 'gleich_pc', st); continue; }
        if (eigenerHash) { bericht.behalten++; continue; } // die eine dedupliziere Kopie dieses Inhalts
        if (gesehen.has(sha)) { await weg(n, 'doppelt', st); continue; }
        gesehen.add(sha); bericht.behalten++; continue;
      }
      const dl = /^download-([0-9a-f-]{36})$/i.exec(n);
      if (dl) { bericht.geprueft++; if (o.aktiveJobIds.has(dl[1])) bericht.behalten++; else await weg(n, 'temp_download', st); continue; }
      if (/\.json\.[0-9a-f-]{36}\.tmp$/i.test(n)) {
        bericht.geprueft++;
        if (jetzt - st.mtimeMs > tmpAlter) await weg(n, 'temp_zustand', st); else bericht.behalten++;
      }
    } catch (e) { bericht.fehler.push({ datei: n, fehler: (e as Error).message }); }
  }
  return bericht;
}
