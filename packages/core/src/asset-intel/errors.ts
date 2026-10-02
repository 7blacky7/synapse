/**
 * MODUL: Asset-Intel Fehler
 * ZWECK: Kontrollierte Fehlerklassen, damit ein kaputtes Asset nie als RangeError/TypeError
 *        aus Node-Interna ankommt, sondern als Fehler, den inspectAsset einordnen kann.
 */

/** Warum ein Lesezugriff scheiterte. */
export type AssetReadFehlerArt =
  | 'ausserhalb'
  | 'abgeschnitten'
  | 'ungueltiges_argument'
  | 'cstring_unterminiert'
  | 'zahl_zu_gross';

/** Lesezugriff ausserhalb der Daten, ungueltiges Argument oder nicht abgeschlossener String. */
export class AssetReadError extends Error {
  constructor(
    /** Fehlerart, maschinenlesbar. */
    public readonly art: AssetReadFehlerArt,
    message: string,
    /** Absoluter Byte-Offset, an dem der Zugriff begann. */
    public readonly offset: number,
    /** Wie viele Bytes der Zugriff brauchte (0 wenn nicht zutreffend). */
    public readonly benoetigt: number,
    /** Wie viele Bytes ab dort noch da waren (0 wenn nicht zutreffend). */
    public readonly verfuegbar: number
  ) {
    super(message);
    this.name = 'AssetReadError';
  }
}

/** Welche Grenze ueberschritten wurde (Schluessel von AssetLimits). */
export type AssetGrenze =
  | 'maxFileBytes'
  | 'maxReadBytes'
  | 'maxObjects'
  | 'timeoutMs'
  | 'maxDepth';

/** Eine harte Grenze wurde ueberschritten. */
export class AssetLimitError extends Error {
  constructor(
    /** Die verletzte Grenze. */
    public readonly grenze: AssetGrenze,
    message: string
  ) {
    super(message);
    this.name = 'AssetLimitError';
  }
}
