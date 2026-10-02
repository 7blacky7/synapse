/**
 * MODUL: Asset-Intel Types
 * ZWECK: Gemeinsames Ausgabemodell und Schnittstellen fuer Asset-Inspektoren
 *        (Nicht-Quellcode-Dateien: Bilder, 3D-Modelle, Archive, Binaerformate).
 *
 * WARUM EIGENE TYPEN UND NICHT parser/types.ts: LanguageParser.parse() nimmt TEXT.
 * Assets sind Binaerdaten und duerfen nie komplett in den Speicher geladen werden,
 * nur weil jemand sie ansehen will. Deshalb arbeitet ein Inspektor gegen eine
 * AssetSource, die gezielt Bereiche liest (readRange), und gegen harte Grenzen.
 *
 * GRUNDSATZ: Die Originaldatei bleibt Quelle der Wahrheit. Alles hier ist ABGELEITET,
 * nur lesend und jederzeit neu berechenbar. Rohinhalt gehoert nicht in die Datenbank.
 *
 * ACHTUNG FOLGE-AGENTEN (T61-T66): dieses Modell ist die Grundlage aller Inspektoren.
 * Aenderungen nur nach Absprache im Channel asset-intel-parser.
 */

/**
 * Harte Grenzen eines Inspektionslaufs. Alle Werte sind Obergrenzen; wer sie
 * ueberschreitet, bekommt ein Ergebnis mit warnings, keinen Absturz.
 */
export interface AssetLimits {
  /** Groesste Datei, die ueberhaupt inspiziert wird (Bytes). Groessere: nur Erkennung + Warnung. */
  maxFileBytes: number;
  /** Summe aller Bytes, die ein Inspektor ueber readRange lesen darf. */
  maxReadBytes: number;
  /** Hoechstzahl Objekte (und Referenzen) im Ergebnis; mehr wird gekappt + Warnung. */
  maxObjects: number;
  /** Laufzeitgrenze fuer den gesamten Lauf in Millisekunden. */
  timeoutMs: number;
  /** Hoechste Verschachtelungstiefe (z. B. Archiv in Archiv). */
  maxDepth: number;
  /** Groesste Datei, fuer die ein sha256 berechnet wird (Bytes). */
  maxHashBytes: number;
}

/**
 * Lesender Zugriff auf ein Asset. Bewusst KEIN readFile: ein Inspektor liest nur,
 * was er braucht, und bleibt so unter maxReadBytes.
 */
export interface AssetSource {
  /** Pfad der Datei, wie er an inspectAsset uebergeben wurde. */
  readonly filePath: string;
  /** Dateigroesse in Bytes zum Zeitpunkt des Oeffnens. */
  readonly size: number;
  /**
   * Liest hoechstens length Bytes ab offset. Am Dateiende kuerzer, hinter dem Ende
   * ein leerer Buffer. Negative/nicht ganzzahlige Argumente: AssetReadError.
   * Ueberschreitet die Summe aller Lesungen maxReadBytes: AssetLimitError.
   */
  readRange(offset: number, length: number): Promise<Buffer>;
}

/** Magic-Bytes-Muster zur Formaterkennung am Dateianfang (oder festem Offset). */
export interface AssetMagic {
  /** Byte-Offset, an dem das Muster beginnt (0 = Dateianfang). */
  offset: number;
  /** Das erwartete Byte-Muster. */
  bytes: readonly number[] | Uint8Array;
  /** Format, das dieses Muster belegt; fehlt es, gilt das erste Format des Inspektors. */
  format?: string;
}

/** Ein Inspektor fuer ein oder mehrere Dateiformate. */
export interface AssetInspector {
  /** Eindeutige Kennung, z. B. 'generic-binary'. */
  id: string;
  /** Formatnamen in Kleinschrift, z. B. ['gltf', 'glb']. Das erste ist der Standard. */
  formats: string[];
  /** Dateiendungen mit oder ohne Punkt, z. B. ['.glb']. Zweitrangig nach Magic. */
  extensions: string[];
  /** OPTIONAL: Magic-Bytes. Haben Vorrang vor der Endung. */
  magic?: AssetMagic[];
  /**
   * Version dieses Inspektors (ganze Zahl, ab 1). Wie LanguageParser.version: bei jeder
   * INHALTLICHEN Aenderung der Ausgabe erhoehen, damit veraltete Ergebnisse auffallen.
   */
  version: number;
  /**
   * Inspiziert die Datei. Darf werfen (AssetReadError, AssetLimitError oder beliebig) —
   * inspectAsset faengt alles ab und macht daraus warnings. Soll ctx.pruefeAbbruch()
   * in langen Schleifen aufrufen und ctx.limits.maxObjects beachten.
   */
  inspect(src: AssetSource, ctx: AssetContext): Promise<AssetResult>;
}

