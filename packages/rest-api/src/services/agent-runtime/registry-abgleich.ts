/**
 * P22-T75: dauerhafter Abgleich der CLI-Modellliste (P22-T61, Container) gegen model_registry. Liefert nur Befunde, legt nie
 * etwas an und rechnet mit keinem geratenen Wert: fehlt eine Claude-Version in der Registry oder weicht ihr Kontext von der
 * CLI-Angabe ab, steht das im Ergebnis (und als Meldung in der Web-UI), die Entscheidung bleibt beim Koordinator/User.
 * Codex-Modelle fuehrt die Registry nicht je Slug: dort gilt das Fenster der CLI-Liste (quelle cli); fehlt es, greift der
 * sichtbare Rueckfall und der Abgleich meldet kontext_fehlt.
 */
import type { CliModellListe } from './cli-modelle.js';

export interface RegistryZeileKurz { alias: string; fullId: string; provider: string; contextWindow: number }

export type AbgleichStatus = 'ok' | 'fehlt_in_registry' | 'kontext_abweichend' | 'kontext_fehlt';

export interface AbgleichBefund {
  modell: string;
  status: AbgleichStatus;
  cli_kontext: number | null;
  /** Registry-Zeilen mit dieser full_id (nur Claude). */
  registry: Array<{ alias: string; kontext: number }>;
}

export interface RegistryAbgleich {
  geprueft: boolean;
  grund: string | null;
  anzahl: { ok: number; fehlt_in_registry: number; kontext_abweichend: number; kontext_fehlt: number };
  befunde: AbgleichBefund[];
  /** Claude-Versionen der Registry, die die CLI-Liste nicht (mehr) anbietet - nur Hinweis. */
  registry_ohne_cli: string[];
  /** Lesbare Zeilen fuer die Web-UI; leer = alles stimmt. */
  meldungen: string[];
}

const tokens = (n: number | null): string => (n === null ? 'unbekannt' : n >= 1_000_000 ? n / 1_000_000 + 'M' : Math.round(n / 1000) + 'k');

export function gleicheCliListeMitRegistry(liste: CliModellListe, registry: readonly RegistryZeileKurz[] | null): RegistryAbgleich {
  const leer = (grund: string): RegistryAbgleich => ({
    geprueft: false, grund, anzahl: { ok: 0, fehlt_in_registry: 0, kontext_abweichend: 0, kontext_fehlt: 0 }, befunde: [], registry_ohne_cli: [], meldungen: [],
  });
  if (!liste.modelle.length) return leer(liste.grund ?? 'keine_modelle');
  if (liste.runtime === 'claude' && !registry) return leer('registry_nicht_lesbar');
  const anzahl = { ok: 0, fehlt_in_registry: 0, kontext_abweichend: 0, kontext_fehlt: 0 };
  const befunde: AbgleichBefund[] = [];
  const meldungen: string[] = [];
  const claudeZeilen = (registry ?? []).filter((r) => r.provider === 'anthropic');
  for (const m of liste.modelle) {
    let status: AbgleichStatus = 'ok';
    let zeilen: Array<{ alias: string; kontext: number }> = [];
    if (liste.runtime === 'claude') {
      zeilen = claudeZeilen.filter((r) => r.fullId === m.id).map((r) => ({ alias: r.alias, kontext: r.contextWindow }));
      if (!zeilen.length) {
        status = 'fehlt_in_registry';
        meldungen.push('Registry kennt ' + m.id + ' nicht (CLI bietet es an' + (m.kontext_ein ? ', Kontext ' + tokens(m.kontext_ein) : '') + ') - Werte belegen und per modelle-Skript anlegen.');
      } else if (m.kontext_ein !== null && !zeilen.some((z) => z.kontext === m.kontext_ein)) {
        status = 'kontext_abweichend';
        meldungen.push(m.id + ': CLI meldet Kontext ' + tokens(m.kontext_ein) + ', Registry fuehrt ' + zeilen.map((z) => z.alias + '=' + tokens(z.kontext)).join(', ') + '.');
      }
    } else if (m.kontext_ein === null) {
      status = 'kontext_fehlt';
      meldungen.push(m.id + ': die CLI-Liste nennt keinen Kontext, es gilt der Rueckfall (272k).');
    }
    anzahl[status]++;
    befunde.push({ modell: m.id, status, cli_kontext: m.kontext_ein, registry: zeilen });
  }
  const imCli = new Set(liste.modelle.map((m) => m.id));
  const registryOhneCli = liste.runtime === 'claude' ? [...new Set(claudeZeilen.map((r) => r.fullId))].filter((id) => !imCli.has(id)).sort() : [];
  return { geprueft: true, grund: null, anzahl, befunde, registry_ohne_cli: registryOhneCli, meldungen };
}
