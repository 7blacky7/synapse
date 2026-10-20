/**
 * P22-T68: Formularmodell fuer ProfilInhalt (Typ-Inhalt und Profil-Override): reine Funktionen ohne UI.
 * Verwaltete Felder werden aus dem Formular gebaut, alle uebrigen Felder der Basis (startrezept, kontext, rolle ...) bleiben unveraendert.
 */
import { entwurfAusZuschnitt, zuschnittAusEntwurf, type ZuschnittEntwurf } from './AusweisZuschnittEditor';

export type HinweisWahl = '' | 'an' | 'aus';

export interface InhaltEntwurf {
  modell: string;
  effort: string;
  kontextStufe: string;
  regeln: string;
  skills: string;
  channels: string;
  briefing: string;
  arbeitsweise: string;
  zuschnitt: ZuschnittEntwurf;
  hinweise: Record<string, HinweisWahl>;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const liste = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export const zeilen = (t: string): string[] => t.split('\n').map((z) => z.trim()).filter(Boolean);
export const kommaListe = (t: string): string[] => t.split(',').map((z) => z.trim()).filter(Boolean);

export function hinweiseAus(roh: Record<string, boolean>): Record<string, HinweisWahl> {
  return Object.fromEntries(Object.entries(roh).map(([k, v]) => [k, v ? 'an' : 'aus'])) as Record<string, HinweisWahl>;
}

export function hinweiseZuBool(w: Record<string, HinweisWahl>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(w).filter(([, v]) => v === 'an' || v === 'aus').map(([k, v]) => [k, v === 'an']));
}

export function inhaltEntwurf(inhalt: Record<string, unknown>): InhaltEntwurf {
  return {
    modell: text(inhalt.modell), effort: text(inhalt.effort), kontextStufe: text(inhalt.kontext_stufe),
    regeln: liste(inhalt.regeln).join('\n'), skills: liste(inhalt.skills).join('\n'), channels: liste(inhalt.channels).join(', '),
    briefing: text(inhalt.briefing), arbeitsweise: text(inhalt.arbeitsweise),
    zuschnitt: entwurfAusZuschnitt(obj(inhalt.zuschnitt)),
    hinweise: hinweiseAus(Object.fromEntries(Object.entries(obj(inhalt.hinweise)).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>),
  };
}

/** Baut den Inhalt: verwaltete Felder aus dem Formular, leere Felder entfallen, Rest der Basis bleibt. */
export function inhaltAusEntwurf(e: InhaltEntwurf, basis: Record<string, unknown>): Record<string, unknown> {
  const aus: Record<string, unknown> = { ...basis };
  const setze = (k: string, v: unknown, leer: boolean) => { if (leer) delete aus[k]; else aus[k] = v; };
  setze('modell', e.modell, !e.modell.trim());
  setze('effort', e.effort, !e.effort.trim());
  setze('briefing', e.briefing, !e.briefing.trim());
  setze('arbeitsweise', e.arbeitsweise, !e.arbeitsweise.trim());
  setze('kontext_stufe', e.kontextStufe, !e.kontextStufe);
  setze('regeln', zeilen(e.regeln), zeilen(e.regeln).length === 0);
  setze('skills', zeilen(e.skills), zeilen(e.skills).length === 0);
  setze('channels', kommaListe(e.channels), kommaListe(e.channels).length === 0);
  const zuschnitt = zuschnittAusEntwurf(e.zuschnitt, obj(basis.zuschnitt));
  setze('zuschnitt', zuschnitt, Object.keys(zuschnitt).length === 0);
  const hinweise = hinweiseZuBool(e.hinweise);
  setze('hinweise', hinweise, Object.keys(hinweise).length === 0);
  return aus;
}
