/**
 * P22-T153: Einstellungsformular des Agentennetzwerks, reine Logik ohne DOM.
 * - Beschriftungen und Gruppen der Katalognamen (core NETZWERK_EINSTELLUNGEN); unbekannte Namen landen in 'Weitere' mit dem Namen als Text.
 * - Fehlerfix: "Speichern" schickte vorher ALLE Werte mit dem Stand des ersten Snapshots und ueberschrieb damit inzwischen per
 *   admin(agentennetzwerk) gesetzte Werte (und markierte alles als 'einstellung'). Jetzt gehen nur Felder raus, deren Eingabe vom
 *   aktuellen Snapshot-Wert abweicht; unberuehrte Felder zeigen immer den Wert des aktuellen Snapshots.
 */
export interface NetzEinstellung { wert: number; quelle: string; min: number; max: number; einheit?: string }

export const NETZWERK_LABELS: Record<string, string> = {
 aktivitaet_sekunden: 'Aktivitätsfenster (Sekunden)', inaktiv_sekunden: 'Inaktiv nach (Sekunden)', sichtbare_agenten: 'Sichtbare Agenten',
 sichtbare_channels: 'Sichtbare Channels', ereignis_limit: 'Ereignisse im Fenster', animation_limit: 'Gleichzeitige Animationen',
 animation_ms: 'Animationsdauer (ms)', bilder_pro_sekunde: 'Bilder pro Sekunde', frame_budget_ms: 'Animationsbudget (ms)',
 buendel_ms: 'Ereignisse bündeln (ms)', abgleich_sekunden: 'Wiederabgleich (Sekunden)',
 plan_nachleuchten_sekunden: 'Committete Pläne sichtbar (Sekunden)', plan_nachleuchten_auto_sekunden: 'Auto-committete Pläne sichtbar (Sekunden)',
 plan_mindestanzeige_sekunden: 'Pläne mindestens anzeigen (Sekunden)', orbit_nebel: 'Trabanten, Nebel und Sterngröße (1 an, 0 aus)',
 an_user_animation: 'Artefakt-/User-Animation (1 an, 0 aus)',
 // P22-T153
 stern_voll_dateien: 'Stern voll ab Dateien', stern_min_promille: 'Mindestgröße des Sterns (Promille)', dateien_je_trabant: 'Dateien je Trabant',
 trabanten_einzeln: 'Trabanten einzeln höchstens', chunks_je_nebelpunkt: 'Chunks je Nebelpunkt', nebel_max: 'Nebelpunkte höchstens',
 nebel_treiben_x_promille: 'Nebel treibt waagerecht (Promille des Radius)', nebel_treiben_y_promille: 'Nebel treibt senkrecht (Promille des Radius)',
 nebel_treiben_x_mrad_s: 'Tempo waagerecht (mrad/s)', nebel_treiben_y_mrad_s: 'Tempo senkrecht (mrad/s)',
 nebel_drehung_mrad: 'Nebel dreht bis (mrad)', nebel_drehung_mrad_s: 'Tempo der Drehung (mrad/s)',
 nebel_puls_promille: 'Nebel pulsiert (Promille)', nebel_puls_mrad_s: 'Tempo des Pulsierens (mrad/s)', nebel_schimmer_mrad_s: 'Tempo des Schimmers (mrad/s)',
 glanz_ms: 'Glanz neuer Punkte (ms)', glanz_anstieg_ms: 'Glanz steigt an (ms)', glanz_abkling_ms: 'Glanz klingt ab (ms)',
 verglimmen_ms: 'Wegfallende Punkte verglimmen (ms)', impuls_ms: 'Impulsring Dauer (ms)', impuls_abstand_ms: 'Impulse bündeln (ms)',
 impulse_max: 'Impulse gleichzeitig', glanz_max: 'Leuchtpunkte gleichzeitig', trabanten_impuls_reichweite: 'Impulsring Reichweite über die Bahnen',
 commit_flug_ms: 'Commit-Flug (ms)', explosion_ms: 'Explosion beim Verwerfen (ms)', kernwelle_ms: 'Kernwelle (ms)',
 orbit_flare_ms: 'Trabanten flackern nach Commit (ms)', trabanten_bahnen_max: 'Trabanten-Bahnen höchstens', deko_sterne: 'Sternenstaub (Anzahl)',
 index_cache_ms: 'Index-Cache (ms)', index_cache_schnell_ms: 'Index-Cache bei schneller Zählung (ms)', index_billig_ms: 'Zählung gilt als schnell unter (ms)',
};

