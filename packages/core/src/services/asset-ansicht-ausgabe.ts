/**
 * P13-T34/A16: Ansicht über PARAMETER an bestehenden Abfragen (kein eigenes Tool).
 *
 *   asset_intel(action:'inspect', file_path, ansicht:'inline'|'link'|'beides', offen_sekunden?, einmalig?)
 *   code_intel(action:'file', file_path auf ein Asset, ansicht…)            (nur REST; stdio leitet an die API)
 *
 * inline -> A14 gemeinsamerAnsichtDienst().ansichten([ref]) (Bildbudget A4: Anzahl + Gesamtbytes),
 *           Ergebnis als MCP-Bildblock {type:'image', mimeType, data} NACH dem Textteil.
 * link   -> A15 standardAnsichtLinkDienst().erzeugen(...) (Timer, einmalig; art original für Audio und
 *           Formate ohne freigegebenen Vorschau-Renderer).
 *
 * TRANSPORT: Die Base64-Daten hängen NICHT als Feld an der Antwort, sondern unter einem nicht aufzählbaren
 *   Symbol (setzeMcpBilder). JSON.stringify, Objekt-Spreads, kappeAntwort, Activity-Log und structuredContent
 *   sehen sie nie. Der REST-Handler trennt sie direkt nach dem Tool-Aufruf ab (trenneMcpBilder) und hängt sie
 *   nach baueToolErgebnis als eigene content-Blöcke an (haengeMcpBilderAn). Hinweise bleiben im Textteil.
 * OHNE ansicht-Parameter: keine Abfrage, kein Rendern, kein Token; die Antwort ist dasselbe Objekt wie vorher.
 * Auth: nur aus geschützten Tool-Aufrufen der API (apiAusfuehrung); Projekt muss freigegeben sein.
 */
import { getPool } from '../db/client.js';
import { getAssetKonfiguration } from '../config/asset-konfig.js';
import { gemeinsamerAnsichtDienst, standardAnsichtLinkDienst, type AnsichtLinkEingang, type AnsichtLinkErzeugung } from './asset-ansicht-link.js';
import type { AssetAnsichtErgebnis, AssetAnsichtReferenz } from './asset-ansicht.js';
import { isProjectEnabled } from './project-registry.js';

export const ANSICHT_MODI = ['inline', 'link', 'beides'] as const;
export type AnsichtModus = (typeof ANSICHT_MODI)[number];
/** Die drei Parameter; LINK_PARAMETER wirken nur mit link|beides. */
export const ANSICHT_PARAMETER = ['ansicht', 'offen_sekunden', 'einmalig'] as const;
const LINK_PARAMETER = ['offen_sekunden', 'einmalig'] as const;

/** Schema-Ergänzung (asset_intel aus core, code_intel REST + stdio). Kurz halten: asset_intel-Budget 4.800 Zeichen. */
export const ANSICHT_SCHEMA_PROPERTIES = {
  ansicht: { type: 'string', enum: [...ANSICHT_MODI], description: 'Bild zeigen: inline=Bildblock, link=Link mit Timer, beides' },
  offen_sekunden: { type: 'number', description: 'Link-Laufzeit (nur link/beides)' },
  einmalig: { type: 'boolean', description: 'Link nur einmal abrufbar (nur link/beides)' },
} as const;

export interface McpBild { type: 'image'; mimeType: string; data: string }

const MCP_BILDER = Symbol('synapse.mcp_bilder');

/** Hängt Bildblöcke unsichtbar (nicht aufzählbar) an ein Antwortobjekt. */
export function setzeMcpBilder<T extends object>(objekt: T, bilder: McpBild[]): T {
  if (bilder.length > 0) Object.defineProperty(objekt, MCP_BILDER, { value: bilder, enumerable: false, configurable: true });
  return objekt;
}

/** Holt die Bildblöcke eines Tool-Ergebnisses; die Daten selbst bleiben unverändert (gleiches Objekt). */
export function trenneMcpBilder<T>(wert: T): { daten: T; bilder: McpBild[] } {
  const b = wert && typeof wert === 'object' ? (wert as Record<symbol, unknown>)[MCP_BILDER] : undefined;
  return { daten: wert, bilder: Array.isArray(b) ? (b as McpBild[]) : [] };
}

