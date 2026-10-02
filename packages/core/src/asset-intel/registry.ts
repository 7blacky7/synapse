/**
 * MODUL: Asset Registry
 * ZWECK: Ordnet eine Datei dem richtigen Asset-Inspektor zu: ZUERST Magic Bytes, DANN Endung.
 *
 * Eigene Registry, bewusst nicht in parser/index.ts: LanguageParser.parse() nimmt Text,
 * ein Inspektor liest Binaerdaten gezielt aus einer AssetSource.
 *
 * MEHRDEUTIGKEIT LOEST ZU "KEIN TREFFER" AUF (wie die Inhaltserkennung in parser/index.ts):
 * Beanspruchen zwei Inspektoren dieselbe Datei und laesst sich das nicht ueber die zweite
 * Spur (Endung) aufloesen, gewinnt keiner. Es gibt eine Warnung statt einer scheinbar
 * sicheren Zuordnung, die vom Registrierungs-Zufall abhinge.
 */

import * as path from 'path';
import type { AssetInspector, AssetMagic, AssetWarning } from './types.js';

/** Wie die Zuordnung zustande kam. */
export type AssetErkennungsweg = 'magic' | 'magic_und_endung' | 'endung';

/** Ergebnis der Formaterkennung. */
export interface AssetDetection {
  /** Zustaendiger Inspektor; null bei keinem oder mehrdeutigem Treffer. */
  inspector: AssetInspector | null;
  /** Erkanntes Format (Kleinschrift); null ohne Treffer. */
  format: string | null;
  /** Wodurch erkannt; null ohne Treffer. */
  via: AssetErkennungsweg | null;
  /** Auffaelligkeiten der Erkennung (Mehrdeutigkeit, Endung widerspricht Inhalt, ...). */
  warnings: AssetWarning[];
}

function normalisiereEndung(e: string): string {
  const k = e.trim().toLowerCase();
  return k.startsWith('.') ? k : '.' + k;
}

function magicPasst(head: Uint8Array, m: AssetMagic): boolean {
  const ende = m.offset + m.bytes.length;
  if (m.offset < 0 || ende > head.length) return false;
  for (let i = 0; i < m.bytes.length; i++) {
    if (head[m.offset + i] !== m.bytes[i]) return false;
  }
  return true;
}

export class AssetRegistry {
  private readonly inspektoren = new Map<string, AssetInspector>();

  /**
   * Registriert einen Inspektor. Gleiche id ersetzt den vorigen (idempotent beim Neuladen).
   * Ungueltige Angaben werfen sofort — ein halb registrierter Inspektor waere ein stiller Ausfall.
   */
  register(inspector: AssetInspector): void {
    if (!inspector || typeof inspector.id !== 'string' || inspector.id.trim() === '') {
      throw new Error('Asset-Inspektor ohne id');
    }
    if (!Array.isArray(inspector.formats) || inspector.formats.length === 0) {
      throw new Error(`Asset-Inspektor "${inspector.id}" ohne formats`);
    }
    if (!Array.isArray(inspector.extensions)) {
      throw new Error(`Asset-Inspektor "${inspector.id}" ohne extensions (leeres Array ist erlaubt)`);
    }
    if (typeof inspector.inspect !== 'function') {
      throw new Error(`Asset-Inspektor "${inspector.id}" ohne inspect()`);
    }
    for (const m of inspector.magic ?? []) {
      if (!Number.isSafeInteger(m.offset) || m.offset < 0 || m.bytes.length === 0) {
        throw new Error(`Asset-Inspektor "${inspector.id}": ungueltiges Magic-Muster`);
      }
    }
    this.inspektoren.set(inspector.id, inspector);
  }

  get(id: string): AssetInspector | undefined {
    return this.inspektoren.get(id);
  }

  list(): AssetInspector[] {
    return [...this.inspektoren.values()];
  }

  /** Alle bekannten Formatnamen, eindeutig und sortiert. */
  formats(): string[] {
    const alle = new Set<string>();
    for (const i of this.inspektoren.values()) for (const f of i.formats) alle.add(f.toLowerCase());
    return [...alle].sort();
  }

