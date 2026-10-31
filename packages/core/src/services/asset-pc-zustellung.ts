/**
 * P22-T237 (USER-GRUNDSATZ 31.10.2026, thought 4d6e67d6, Grundsatz 2): Kommt ein Projekt-Asset ueber die API in den Share,
 * waehrend kein Tray-Daemon des Projekt-PCs laeuft, bleibt es im Share (sichtbar, oeffenbar). Sobald der Daemon wieder online
 * ist, holt er es in den Projektordner.
 *
 * BESTAND (nicht neu gebaut): Den Transport Share -> PC macht der Daemon seit P13-T26/A8 (file-watcher-daemon-ts asset-sync.ts:
 *   beim Start Verhandlung + Manifest/Delta ab bestaetigtem Cursor, danach alle scanMs; Konflikte nach P13-T29).
 * NEU (diese Datei): Die API sieht, ob ein Asset auf dem PC angekommen ist, und meldet klar, warum nicht.
 *   - Der Daemon meldet nach jedem Abgleich seinen bestaetigten Stand (Commit-Wasserlinie asset_aenderungsstaende) per
 *     POST /api/projects/:p/assets/pc-stand -> asset_host_checkpoints (A2, bisher ungenutzt) + offene_downloads/letzter_fehler.
 *   - Der Heartbeat traegt den Tray-Schalter Asset-Sync je Projekt mit (daemon_heartbeats.asset_sync_aktiv; NULL = aelterer Daemon).
 *   - assetPcZustellung(): Status je Projekt bzw. Asset mit Hinweistext: auf_pc | unterwegs | wartet_auf_daemon | asset_sync_aus |
 *     kein_pc | richtung_ohne_pc | nicht_im_share. Ausstehende Assets (Stand > PC-Stand) mit Pfad.
 *
 * SCHALTER (regel-neue-funktionen-mit-schalter-und-debug):
 *   (I) Produkt-Schalter 'asset_pc_zustellung' (agent_profil_schalter, projekt > global, Standard AUS, nur ausdruecklich).
 *   (II) intern-Override gleichen Namens (modus 'freigegeben', nur SYNAPSE_INTERN_TOOL=1, befristet).
 *   AUS / Lesefehler = Altverhalten: pc-stand wird angenommen, aber nicht gespeichert; keine pc_zustellung in Antworten.
 * DEBUG: GET /api/projects/:p/assets/pc-zustellung zeigt Schalter (quelle, bis, letzter_fehler), Hosts mit Stand/Meldezeit/
 *   offenen Downloads/letztem Fehler, Heartbeat (online, asset_sync_aktiv), Projektstand, Frische-Fenster und ausstehende Assets.
 * EINSTELLWERTE: kein eigener Wert. Frische-Fenster = 2 x scanIntervallMs + retryIntervallMs aus der Asset-Konfiguration,
 *   Heartbeat-Fenster = DAEMON_HEARTBEAT_ALIVE_SEC (dieselbe Lesestelle wie das shell-Routing).
 */
import { getPool } from '../db/client.js';
import { getAssetKonfiguration, loeseAssetProjektoptionen } from '../config/asset-konfig.js';
import type { AssetKonfiguration, AssetSyncRichtung } from '../config/asset-konfig.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { leseProfilProduktSchalterGepuffert } from './agent-profil-schalter.js';
import { AssetUploadFehler } from './asset-upload.js';
import type { AssetUploadDb, AssetUploadKontext } from './asset-upload.js';
import { DAEMON_HEARTBEAT_ALIVE_SEC } from './daemon-heartbeat.js';

export const ASSET_PC_ZUSTELLUNG = 'asset_pc_zustellung' as const;
type Db = Pick<AssetUploadDb, 'query'>;
const STAND = /^(0|[1-9][0-9]*)$/;
const FEHLER_MAX = 500;

