/**
 * Gemeinsamer Datei-Steckbrief fuer stdio-MCP und REST.
 * Der gespeicherte Text bleibt unveraendert; Struktur und Veraltung kommen frisch aus code_intel.
 */
import { createHash } from 'node:crypto';
import { getEntrypoints, getFunctions } from './code-intel.js';
import { getFileContentFromPg } from './code-write.js';
import { getFileVersion, listFileVersions, versionsDiff } from './file-versions.js';
import { getMemoryByName } from './memory.js';

export async function getFileSteckbrief(project: string, filePath: string): Promise<Record<string, unknown>> {
  const name = `steckbrief-${filePath.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const [memory, aktuellerInhalt, funktionenRoh, einstiegspunkteRoh] = await Promise.all([
    getMemoryByName(project, name),
    getFileContentFromPg(project, filePath),
    getFunctions(project, filePath, undefined, true),
    getEntrypoints(project, filePath, 30, false),
  ]);
  const funktionen = funktionenRoh.filter((fn) => fn.file_path === filePath);
  const einstiegspunkte = einstiegspunkteRoh.filter((entry) => entry.file_path === filePath);
  const struktur = {
    datei_hash: aktuellerInhalt === null ? null : createHash('sha256').update(aktuellerInhalt).digest('hex'),
    funktionen_gesamt: funktionen.length,
    funktionen: funktionen.slice(0, 80).map(({ name: funktionsname, line_start, line_end }) => ({
      name: funktionsname, zeile: line_start, ende: line_end,
    })),
    ...(funktionen.length > 80 ? { funktionen_gekappt: true } : {}),
    einstiegspunkte: einstiegspunkte.map(({ line_start, statement_type, callee, text }) => ({
      zeile: line_start, art: statement_type, aufruf: callee, text: text?.slice(0, 200) ?? null,
    })),
  };

  if (!memory || aktuellerInhalt === null) {
    return {
      name,
      inhalt: null,
      möglicherweise_veraltet: false,
      hinweis: memory ? 'Datei nicht im Code-Index gefunden.' : 'Kein Steckbrief gespeichert; Erstellung nur auf Koordinatorauftrag.',
      struktur,
    };
  }

  const metaZeile = memory.content.match(/^<!-- synapse-steckbrief:(\{.*\}) -->\r?\n?/);
  let meta: { datei_hash?: string; file_version_id?: string | null; funktionen?: string[] } = {};
  try { if (metaZeile) meta = JSON.parse(metaZeile[1]) as typeof meta; } catch { /* Unlesbare Metadaten gelten beim Hashvergleich als unbekannt. */ }
  const inhalt = metaZeile ? memory.content.slice(metaZeile[0].length).trim() : memory.content.trim();
  const aktuellerHash = struktur.datei_hash as string;
  let zeilenAnteil: number | undefined;
  let funktionsAnteil: number | undefined;
  let möglicherweiseVeraltet = false;
  if (meta.datei_hash !== aktuellerHash) {
    const baselineId = meta.file_version_id && /^\d+$/.test(meta.file_version_id) ? BigInt(meta.file_version_id) : null;
    if (baselineId !== null) {
      const versionen = await listFileVersions(project, filePath, 500);
      const ersteAenderung = versionen.reduce((frueheste, version) => {
        const id = BigInt(version.id);
        return id > baselineId && (!frueheste || id < BigInt(frueheste.id)) ? version : frueheste;
      }, undefined as (typeof versionen)[number] | undefined);
      const basis = ersteAenderung ? await getFileVersion(ersteAenderung.id, false, { roh: true }) : null;
      if (basis) {
        const diff = versionsDiff(basis.content, aktuellerInhalt, 0);
        const basisZeilen = basis.content.split('\n').length;
        const aktuelleZeilen = aktuellerInhalt.split('\n').length;
        zeilenAnteil = (diff.plus + diff.minus) / Math.max(1, basisZeilen + aktuelleZeilen);
      }
    }
    if (Array.isArray(meta.funktionen)) {
      const alteNamen = new Set(meta.funktionen);
      const neueNamen = new Set(funktionen.map((fn) => fn.name));
      const betroffen = [...alteNamen].filter((n) => !neueNamen.has(n)).length + [...neueNamen].filter((n) => !alteNamen.has(n)).length;
      funktionsAnteil = betroffen / Math.max(1, alteNamen.size + neueNamen.size);
    }
    möglicherweiseVeraltet = zeilenAnteil === undefined || zeilenAnteil > 0.2 || (funktionsAnteil !== undefined && funktionsAnteil > 0.2);
  }
  return {
    name,
    inhalt,
    link: { action: 'read', project, name },
    datei_hash: meta.datei_hash ?? null,
    hash_aktuell: aktuellerHash,
    möglicherweise_veraltet: möglicherweiseVeraltet,
    ...(zeilenAnteil !== undefined ? { aenderungsanteil_zeilen: zeilenAnteil } : {}),
    ...(funktionsAnteil !== undefined ? { aenderungsanteil_funktionen: funktionsAnteil } : {}),
    ...(möglicherweiseVeraltet ? { hinweis: 'Datei hat sich stark geändert; Steckbrief möglicherweise veraltet.' } : {}),
    struktur,
  };
}
