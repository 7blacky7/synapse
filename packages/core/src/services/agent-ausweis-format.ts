/**
 * P22-T35 (User-Entscheidung 19.10.2026 ~16:55, memory entscheidung-agenten-ausweis-2026-10-19 Punkt 5a):
 * 'Wir fangen bei 1 Zeichen an und irgendwann sind es 2, 3, 4 Zeichen.' Der Ausweis ist nur ein Erkennungszeichen;
 * Kuerze spart Kontext bei JEDEM Aufruf.
 *
 * FORMAT: 'sai_' + fortlaufend gezaehlte Nummer (PG-Sequenz agent_ausweis_nr, Schema 115), bijektiv kodiert im
 * lesbaren Alphabet ohne verwechselbare Zeichen (kein 0/o/1/l/i): 31 Zeichen -> die ersten 31 Ausweise haben
 * 1 Zeichen, danach 2, 3, ... Nummern werden nie wiederverwendet (Sequenz, auch nicht nach Loeschen/Rollback).
 * Alte Ausweise (sai_ + 64 hex) bleiben gueltig, solange sie in agent_identitaet_tokens.token_offen stehen.
 *
 * DIESE DATEI ist die EINZIGE Stelle, die Ausweise erzeugt und das Format kennt (Erkennung in Text, Pruefung,
 * Praefix). Keine Importe ausser dem pg-Typ, damit sie ueberall ohne Importzyklus nutzbar ist.
 * (tool-args-schwaerzen.ts und der Daemon fuehren das Muster wegen ihrer Eigenstaendigkeit als Literal; ein Test
 * vergleicht beide mit dieser Datei.)
 */
import type { PoolClient } from 'pg';

export const AUSWEIS_TEXT_PRAEFIX = 'sai_';
/** 31 Zeichen: 2-9 und a-z ohne i, l, o. */
export const AUSWEIS_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
/** Obergrenze fuer die Erkennung (alte Ausweise: 64 hex). */
export const AUSWEIS_MAX_ZEICHEN = 64;
/** Ganzer Wert. 1..64 Zeichen [a-z0-9] (neue Kodierung ist eine Teilmenge, alte 64-hex ebenfalls). */
export const AUSWEIS_FORMAT = /^sai_[a-z0-9]{1,64}$/;
const IM_TEXT_QUELLE = '(?<![A-Za-z0-9_-])sai_[a-z0-9]{1,64}(?![A-Za-z0-9_])';
/** Ausweis als eigenstaendiges Wort im Text (Wortgrenzen, damit normaler Text nicht zerschossen wird). Ohne g-Flag: test(). */
export const AUSWEIS_IM_TEXT = new RegExp(IM_TEXT_QUELLE);
/** Frische globale Instanz fuer replace/matchAll (kein geteilter lastIndex-Zustand). */
export function neuesAusweisImTextMuster(): RegExp { return new RegExp(IM_TEXT_QUELLE, 'g'); }
/** Laenge des sichtbaren Praefixes alter (langer) Ausweise. */
export const AUSWEIS_PRAEFIX_LAENGE = 12;

export function istAusweisFormat(wert: unknown): wert is string {
  return typeof wert === 'string' && AUSWEIS_FORMAT.test(wert);
}

/**
 * Bijektive Zaehlung zur Basis 31: 1 -> '2', 31 -> 'z', 32 -> '22', 992 -> 'zz', 993 -> '222' usw.
 * Kuerzest moeglich, eindeutig, ohne fuehrende 'Nullen'.
 */
export function kodiereAusweisNummer(nr: number | string): string {
  let n = typeof nr === 'string' ? Number(nr) : nr;
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('ausweis_nummer_ungueltig');
  const basis = AUSWEIS_ALPHABET.length;
  let s = '';
  while (n > 0) {
    n -= 1;
    s = AUSWEIS_ALPHABET[n % basis] + s;
    n = Math.floor(n / basis);
  }
  return s;
}

/**
 * Anzeige-Praefix (token_praefix, Audit/Uebersicht). Lange (alte) Ausweise: die ersten 12 Zeichen wie bisher.
 * Kurze Ausweise sind schon der ganze Wert und duerfen nie als Praefix erscheinen: 'sai_' + '*' je Zeichen.
 */
export function ausweisPraefix(token: string): string {
  if (token.length > AUSWEIS_PRAEFIX_LAENGE) return token.slice(0, AUSWEIS_PRAEFIX_LAENGE);
  return AUSWEIS_TEXT_PRAEFIX + '*'.repeat(Math.max(0, token.length - AUSWEIS_TEXT_PRAEFIX.length));
}

/**
 * EINZIGE Erzeugung eines Ausweiswerts: naechste Nummer der Sequenz agent_ausweis_nr (nextval wird nie
 * zurueckgenommen -> keine Wiederverwendung). Der Aufrufer schreibt den Wert selbst in token_offen
 * (unique Index uq_agent_identitaet_tokens_offen).
 */
export async function erzeugeAusweis(c: Pick<PoolClient, 'query'>): Promise<string> {
  const r = await c.query<{ nr: string }>("SELECT nextval('agent_ausweis_nr')::text AS nr");
  return AUSWEIS_TEXT_PRAEFIX + kodiereAusweisNummer(r.rows[0].nr);
}
