/**
 * P22-T235 (Live-Abnahme P22-T196 t221, Befund B1, thought 014db8fa): Bei 1080p war die Netzwerk-Buehne der Uebersicht mit festem
 * calc(100vh - 230px) zu hoch; die Sonnenliste darunter war angeschnitten. Die Hoehe kommt jetzt aus dem tatsaechlich freien Platz:
 * sichtbare Hoehe des Scrollbereichs (.control-content) minus Oberkante der Buehne darin minus Sonnenliste minus Luft.
 * Reine Logik ohne DOM (OverviewView misst, CSS liest die Variable --uebersicht-buehne).
 */
export const BUEHNE_MIN = 360;
export const SONNENLISTE_STANDARD = 44;
export const LUFT = 8;

export interface BuehnenMass {
  /** clientHeight des Scrollbereichs (.control-content). */
  behaelterHoehe: number;
  /** Oberkante der Buehne relativ zum Inhalt des Scrollbereichs (inkl. scrollTop). */
  buehneOben: number;
  /** gemessene Hoehe der Sonnenliste; fehlt sie (noch nicht gerendert), gilt SONNENLISTE_STANDARD. */
  sonnenHoehe?: number | null;
  minimum?: number;
  luft?: number;
}

export function buehnenHoehe(m: BuehnenMass): number {
  const liste = typeof m.sonnenHoehe === 'number' && m.sonnenHoehe > 0 ? m.sonnenHoehe : SONNENLISTE_STANDARD;
  const frei = m.behaelterHoehe - m.buehneOben - liste - (m.luft ?? LUFT);
  return Math.max(m.minimum ?? BUEHNE_MIN, Math.round(Number.isFinite(frei) ? frei : 0));
}