export interface AssetPcZustellungSchalter {
  aktiv: boolean;
  quelle: 'standard' | 'produkt-schalter' | 'intern';
  ebene: 'global' | 'projekt' | null;
  bis: string | null;
  letzter_fehler: string | null;
}

/** Eine Lesestelle des Schalters (Produkt-Schalter gepuffert, intern-Override nur mit aktivem intern-Tool). Wirft nie. */
export async function leseAssetPcZustellungSchalter(project: string | null): Promise<AssetPcZustellungSchalter> {
  const p = await leseProfilProduktSchalterGepuffert(ASSET_PC_ZUSTELLUNG, project);
  const stand: AssetPcZustellungSchalter = {
    aktiv: p.aktiv && !p.letzter_fehler, quelle: p.quelle, ebene: p.ebene, bis: null, letzter_fehler: p.letzter_fehler,
  };
  if (!internToolAktiv()) return stand;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: "SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())",
      values: [ASSET_PC_ZUSTELLUNG],
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    if (z) return { ...stand, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? new Date(z.bis).toISOString() : null, letzter_fehler: null };
  } catch {
    return { ...stand, letzter_fehler: stand.letzter_fehler ?? 'intern_schalter_nicht_lesbar' };
  }
  return stand;
}

export type PcZustellStatus =
  | 'auf_pc' | 'unterwegs' | 'wartet_auf_daemon' | 'asset_sync_aus' | 'kein_pc' | 'richtung_ohne_pc' | 'nicht_im_share';

export interface PcHostStand {
  host_id: string;
  stand: string;
  offene_downloads: number;
  letzter_fehler: string | null;
  gemeldet_at: string | null;
}
export interface PcHeartbeat {
  hostname: string;
  online: boolean;
  last_seen: string | null;
  /** Tray-Schalter Asset-Sync laut Heartbeat; null = aelterer Daemon ohne Angabe. */
  asset_sync_aktiv: boolean | null;
}
export interface PcZustellungBewertung {
  status: PcZustellStatus;
  hinweis: string;
  /** Host mit dem hoechsten bestaetigten Stand (Grundlage der Bewertung) oder null. */
  host: string | null;
}

export interface PcZustellungEingabe {
  project: string;
  richtung: AssetSyncRichtung;
  /** Stand der letzten Share-Aenderung (Asset bzw. Projekt); null = Asset nie im Share. */
  ziel_stand: bigint | null;
  hosts: PcHostStand[];
  heartbeat: PcHeartbeat | null;
  frisch_ms: number;
  scan_ms: number;
  jetzt: number;
  /** Text fuer das Objekt: 'Das Asset' bzw. 'Neue Share-Assets'. */
  objekt?: string;
}

const zeit = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : 'nie');