/** Laufzeitumgebung, die inspectAsset einem Inspektor mitgibt. */
export interface AssetContext {
  /** Erkanntes Format (Kleinschrift) oder null. */
  readonly format: string | null;
  /** Die geltenden Grenzen. */
  readonly limits: AssetLimits;
  /** Aktuelle Verschachtelungstiefe (0 = oberste Datei). */
  readonly depth: number;
  /** Wird bei Zeitueberschreitung abgebrochen. */
  readonly signal: AbortSignal;
  /** Wirft AssetLimitError('timeoutMs'), wenn die Zeit um ist. In Schleifen aufrufen. */
  pruefeAbbruch(): void;
  /** Haengt eine Warnung ans Ergebnis, ohne den Lauf zu beenden. */
  warn(code: string, message: string): void;
  /** Kontext fuer eine Ebene tiefer; wirft AssetLimitError('maxDepth') ueber der Grenze. */
  tiefer(): AssetContext;
}

/** Eine Warnung: maschinenlesbarer Code + Klartext. */
export interface AssetWarning {
  /** Stabiler Code, z. B. 'quelle_nicht_gefunden', 'datei_zu_gross', 'lesefehler'. */
  code: string;
  /** Klartext fuer Menschen/Agenten. */
  message: string;
}

/** Position eines Objekts in der Originaldatei: Bytebereich ODER Zeilenbereich. */
export type AssetSourceRange =
  | { offset: number; length: number }
  | { line_start: number; line_end: number };

/** Ein Objekt/Element im Asset (Mesh, Material, Ebene, Eintrag, Chunk, ...). */
export interface AssetObject {
  /** Name des Objekts; null wenn es keinen hat. */
  name: string | null;
  /** Art des Objekts, formatabhaengig (z. B. 'mesh', 'material', 'chunk'). */
  kind: string;
  /** Nutzdaten des Objekts (abgeleitet, klein halten). */
  data: Record<string, unknown>;
  /** Wo das Objekt in der Originaldatei liegt (Grundlage fuer gezieltes Patchen). */
  source_range?: AssetSourceRange;
}

/** Eine Beziehung zu einer anderen Datei oder einem anderen Asset. */
export interface AssetReference {
  /** Ziel, wie es im Asset steht (Pfad, URI, Name). */
  target: string;
  /** Art der Beziehung (z. B. 'texture', 'buffer', 'include'). */
  kind: string;
  /** true/false = gegen das Dateisystem aufgeloest; undefined = nicht versucht. */
  resolved?: boolean;
}

/** Gesamtstatus eines Inspektionslaufs. */
export type AssetStatus =
  | 'ok'
  | 'teilweise'
  | 'nicht_erkannt'
  | 'fehler'
  | 'quelle_nicht_gefunden';

/** Das einheitliche Ergebnis eines Inspektionslaufs. */
export interface AssetResult {
  /** Grobe Klasse: 'image' | 'model3d' | 'audio' | 'document' | 'archive' | 'executable' | 'binary' | 'unbekannt' | ... */
  asset_type: string;
  /** Erkanntes Format in Kleinschrift (z. B. 'png', 'glb'); null wenn nicht erkannt. */
  format: string | null;
  /** Pfad der Datei, wie uebergeben. */
  file_path: string;
  /** Dateigroesse in Bytes (0 wenn die Quelle fehlt). */
  size: number;
  /** sha256 der Datei in Hex; null wenn zu gross oder nicht lesbar (dann mit warning). */
  sha256: string | null;
  /** Gesamtstatus; bei allem ausser 'ok' erklaeren warnings den Grund. */
  status: AssetStatus;
  /** Kennung des Inspektors, der gelaufen ist; null wenn keiner zustaendig war. */
  inspector: string | null;
  /** Allgemeine Eigenschaften (Abmessungen, Dauer, Autor, ...). */
  metadata: Record<string, unknown>;
  /** Beziehungen zu anderen Dateien/Assets. */
  references: AssetReference[];
  /** Objekte/Elemente im Asset, je mit Position in der Originaldatei. */
  objects: AssetObject[];
  /** Alles, was nicht glatt lief. Leer = nichts aufgefallen. */
  warnings: AssetWarning[];
  /** Version des Inspektors, der das Ergebnis erzeugt hat (0 = keiner). */
  parser_version: number;
  /** Zeitpunkt der Extraktion, ISO-8601 UTC. */
  extracted_at: string;
  /** Formatspezifische Zusatzdaten, die in kein Kernfeld passen. */
  format_specific: Record<string, unknown>;
}

/**
 * Leeres, vollstaendiges Ergebnis. Inspektoren starten damit und fuellen nur,
 * was sie wissen — so fehlt nie ein Kernfeld. inspectAsset ueberschreibt file_path,
 * size, sha256 und extracted_at ohnehin selbst.
 */
export function erzeugeAssetResult(
  filePath: string,
  size: number,
  felder: Partial<AssetResult> = {}
): AssetResult {
  return {
    asset_type: 'unbekannt',
    format: null,
    file_path: filePath,
    size,
    sha256: null,
    status: 'ok',
    inspector: null,
    metadata: {},
    references: [],
    objects: [],
    warnings: [],
    parser_version: 0,
    extracted_at: new Date().toISOString(),
    format_specific: {},
    ...felder,
  };
}
