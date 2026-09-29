/**
 * Kandidaten fuer die Modellwahl per Jev (plan action 'empfehlen', JEV-3).
 *
 * Grundlage (Runde 2, 29.09.2026): jev-criteria-katalog.ts = versionierte Kopie von
 * JEV-Test daten/modellwahl_criteria.json, modular je Modell + Stufe. Hier steht nur,
 * was Synapse daraus macht:
 *   - ZUORDNUNG: volle Modell-ID -> Synapse-Alias (Registry), 1M-Alias.
 *     [1m]-Varianten sind KEINE eigenen criteria, die Kontextgroesse kommt aus der
 *     Noul-Frage "langer Kontext".
 *   - LEGACY: aeltere Claude-Versionen stehen in der Quelle nur im Vorfilter
 *     ("immer raus ausser explizit verlangt") und haben dort keinen Text. Fuer die
 *     ausdrueckliche Nennung gibt es hier zwei allgemeine Bedingungen (Synapse-eigen).
 *
 * Keine Rangliste, keine Kappung: jedes angefragte Modell kommt in die Modell-Choice,
 * seine Stufen in eine eigene Stufen-Choice (Koordinator-Vorgabe 29.09.2026).
 *
 * Stufen: 'default' = ohne Effort (haiku). Claude-Modelle bekommen nur Stufen, die in den
 * criteria UND in model_registry.effort_stufen stehen. Codex/Gemini haben keine Runtime in
 * Synapse; ihre Stufen (none, minimal, low ...) kommen unveraendert aus den criteria.
 */

import type { EffortStufe } from './effort.js';
import { MODELLWAHL_CRITERIA, type KatalogGruppe } from './jev-criteria-katalog.js';

export type JevFamilie = 'anthropic' | 'codex' | 'google';

export interface JevOption {
  /** Stufenname aus den criteria ('default' = ohne Effort) */
  stufe: string;
  /** Ausgeschriebene Bedingung (englisch, aus der Quelle) */
  criterion: string;
}

export interface JevKandidat {
  /** Alias fuer Empfehlung und Spawn (z. B. 'opus', 'gpt-6-astra') */
  alias: string;
  /** Volle Modell-ID (Schluessel in der Quelle) */
  fullId: string;
  familie: JevFamilie;
  /** Eintrag in model_registry (Effort-Stufen, spawnbar). Fehlt = keine Runtime in Synapse. */
  registryAlias?: string;
  /** Spawn-Alias fuer 1M-Kontext. Fehlt = kein 1M im Abo (haiku) bzw. unbekannt. */
  einsMAlias?: string;
  /** Rueckfall fuer Claude, wenn die Registry nicht lesbar ist (wie STATIC_FALLBACK) */
  effortStufen?: EffortStufe[];
  /** Nur auf ausdrueckliche Nennung (Alias oder Gruppe 'legacy'), nie in 'abos'/'alle' */
  legacy?: boolean;
  /** In Quellreihenfolge */
  optionen: JevOption[];
}

/** Stufe ohne Effort-Flag */
export const OHNE_EFFORT = 'default';