/** Reine Bewertung (ohne DB), damit jeder Fall einzeln pruefbar ist. */
export function bewertePcZustellung(e: PcZustellungEingabe): PcZustellungBewertung {
  const obj = e.objekt ?? 'Das Asset';
  const bleibt = `${obj} bleibt im Projekt-Share (sichtbar und öffenbar)`;
  if (e.ziel_stand === null) {
    return { status: 'nicht_im_share', host: null,
      hinweis: `${obj} liegt nicht im Share (nur Metadaten der lokalen PC-Inspektion), deshalb gibt es keine Übertragung in den Projektordner.` };
  }
  if (e.richtung === 'pc_to_share') {
    return { status: 'richtung_ohne_pc', host: null,
      hinweis: `${bleibt}. Projekt ${e.project} hat die Sync-Richtung pc_to_share: Share-Assets werden nie in den Projektordner übertragen.` };
  }
  const hb = e.heartbeat;
  if (hb?.online && hb.asset_sync_aktiv === false) {
    return { status: 'asset_sync_aus', host: null,
      hinweis: `${bleibt}. Der Daemon auf ${hb.hostname} läuft, aber Asset-Sync ist für Projekt ${e.project} im Tray AUS. ` +
        'In den Projektordner kommt es erst nach dem Einschalten (Tray: Projekt > Asset-Sync).' };
  }
  const best = [...e.hosts].sort((a, b) => (BigInt(b.stand) > BigInt(a.stand) ? 1 : BigInt(b.stand) < BigInt(a.stand) ? -1 : 0))[0];
  if (best && BigInt(best.stand) >= e.ziel_stand) {
    return { status: 'auf_pc', host: best.host_id,
      hinweis: `${obj} ist im Projektordner angekommen (Daemon-Stand ${best.stand} ≥ ${e.ziel_stand}, Meldung ${zeit(best.gemeldet_at)}).` };
  }
  const frisch = best?.gemeldet_at ? e.jetzt - Date.parse(best.gemeldet_at) <= e.frisch_ms : false;
  const fehler = best?.letzter_fehler ? ` Letzter Fehler des Abgleichs: ${best.letzter_fehler}` : '';
  if (!best) {
    if (hb?.online && hb.asset_sync_aktiv === true) {
      return { status: 'unterwegs', host: null,
        hinweis: `${bleibt}. Der Daemon auf ${hb.hostname} läuft mit Asset-Sync AN; die erste Abgleichsmeldung steht noch aus (Abgleich alle ${Math.round(e.scan_ms / 1000)} s).` };
    }
    return { status: 'kein_pc', host: null,
      hinweis: `${bleibt}. Für Projekt ${e.project} hat noch kein PC-Daemon Asset-Sync gemeldet` +
        (hb?.online ? ` (Daemon auf ${hb.hostname} läuft, meldet aber keinen Asset-Sync – älterer Daemon oder Asset-Sync AUS)` : '') +
        '. In den Projektordner kommt es, sobald ein Daemon mit eingeschaltetem Asset-Sync (Tray: Projekt > Asset-Sync) läuft.' };
  }
  if (hb?.online || frisch) {
    return { status: 'unterwegs', host: best.host_id,
      hinweis: `${bleibt} und wird beim nächsten Abgleich in den Projektordner übertragen (Daemon online, Stand ${best.stand} < ${e.ziel_stand}, ` +
        `Abgleich alle ${Math.round(e.scan_ms / 1000)} s${best.offene_downloads ? `, ${best.offene_downloads} Download(s) offen` : ''}).${fehler}` };
  }
  return { status: 'wartet_auf_daemon', host: best.host_id,
    hinweis: `${bleibt}. Kein Daemon des Projekt-PCs online (letzte Meldung ${zeit(best.gemeldet_at)}); die Übertragung in den Projektordner ` +
      `startet automatisch, sobald der Daemon wieder läuft.${fehler}` };
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? new Date(v).toISOString() : null);

async function projektStand(db: Db, project: string): Promise<bigint> {
  const r = await db.query('SELECT stand::text AS stand FROM asset_aenderungsstaende WHERE project=$1', [project]);
  return BigInt(String(r.rows[0]?.stand ?? '0'));
}

/**
 * Daemon-Meldung nach einem Abgleich (Route POST .../assets/pc-stand, nur Daemon-Identitaet). Schalter AUS -> angenommen,
 * nicht gespeichert (gespeichert:false, grund schalter_aus). stand muss eine gueltige Wasserlinie <= Projektstand sein.
 */