  /**
   * Ordnet eine Datei zu. headBytes sind die ersten Bytes der Datei (mehr als ein paar KiB
   * braucht niemand); leer ist erlaubt, dann entscheidet nur die Endung.
   */
  detect(filePath: string, headBytes: Uint8Array): AssetDetection {
    const warnings: AssetWarning[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const nachEndung = ext ? this.list().filter(i => i.extensions.some(e => normalisiereEndung(e) === ext)) : [];
    const formatAusEndung = (i: AssetInspector): string =>
      (i.formats.find(f => '.' + f.toLowerCase() === ext) ?? i.formats[0]).toLowerCase();

    // Spur 1: Magic Bytes. Je Inspektor zaehlt das LAENGSTE passende Muster.
    const magicTreffer: Array<{ insp: AssetInspector; format: string }> = [];
    for (const insp of this.inspektoren.values()) {
      let bestes: AssetMagic | null = null;
      for (const m of insp.magic ?? []) {
        if (magicPasst(headBytes, m) && (!bestes || m.bytes.length > bestes.bytes.length)) bestes = m;
      }
      if (bestes) magicTreffer.push({ insp, format: (bestes.format ?? insp.formats[0]).toLowerCase() });
    }

    if (magicTreffer.length === 1) {
      const { insp, format } = magicTreffer[0];
      if (nachEndung.length > 0 && !nachEndung.includes(insp)) {
        warnings.push({
          code: 'endung_widerspricht_inhalt',
          message: `Endung "${ext}" gehoert zu anderem Format; der Inhalt (Magic) ergibt "${format}" — Inhalt gilt.`,
        });
      }
      return { inspector: insp, format, via: 'magic', warnings };
    }

    if (magicTreffer.length > 1) {
      const eingeengt = magicTreffer.filter(t => nachEndung.includes(t.insp));
      if (eingeengt.length === 1) {
        return { inspector: eingeengt[0].insp, format: eingeengt[0].format, via: 'magic_und_endung', warnings };
      }
      warnings.push({
        code: 'erkennung_mehrdeutig',
        message: `Magic passt auf mehrere Inspektoren (${magicTreffer.map(t => t.insp.id).join(', ')}) und die Endung entscheidet nicht — kein Treffer.`,
      });
      return { inspector: null, format: null, via: null, warnings };
    }

    // Spur 2: Endung.
    if (nachEndung.length === 1) {
      const insp = nachEndung[0];
      if ((insp.magic ?? []).length > 0) {
        warnings.push({
          code: 'magic_fehlt',
          message: `Endung "${ext}" deutet auf "${insp.id}", aber der Dateikopf traegt dessen Magic nicht (leer, abgeschnitten oder falsch benannt).`,
        });
      }
      return { inspector: insp, format: formatAusEndung(insp), via: 'endung', warnings };
    }
    if (nachEndung.length > 1) {
      warnings.push({
        code: 'erkennung_mehrdeutig',
        message: `Endung "${ext}" beanspruchen mehrere Inspektoren (${nachEndung.map(i => i.id).join(', ')}) — kein Treffer.`,
      });
    }
    return { inspector: null, format: null, via: null, warnings };
  }
}

/** Die Standard-Registry, in die index.ts die eingebauten Inspektoren einhaengt. */
export const standardRegistry = new AssetRegistry();

export function registerInspector(inspector: AssetInspector, registry: AssetRegistry = standardRegistry): void {
  registry.register(inspector);
}

/** Zuordnung: zuerst Magic Bytes, dann Endung. Mehrdeutig = kein Treffer + Warnung. */
export function detectAsset(
  filePath: string,
  headBytes: Uint8Array,
  registry: AssetRegistry = standardRegistry
): AssetDetection {
  return registry.detect(filePath, headBytes);
}

export function getRegisteredFormats(registry: AssetRegistry = standardRegistry): string[] {
  return registry.formats();
}
