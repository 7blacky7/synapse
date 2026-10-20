/**
 * P22-T67: Bilder aus Werkzeugergebnissen im Antwortstrom des Hauptagenten.
 *
 * Liefert ein Synapse-Tool ein Bild (code_intel file / asset_intel inspect mit ansicht:'inline'), steht es im Ergebnis der
 * CLI als image-Block mit Base64. Das Base64 gehoert weder in den Strom noch in den Verlauf: es wird durch eine Zeile
 * ersetzt, und der Schritt traegt stattdessen einen VERWEIS auf das Asset (project + file_path + revision). Die Web-UI
 * laedt das Bild ueber GET /api/main-agent/tool-bild nach, deshalb bleibt es auch auf anderen Geraeten abrufbar.
 * Kein Schalter: reine Anzeige (die Bilddaten werden nur nicht mehr als Text durchgereicht).
 * Die reinen Funktionen liegen in core (services/werkzeug-bilder.ts), damit der Wrapper-Spiegel (agents verlauf-melden)
 * denselben Weg nutzt; hier bleiben die Strom-Helfer der Driver.
 */
import { werkzeugBilder, ohneBilddaten, bildVerweisAusAufruf } from '@synapse/core';
import type { RuntimeWerkzeugBild, RuntimeWerkzeugSchritt } from './types.js';

export { werkzeugBilder, ohneBilddaten, bildVerweisAusAufruf };

/** Feld bilder fuer einen end-Schritt: nur gesetzt, wenn das Ergebnis Bilder traegt. */
export function bilderFeld(content: unknown): { bilder?: RuntimeWerkzeugBild[] } {
  const bilder = werkzeugBilder(content);
  return bilder.length ? { bilder } : {};
}

/**
 * Merker je Antwortstrom: start-Schritte liefern die Argumente, end-Schritte mit Bildern bekommen den Verweis.
 * Der Aufruf gibt den (ggf. angereicherten) Schritt zurueck; Schritte ohne Bilder bleiben unveraendert.
 */
export function neuerBildVerweisMerker(): (schritt: RuntimeWerkzeugSchritt) => RuntimeWerkzeugSchritt {
  const aufrufe = new Map<string, { name?: string; input?: unknown }>();
  return (schritt) => {
    if (schritt.phase === 'start') {
      aufrufe.set(schritt.id, { name: schritt.name, input: schritt.input });
      return schritt;
    }
    const aufruf = aufrufe.get(schritt.id);
    aufrufe.delete(schritt.id);
    if (!schritt.bilder?.length) return schritt;
    const verweis = bildVerweisAusAufruf(aufruf?.name ?? schritt.name, aufruf?.input, schritt.output);
    return { ...schritt, bilder: schritt.bilder.map((b) => ({ ...b, ...verweis })) };
  };
}