export async function meldeAssetPcStand(ctx: AssetUploadKontext, eingang: Record<string, unknown>, o: { db?: Db; schalter?: AssetPcZustellungSchalter } = {}) {
  if (ctx.bereich !== 'projekt') throw new AssetUploadFehler('scope_verboten', 403, 'Nur Projekt-Assets.');
  const stand = eingang.stand, offen = eingang.offene_downloads ?? 0, fehler = eingang.letzter_fehler ?? null;
  if (typeof stand !== 'string' || !STAND.test(stand)) throw new AssetUploadFehler('eingang_ungueltig', 400, 'stand (Wasserlinie als Zahltext) erforderlich.');
  if (!Number.isSafeInteger(offen) || (offen as number) < 0 || (offen as number) > 1_000_000) throw new AssetUploadFehler('eingang_ungueltig', 400, 'offene_downloads ungültig.');
  if (fehler !== null && typeof fehler !== 'string') throw new AssetUploadFehler('eingang_ungueltig', 400, 'letzter_fehler muss Text oder null sein.');
  const schalter = o.schalter ?? await leseAssetPcZustellungSchalter(ctx.ziel_ref);
  if (!schalter.aktiv) return { gespeichert: false, grund: 'schalter_aus', schalter };
  const db = o.db ?? (getPool() as unknown as Db);
  const oben = await projektStand(db, ctx.ziel_ref);
  if (BigInt(stand) > oben) throw new AssetUploadFehler('cursor_ungueltig', 409, 'Gemeldeter Stand liegt vor dem Projektstand.');
  const text = fehler === null ? null : String(fehler).replace(/\s+/g, ' ').trim().slice(0, FEHLER_MAX) || null;
  await db.query(
    `INSERT INTO asset_host_checkpoints(host_id,project,stand,offene_downloads,letzter_fehler,updated_at) VALUES($1,$2,$3,$4,$5,NOW())
     ON CONFLICT(host_id,project) DO UPDATE SET stand=EXCLUDED.stand,offene_downloads=EXCLUDED.offene_downloads,
       letzter_fehler=EXCLUDED.letzter_fehler,updated_at=NOW()`,
    [ctx.host_id, ctx.ziel_ref, stand, offen, text]);
  return { gespeichert: true, stand, projekt_stand: oben.toString(), schalter };
}

/** Heartbeat-Zusatz: Tray-Schalter Asset-Sync je Projekt dieses Hosts (nur Telemetrie, kein Verhalten). */
export async function meldeAssetSyncImHeartbeat(project: string, hostname: string, aktiv: boolean, o: { db?: Db } = {}): Promise<void> {
  const db = o.db ?? (getPool() as unknown as Db);
  await db.query('UPDATE daemon_heartbeats SET asset_sync_aktiv=$3 WHERE project=$1 AND hostname=$2', [project, hostname, aktiv]);
}

export interface AssetPcZustellungOptionen {
  asset_id?: string;
  limit?: number;
  db?: Db;
  konfiguration?: AssetKonfiguration;
  schalter?: AssetPcZustellungSchalter;
  jetzt?: number;
}