/** MCP-Hülle um Bildblöcke NACH dem Textteil ergänzen. Ohne Bilder: dieselbe Hülle. */
export function haengeMcpBilderAn<H extends { content: Array<{ type: string }> }>(huelle: H, bilder: McpBild[]): H {
  if (bilder.length === 0) return huelle;
  return { ...huelle, content: [...huelle.content, ...bilder.map(b => ({ type: 'image' as const, mimeType: b.mimeType, data: b.data }))] };
}

const gesetzt = (v: unknown) => v !== undefined && v !== null;

const AUSGABE_NAME: Readonly<Record<string, string>> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP' };
const formatName = (format: unknown) => String(format ?? '').trim().toLowerCase();

/**
 * User-Entscheidung 14.10.2026: Kann eine KI ein Format nicht direkt ansehen, bekommt sie automatisch eine
 * umgewandelte Ansicht (PNG aus dem A14-Renderer); das Original wird nie veraendert. Additive Felder fuer
 * einen erfolgreichen inline-Befund.
 */
export function ansichtUmwandlungsVermerk(format: unknown, mimeType: string): { umgewandelt_aus: string; ausgabe: string; original_unveraendert: true; vermerk: string } {
  const f = formatName(format) || 'unbekannt';
  const nach = AUSGABE_NAME[mimeType] ?? mimeType;
  return { umgewandelt_aus: f, ausgabe: mimeType, original_unveraendert: true, vermerk: 'umgewandelt aus ' + f.toUpperCase() + ' nach ' + nach + ', Original unverändert.' };
}

/** Fehlercodes, bei denen das Format (oder diese Bytes) nicht als Bild dekodiert werden kann. */
export const ANSICHT_NICHT_DEKODIERBAR = ['ansicht_nicht_darstellbar'] as const;

/** Klare Meldung fuer nicht dekodierbare Formate samt Hinweis auf Struktur-/Rohbyte-Ansicht. */
export function ansichtNichtDekodierbarVermerk(format: unknown): { original_unveraendert: true; vermerk: string; alternative: string } {
  const f = (formatName(format) || 'unbekannt').toUpperCase();
  return {
    original_unveraendert: true,
    vermerk: f + ' kann nicht als Bild dekodiert werden; keine Ansicht erzeugt, Original unverändert.',
    alternative: 'Struktur: asset_intel(action:"inspect"|"objects"); Rohbytes: ansicht:"link" (Original-Download); Hex-Ansicht folgt (RV27).',
  };
}

/** true, sobald einer der drei Parameter mitkommt (null zählt als nicht gesetzt). */
export function hatAnsichtParameter(args: Record<string, unknown> | null | undefined): boolean {
  return !!args && ANSICHT_PARAMETER.some(k => gesetzt(args[k]));
}

export interface AnsichtParameterFehler { fehlercode: string; message: string }