export const NETZWERK_GRUPPEN: ReadonlyArray<{ titel: string; namen: readonly string[] }> = [
 { titel: 'Anzeige und Fenster', namen: ['aktivitaet_sekunden', 'inaktiv_sekunden', 'sichtbare_agenten', 'sichtbare_channels', 'ereignis_limit', 'animation_limit',
  'animation_ms', 'bilder_pro_sekunde', 'frame_budget_ms', 'buendel_ms', 'abgleich_sekunden', 'orbit_nebel', 'an_user_animation'] },
 { titel: 'Pläne', namen: ['plan_nachleuchten_sekunden', 'plan_nachleuchten_auto_sekunden', 'plan_mindestanzeige_sekunden'] },
 { titel: 'Stern, Trabanten, Nebel', namen: ['stern_voll_dateien', 'stern_min_promille', 'dateien_je_trabant', 'trabanten_einzeln', 'trabanten_bahnen_max',
  'chunks_je_nebelpunkt', 'nebel_max', 'deko_sterne'] },
 { titel: 'Nebel-Bewegung', namen: ['nebel_treiben_x_promille', 'nebel_treiben_y_promille', 'nebel_treiben_x_mrad_s', 'nebel_treiben_y_mrad_s', 'nebel_drehung_mrad',
  'nebel_drehung_mrad_s', 'nebel_puls_promille', 'nebel_puls_mrad_s', 'nebel_schimmer_mrad_s'] },
 { titel: 'Reaktion auf Index-Änderungen', namen: ['glanz_ms', 'glanz_anstieg_ms', 'glanz_abkling_ms', 'verglimmen_ms', 'impuls_ms', 'impuls_abstand_ms', 'impulse_max',
  'glanz_max', 'trabanten_impuls_reichweite'] },
 { titel: 'Abläufe', namen: ['commit_flug_ms', 'explosion_ms', 'kernwelle_ms', 'orbit_flare_ms'] },
 { titel: 'Server', namen: ['index_cache_ms', 'index_cache_schnell_ms', 'index_billig_ms'] },
];

/** Gruppen in fester Reihenfolge, nur mit vorhandenen Namen; Namen ohne Gruppe am Ende unter 'Weitere'. */
export function gruppiereEinstellungen(e: Record<string, NetzEinstellung>): Array<{ titel: string; eintraege: Array<[string, NetzEinstellung]> }> {
 const gesehen = new Set<string>(), aus: Array<{ titel: string; eintraege: Array<[string, NetzEinstellung]> }> = [];
 for (const g of NETZWERK_GRUPPEN) {
  const eintraege = g.namen.filter((n) => e[n]).map((n): [string, NetzEinstellung] => { gesehen.add(n); return [n, e[n]]; });
  if (eintraege.length) aus.push({ titel: g.titel, eintraege });
 }
 const rest = Object.entries(e).filter(([n]) => !gesehen.has(n));
 if (rest.length) aus.push({ titel: 'Weitere', eintraege: rest });
 return aus;
}

/** Hilfetext unter dem Feld: Einheit, bei mrad/s die Periode (2*pi*1000 / Wert Sekunden) zum eingegebenen Wert. */
export function einstellungHilfe(name: string, e: Pick<NetzEinstellung, 'einheit'>, wert: number): string {
 if (name.endsWith('_mrad_s')) {
  if (!(wert > 0)) return 'mrad/s · 0 = steht still';
  const s = 2000 * Math.PI / wert;
  return 'mrad/s ≈ Periode ' + (s < 100 ? s.toFixed(1).replace('.', ',') : String(Math.round(s))) + ' s';
 }
 return e.einheit ?? '';
}

/** Nur Eingaben, die eine gueltige Zahl sind und vom aktuellen Wert abweichen (unbekannte Namen fallen weg). */
export function geaenderteNetzwerkWerte(eingaben: Record<string, number>, e: Record<string, Pick<NetzEinstellung, 'wert'>>): Record<string, number> {
 const aus: Record<string, number> = {};
 for (const [name, v] of Object.entries(eingaben)) if (e[name] && typeof v === 'number' && Number.isFinite(v) && v !== e[name].wert) aus[name] = v;
 return aus;
}