/** Status je Projekt (ohne asset_id) bzw. je Asset; Schalter AUS -> nur der Schalterstand. */
export async function assetPcZustellung(project: string, o: AssetPcZustellungOptionen = {}) {
  const schalter = o.schalter ?? await leseAssetPcZustellungSchalter(project);
  if (!schalter.aktiv) return { aktiv: false as const, schalter };
  const db = o.db ?? (getPool() as unknown as Db), cfg = o.konfiguration ?? getAssetKonfiguration();
  const limit = o.limit === undefined ? 20 : o.limit;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 500) throw new AssetUploadFehler('limit_ungueltig', 400, 'limit 0..500.');
  if (o.asset_id !== undefined && !/^[1-9][0-9]*$/.test(o.asset_id)) throw new AssetUploadFehler('eingang_ungueltig', 400, 'asset_id ungültig.');
  const opt = (await db.query('SELECT richtung FROM asset_projekt_optionen WHERE project=$1', [project])).rows[0];
  const richtung = loeseAssetProjektoptionen(cfg, opt?.richtung ? { richtung: opt.richtung as AssetSyncRichtung } : {}).richtung;
  const hosts: PcHostStand[] = (await db.query(
    'SELECT host_id,stand::text AS stand,offene_downloads,letzter_fehler,updated_at FROM asset_host_checkpoints WHERE project=$1 ORDER BY stand DESC,host_id',
    [project])).rows.map(r => ({ host_id: String(r.host_id), stand: String(r.stand), offene_downloads: Number(r.offene_downloads ?? 0),
    letzter_fehler: (r.letzter_fehler as string | null) ?? null, gemeldet_at: iso(r.updated_at) }));
  const hbRow = (await db.query(
    `SELECT hostname,last_seen,asset_sync_aktiv,(last_seen > NOW() - ($2 || ' seconds')::interval) AS online FROM daemon_heartbeats WHERE project=$1`,
    [project, DAEMON_HEARTBEAT_ALIVE_SEC])).rows[0];
  const heartbeat: PcHeartbeat | null = hbRow ? { hostname: String(hbRow.hostname), online: hbRow.online === true, last_seen: iso(hbRow.last_seen),
    asset_sync_aktiv: typeof hbRow.asset_sync_aktiv === 'boolean' ? hbRow.asset_sync_aktiv : null } : null;
  const stand = await projektStand(db, project);
  const scan_ms = cfg.sync.scanIntervallMs, frisch_ms = 2 * cfg.sync.scanIntervallMs + cfg.sync.retryIntervallMs, jetzt = o.jetzt ?? Date.now();
  const basis = { project, richtung, hosts, heartbeat, frisch_ms, scan_ms, jetzt };
  const projekt = bewertePcZustellung({ ...basis, ziel_stand: stand, objekt: 'Neue Share-Assets' });
  const pcStand = hosts[0] ? BigInt(hosts[0].stand) : 0n;
  const ausstehend = (await db.query(
    `SELECT c.asset_id::text AS asset_id,a.file_path,max(c.stand)::text AS stand,count(*) OVER()::int AS gesamt FROM asset_aenderungen c
      JOIN asset_files a ON a.id=c.asset_id WHERE c.project=$1 AND c.stand>$2 GROUP BY c.asset_id,a.file_path ORDER BY max(c.stand) LIMIT $3`,
    [project, pcStand.toString(), Math.max(limit, 1)])).rows;
  const ergebnis = {
    aktiv: true as const, schalter, ...projekt, projekt_stand: stand.toString(), richtung, hosts, heartbeat,
    frische_fenster_ms: frisch_ms,
    ausstehend: { anzahl: Number(ausstehend[0]?.gesamt ?? 0), pfade: limit === 0 ? [] : ausstehend.map(r => ({ asset_id: String(r.asset_id), pfad: String(r.file_path), stand: String(r.stand) })) },
  };
  if (o.asset_id === undefined) return ergebnis;
  const a = (await db.query(
    `SELECT a.id::text AS asset_id,a.file_path,a.storage_status,a.deleted_at,(SELECT max(stand)::text FROM asset_aenderungen c WHERE c.project=$1 AND c.asset_id=a.id) AS stand
       FROM asset_files a WHERE a.project=$1 AND a.id=$2`, [project, o.asset_id])).rows[0];
  if (!a) throw new AssetUploadFehler('asset_fehlt', 404, 'Asset im Projekt fehlt.');
  const zielStand = a.stand === null || a.stand === undefined ? null : BigInt(String(a.stand));
  const asset = bewertePcZustellung({ ...basis, ziel_stand: zielStand, objekt: a.deleted_at ? 'Die Löschung des Assets' : 'Das Asset' });
  return { ...ergebnis, asset: { asset_id: String(a.asset_id), pfad: String(a.file_path), storage_status: String(a.storage_status),
    stand: zielStand?.toString() ?? null, ...asset } };
}

/** Kurzform fuer Tool-Antworten (reverse uebernehmen, spaeter asset_intel): null bei Schalter AUS oder Lesefehler. Wirft nie. */
export async function pcZustellungFuerAsset(project: string, asset_id: string, o: Omit<AssetPcZustellungOptionen, 'asset_id' | 'limit'> = {}) {
  try {
    const r = await assetPcZustellung(project, { ...o, asset_id, limit: 0 });
    if (!r.aktiv || !('asset' in r) || !r.asset) return null;
    return { status: r.asset.status, hinweis: r.asset.hinweis };
  } catch { return null; }
}