/** Prüft Werte und Kombination, bevor irgendetwas läuft. null = in Ordnung. */
export function pruefeAnsichtParameter(args: Record<string, unknown>): AnsichtParameterFehler | null {
  const modus = args.ansicht;
  if (gesetzt(modus) && !(ANSICHT_MODI as readonly unknown[]).includes(modus)) {
    return { fehlercode: 'ansicht_ungueltig', message: 'ansicht muss inline, link oder beides sein (erhalten: ' + JSON.stringify(modus) + ').' };
  }
  const link = LINK_PARAMETER.filter(k => gesetzt(args[k]));
  if (link.length > 0 && modus !== 'link' && modus !== 'beides') {
    return {
      fehlercode: 'ansicht_kombination_ungueltig',
      message: link.join(', ') + ' wirkt nur mit ansicht:"link" oder ansicht:"beides"' + (gesetzt(modus) ? ', nicht mit ansicht:"' + String(modus) + '".' : '; ansicht fehlt.'),
    };
  }
  const s = args.offen_sekunden;
  if (gesetzt(s) && (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 1)) {
    return { fehlercode: 'offen_sekunden_ungueltig', message: 'offen_sekunden muss eine ganze Zahl ab 1 sein.' };
  }
  if (gesetzt(args.einmalig) && typeof args.einmalig !== 'boolean') {
    return { fehlercode: 'einmalig_ungueltig', message: 'einmalig muss true oder false sein.' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dienste (injizierbar für Tests; Standard = A14/A15-Prozessinstanzen)
// ---------------------------------------------------------------------------

export interface AnsichtAusgabeDienste {
  ansicht: { ansichten(refs: readonly AssetAnsichtReferenz[]): Promise<AssetAnsichtErgebnis[]> };
  link: { erzeugen(e: AnsichtLinkEingang): Promise<AnsichtLinkErzeugung> };
  projektAktiv: (projekt: string) => Promise<boolean>;
}

let ersatz: Partial<AnsichtAusgabeDienste> = {};

/** Tests: Dienste ersetzen. Gibt eine Funktion zurück, die den vorherigen Stand wiederherstellt. */
export function setzeAnsichtAusgabeDienste(d: Partial<AnsichtAusgabeDienste>): () => void {
  const vorher = ersatz;
  ersatz = { ...ersatz, ...d };
  return () => { ersatz = vorher; };
}

function dienste(): AnsichtAusgabeDienste {
  return {
    ansicht: ersatz.ansicht ?? gemeinsamerAnsichtDienst(),
    link: ersatz.link ?? standardAnsichtLinkDienst(),
    projektAktiv: ersatz.projektAktiv ?? isProjectEnabled,
  };
}

interface AssetZeile { id: string; format: string | null; mime_type: string | null; asset_type: string | null }

async function holeAsset(project: string, filePath: string): Promise<AssetZeile | null> {
  const r = await getPool().query(
    'SELECT id::text AS id, format, mime_type, asset_type FROM asset_files WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL',
    [project, filePath],
  );
  return (r.rows[0] as AssetZeile | undefined) ?? null;
}

/** Audio und Formate ohne freigegebenen Vorschau-Renderer gehen als Original-Link. */
function linkArt(a: AssetZeile): 'ansicht' | 'original' {
  const format = String(a.format ?? '').toLowerCase();
  if (String(a.mime_type ?? '').startsWith('audio/') || a.asset_type === 'audio') return 'original';
  try {
    return getAssetKonfiguration().vorschau.formate.includes(format) ? 'ansicht' : 'original';
  } catch {
    return 'original';
  }
}

export interface AnsichtKontext {
  project: string;
  /** Pfad des Assets (aus der Antwort, sonst aus den Argumenten). */
  filePath: string | null;
  args: Record<string, unknown>;
  agentId?: string | null;
}

/**
 * Ergänzt eine FERTIGE Antwort um das Feld ansicht und hängt das Bild unsichtbar an. Wirft nie; jeder
 * Fehler steht als fehlercode in ansicht bzw. ansicht.inline/ansicht.link, die übrige Antwort bleibt.
 */
export async function ergaenzeAnsicht(antwort: Record<string, unknown>, k: AnsichtKontext): Promise<Record<string, unknown>> {
  const modus = k.args.ansicht as AnsichtModus;
  const bilder: McpBild[] = [];
  const ergebnis: Record<string, unknown> = { modus };
  try {
    const d = dienste();
    if (!k.filePath) {
      ergebnis.fehlercode = 'kein_asset';
      ergebnis.grund = 'Kein Asset-Pfad in der Antwort.';
    } else if (!(await d.projektAktiv(k.project))) {
      ergebnis.fehlercode = 'projekt_verboten';
      ergebnis.grund = 'Projekt fehlt oder ist nicht freigegeben.';
    } else {
      const asset = await holeAsset(k.project, k.filePath);
      if (!asset) {
        ergebnis.fehlercode = 'kein_asset';
        ergebnis.grund = 'Kein (nicht gelöschtes) Asset unter ' + k.filePath + '.';
      } else {
        const ref: AssetAnsichtReferenz = { bereich: 'projekt', ziel_ref: k.project, id: asset.id };
        let revision: string | undefined;
        if (modus === 'inline' || modus === 'beides') {
          let r: AssetAnsichtErgebnis | undefined;
          try {
            [r] = await d.ansicht.ansichten([ref]);
          } catch (e) {
            const code = (e as { code?: unknown })?.code;
            r = { success: false, fehlercode: typeof code === 'string' ? code : 'ansicht_fehler', grund: e instanceof Error ? e.message : String(e), link_rueckfall: null };
          }
          if (r && r.success) {
            revision = r.quelle.revision;
            bilder.push({ type: 'image', mimeType: r.mimeType, data: r.png.toString('base64') });
            ergebnis.inline = {
              success: true, mimeType: r.mimeType, breite: r.breite, hoehe: r.hoehe, bytes: r.png.length,
              revision: r.quelle.revision, cache_treffer: r.cacheTreffer, hinweis: 'Bild folgt als image-Block nach diesem Text.',
              ...ansichtUmwandlungsVermerk(asset.format, r.mimeType),
            };
          } else {
            ergebnis.inline = {
              success: false, fehlercode: r?.fehlercode ?? 'ansicht_fehler', grund: r?.grund ?? 'Keine Ansicht erzeugt.',
              ...((ANSICHT_NICHT_DEKODIERBAR as readonly string[]).includes(r?.fehlercode ?? '') ? ansichtNichtDekodierbarVermerk(asset.format) : {}),
              ...(modus === 'inline' ? { hinweis: 'Alternative: ansicht:"link" (Original bzw. Vorschau im Browser).' } : {}),
            };
          }
        }
        if (modus === 'link' || modus === 'beides') {
          const l = await d.link.erzeugen({
            bereich: 'projekt', ziel_ref: k.project, id: asset.id,
            ...(revision !== undefined ? { revision } : {}),
            offen_sekunden: k.args.offen_sekunden, einmalig: k.args.einmalig, art: linkArt(asset),
            agent_id: k.agentId ?? null, projekt: k.project,
          });
          ergebnis.link = l.success
            ? { success: true, url: l.url, token_id: l.token_id, expires_at: l.expires_at, offen_sekunden: l.offen_sekunden, einmalig: l.einmalig, art: l.art, revision: l.revision }
            : { success: false, fehlercode: l.fehlercode, grund: l.grund };
        }
      }
    }
  } catch (e) {
    ergebnis.fehlercode = 'ansicht_fehler';
    ergebnis.grund = e instanceof Error ? e.message : String(e);
  }
  return setzeMcpBilder({ ...antwort, ansicht: ergebnis }, bilder);
}

/**
 * REST code_intel: umschließt den Bestandsaufruf. Ohne ansicht-Parameter wird nur bestand() geliefert
 * (dasselbe Objekt, keine Zusatzarbeit). Mit ansicht nur bei action file und nur auf ein Asset
 * (Weiche beantwortet_von:'asset_intel' oder Zusatzfeld asset), sonst ansicht.fehlercode kein_asset.
 */
export async function mitCodeIntelAnsicht(
  action: string | undefined,
  args: Record<string, unknown>,
  agentId: string | null | undefined,
  bestand: () => Promise<unknown>,
): Promise<unknown> {
  if (!hatAnsichtParameter(args)) return bestand();
  if (action !== 'file') {
    return { success: false, error: 'ansicht_nicht_unterstuetzt', message: 'ansicht wirkt bei code_intel nur mit action:"file" auf ein Asset.' };
  }
  const f = pruefeAnsichtParameter(args);
  if (f) return { success: false, error: f.fehlercode, message: f.message };
  const a = await bestand();
  if (!a || typeof a !== 'object' || Array.isArray(a)) return a;
  const antwort = a as Record<string, unknown>;
  const project = typeof args.project === 'string' ? args.project : '';
  const istAsset = antwort.success === true && (antwort.beantwortet_von === 'asset_intel' || (!!antwort.asset && typeof antwort.asset === 'object'));
  if (!istAsset) {
    return { ...antwort, ansicht: { modus: args.ansicht, fehlercode: 'kein_asset', grund: 'Keine Asset-Datei; ansicht nur für Assets.' } };
  }
  const pfad = typeof antwort.file_path === 'string' ? antwort.file_path : (typeof args.file_path === 'string' ? args.file_path : null);
  return ergaenzeAnsicht(antwort, { project, filePath: pfad, args, agentId });
}
