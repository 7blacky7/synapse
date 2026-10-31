/**
 * MODUL: intern asset_altbestand_bereinigen (P22-T236, 31.10.2026)
 * ZWECK: Altbestand der Projekt-Assets an 'Index = Wirklichkeit' angleichen (asset-altbestand.ts pruefeAssetAltbestand):
 *        verwaiste Eintraege ohne Datei (quelle_nicht_gefunden) und Textdateien doppelt im Asset-Index (SVG u. a.).
 * ABLAUF: ohne ausfuehren:true nur Vorschau (Zaehlung, Beispiele). ausfuehren:true nur Koordinator/User, nur mit project
 *         und Produkt-Schalter asset_index_wirklichkeit EIN; limit je Aufruf (Standard 1000, max 10000).
 * NICHT UMKEHRBAR: entfernte Metadaten-Zeilen sind weg (die Dateien selbst gibt es nicht bzw. sie stehen im Code-Index).
 */
import { pruefeAssetAltbestand } from './asset-altbestand.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';

export const ASSET_ALT_ACTIONS = ['asset_altbestand_bereinigen'] as const;
export type AssetAltAction = (typeof ASSET_ALT_ACTIONS)[number];

export function istAssetAltAction(action: string): action is AssetAltAction {
  return (ASSET_ALT_ACTIONS as readonly string[]).includes(action);
}

export const ASSET_ALT_BESCHREIBUNG =
  'ASSET-ALTBESTAND: asset_altbestand_bereinigen (project, ausfuehren, limit): Projekt-Asset-Eintraege ohne Datei (quelle_nicht_gefunden) ' +
  'und Textdateien doppelt im Asset-Index (z. B. SVG neben dem Code-Index) finden; ohne ausfuehren:true nur Vorschau, ausfuehren:true nur ' +
  'Koordinator/User, mit project und Produkt-Schalter asset_index_wirklichkeit, entfernt nur Metadaten ohne Share-Bytes. ';

/** Dispatcher-Anteil. Wirft nie. */
export async function fuehreAssetAltAus(action: AssetAltAction, a: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  try {
    const ausfuehren = a.ausfuehren === true || a.ausfuehren === 'true';
    if (ausfuehren && !darfKoordinatorOderUser(agentId)) {
      return { success: false, action, error: 'nicht_erlaubt', message: 'ausfuehren:true nur fuer Koordinator oder User. Vorschau ist fuer alle erlaubt.' };
    }
    const project = typeof a.project === 'string' && a.project.trim() !== '' ? a.project.trim() : undefined;
    const limitRoh = typeof a.limit === 'number' ? a.limit : typeof a.limit === 'string' ? Number(a.limit) : undefined;
    const limit = limitRoh !== undefined && Number.isFinite(limitRoh) && limitRoh > 0 ? limitRoh : undefined;
    return { action, ...(await pruefeAssetAltbestand({ project, ausfuehren, limit })) };
  } catch (e) {
    return { success: false, action, error: 'fehler', message: (e as Error).message };
  }
}