// Rueckfall-Stufen wie STATIC_FALLBACK (agents/models.ts); massgeblich ist model_registry.effort_stufen
const ALLE_STUFEN: EffortStufe[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const OHNE_XHIGH: EffortStufe[] = ['low', 'medium', 'high', 'max'];

const FAMILIE_JE_GRUPPE: Record<KatalogGruppe, JevFamilie> = {
  'claude-abo': 'anthropic',
  'codex-abo': 'codex',
  'gemini-api': 'google',
};

/** Volle ID -> Synapse-Alias. Nicht genannte IDs behalten ihre ID als Alias (Codex, Gemini). */
const ZUORDNUNG: Record<string, { alias: string; registryAlias: string; einsMAlias?: string; effortStufen: EffortStufe[] }> = {
  'claude-opus-5-5': { alias: 'opus', registryAlias: 'opus', einsMAlias: 'opus[1m]', effortStufen: ALLE_STUFEN },
  'claude-sonnet-5-5': { alias: 'sonnet', registryAlias: 'sonnet', einsMAlias: 'sonnet', effortStufen: ALLE_STUFEN }, // sonnet ist nativ 1M (29.09.2026 gemessen)
  // fable: 1M nativ
  'claude-fable-5-1': { alias: 'fable', registryAlias: 'fable', einsMAlias: 'fable', effortStufen: ALLE_STUFEN },
  // haiku: 200k, kein Effort
  'claude-haiku-4-5': { alias: 'haiku', registryAlias: 'haiku', effortStufen: [] },
};

function ausKatalog(): JevKandidat[] {
  return Object.entries(MODELLWAHL_CRITERIA.modelle).map(([fullId, eintrag]) => {
    const z = ZUORDNUNG[fullId];
    return {
      alias: z?.alias ?? fullId,
      fullId,
      familie: FAMILIE_JE_GRUPPE[eintrag.gruppe],
      registryAlias: z?.registryAlias,
      einsMAlias: z?.einsMAlias,
      effortStufen: z?.effortStufen,
      optionen: Object.entries(eintrag.stufen).map(([stufe, criterion]) => ({ stufe, criterion })),
    };
  });
}

/** Aeltere Claude-Version: zwei allgemeine Bedingungen (Synapse-eigen, Quelle hat keinen Text). */
function legacy(
  alias: string,
  fullId: string,
  art: { nativ1M?: boolean; ohne1M?: boolean; stufen?: EffortStufe[] } = {},
): JevKandidat {
  return {
    alias, fullId, familie: 'anthropic', registryAlias: alias,
    einsMAlias: art.nativ1M ? alias : art.ohne1M ? undefined : `${alias}[1m]`,
    effortStufen: art.stufen ?? ALLE_STUFEN, legacy: true,
    optionen: [
      { stufe: 'medium', criterion: `The task explicitly needs the older model ${fullId}, and it is ordinary coding or review work.` },
      { stufe: 'xhigh', criterion: `The task explicitly needs the older model ${fullId}, and it is long or hard work that needs deep reasoning.` },
    ],
  };
}

export const JEV_KATALOG: JevKandidat[] = [
  ...ausKatalog(),
  legacy('opus-5', 'claude-opus-5'),
  legacy('sonnet-5', 'claude-sonnet-5'),
  legacy('fable-5', 'claude-fable-5', { nativ1M: true }),
  legacy('opus-4.8', 'claude-opus-4-8'),
  legacy('opus-4.7', 'claude-opus-4-7'),
  legacy('opus-4.6', 'claude-opus-4-6', { stufen: OHNE_XHIGH }),
  // sonnet-4.6[1m] ist nicht im Abo (agents/models.ts)
  legacy('sonnet-4.6', 'claude-sonnet-4-6', { stufen: OHNE_XHIGH, ohne1M: true }),
];

const anthropic = (k: JevKandidat) => !k.legacy && k.familie === 'anthropic';
const codex = (k: JevKandidat) => k.familie === 'codex';
const google = (k: JevKandidat) => k.familie === 'google';

/**
 * Gruppen fuer den Parameter kandidaten; die Gruppennamen der Quelle gelten mit.
 * Standard 'anthropic' (nur Claude-CLI, User-Entscheidung 29.09.2026): Codex/Gemini erst,
 * wenn deren Runtime in Synapse steht — bis dahin nur auf ausdrueckliche Nennung.
 */
export const JEV_GRUPPEN: Record<string, (k: JevKandidat) => boolean> = {
  abos: (k) => anthropic(k) || codex(k),
  alle: (k) => !k.legacy,
  anthropic,
  'claude-abo': anthropic,
  codex,
  'codex-abo': codex,
  google,
  'gemini-api': google,
  legacy: (k) => k.legacy === true,
};

export const JEV_STANDARD_KANDIDATEN = 'anthropic';
