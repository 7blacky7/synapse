/**
 * P22-T278 (User 08.11.2026, thoughts c3e6c130 / 40f496c6): DeepSeek-API DIREKT als eigener Anbieter 'deepseek-api' neben OpenRouter.
 * TRANSPORT (rest-api api-agent-transport.ts rufeDeepSeek): OpenAI-Format POST <basis>/chat/completions, Basis https://api.deepseek.com
 *   (Env SYNAPSE_DEEPSEEK_BASE_URL nur fuer Tests), Key NUR serverseitig (Env SYNAPSE_DEEPSEEK_API_KEY), nie an die UI; die UI sieht nur
 *   vorhanden/fehlt und die Quelle (Env-Name).
 * MODELLE (model_registry, provider 'deepseek-api', Seed in api-agent-lauf-schema.ts / 164): Preise je 1 Mio. Tokens zum SPITZENTARIF:
 *   pricing_input = Cache-Fehlschuss, pricing_cache = Cache-Treffer, pricing_output = Ausgabe.
 * TARIF (Preisseite 08.11.2026): Spitzenzeit Mo-Fr 01-04 und 06-10 UTC voller Preis, sonst halber Preis. Die Reservierung rechnet immer
 *   zum Spitzenpreis (obere Schranke); gebucht wird nach der usage-Antwort (prompt_cache_hit_tokens/-miss_tokens, completion_tokens)
 *   mal Tarif-Faktor zum Zeitpunkt des ANFRAGEBEGINNS (Reservierung erstellt_am; P3 d Kanal 37424, vorher Abschluss) in core
 *   schliesseApiAufrufAb. Die UI zeigt die Fenster in Ortszeit Europe/Berlin (Debug spitze_utc, web-ui api-tarif-logik.ts).
 * SCHALTER 'api_deepseek_direkt' (Produkt-Schalter, projekt > global, Standard AUS, nur ausdruecklich; intern-Override befristet wie
 *   api_agenten_auswahl): AUS = DeepSeek-Modelle sind sichtbar, aber nicht startbar (Blocker deepseek_aus) und nicht aufrufbar
 *   (Transport funktion_aus). Debug: rest-api apiAuswahlStand().debug.deepseek (Schalter, Key-Quelle, Basis, Tarif jetzt).
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';

export const API_DEEPSEEK_FUNKTION = 'api_deepseek_direkt' as const;
/** Spitzenzeit-Fenster in UTC-Stunden [von, bis), nur Montag bis Freitag. */
export const DEEPSEEK_SPITZE_UTC: ReadonlyArray<readonly [number, number]> = [[1, 4], [6, 10]];
export const DEEPSEEK_NEBENZEIT_FAKTOR = 0.5;

export function deepseekSpitzenzeit(d: Date = new Date()): boolean {
  const tag = d.getUTCDay();
  if (tag === 0 || tag === 6) return false;
  const h = d.getUTCHours();
  return DEEPSEEK_SPITZE_UTC.some(([von, bis]) => h >= von && h < bis);
}

export function deepseekTarif(d: Date = new Date()): { tarif: 'spitze' | 'neben'; faktor: number } {
  return deepseekSpitzenzeit(d) ? { tarif: 'spitze', faktor: 1 } : { tarif: 'neben', faktor: DEEPSEEK_NEBENZEIT_FAKTOR };
}

/** Frisch je Aufruf. Lesefehler -> AUS (letzter_fehler sichtbar). */
export async function leseDeepseekSchalter(project: string | null) {
  const produkt = await leseProfilProduktSchalter(API_DEEPSEEK_FUNKTION, project);
  if (process.env.SYNAPSE_INTERN_TOOL === '1') {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>(
        "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis > NOW()", [API_DEEPSEEK_FUNKTION]);
      if (r.rows[0]) return { ...produkt, aktiv: r.rows[0].aktiv, quelle: 'intern', bis: r.rows[0].bis.toISOString(), letzter_fehler: null };
    } catch { /* Produktstandard; kein unbefristeter Override bei Ausfall. */ }
  }
  return { ...produkt, aktiv: produkt.aktiv && !produkt.letzter_fehler, bis: null };
}
