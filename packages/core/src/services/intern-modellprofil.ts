/**
 * MODUL: Intern-Modellprofil (P15-T8)
 * ZWECK: Pflege der Tabelle embedding_modell_profile ueber das intern-Tool - anzeigen, setzen und
 *        kalibrieren. Die Kalibrierung misst wie in P15-T3: passende Anfragen gegen Rauschen, schlaegt
 *        die Mitte zwischen schwaechstem passenden und staerkstem Rausch-Treffer vor und schreibt sie
 *        nur mit schreiben:true (und nur, wenn beide Gruppen sauber getrennt sind) ins Profil.
 * GRENZEN: Schreibt ausschliesslich embedding_modell_profile. Gemessen wird immer mit dem AKTIVEN
 *   Modell (die Suchen laufen ueber den normalen Weg) - ein anderes Modell laesst sich hier nicht
 *   kalibrieren, nur von Hand setzen.
 */

import { getPool } from '../db/client.js';
import { embed } from '../embeddings/index.js';
import {
  PROFIL_SPALTEN,
  SCORE_ZWECKE,
  embeddingModellName,
  modellprofilStand,
  vergissModellprofil,
  type ScoreZweck,
} from '../embeddings/modell-profil.js';
import { searchVectors } from '../qdrant/index.js';
import { COLLECTIONS } from '../types/index.js';
import { searchSkills } from './skills.js';
import { searchCode } from './code.js';
import { searchMemories } from './memory.js';
import { searchThoughts } from './thoughts.js';
import { globalSearch } from './global-search.js';

export class InternModellprofilFehler extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InternModellprofilFehler';
  }
}

/** undefined = unveraendert, null = auf "nicht kalibriert" (NULL) setzen. */
export interface ProfilAenderung {
  modell?: string;
  digest?: string;
  query_praefix?: string | null;
  dok_praefix?: string | null;
  ziel_dimension?: number | null;
  num_ctx?: number | null;
  num_batch?: number | null;
  max_stueck_zeichen?: number | null;
  /** Zweck -> Schwelle; null entfernt den Zweck. Nicht genannte Zwecke bleiben. */
  score_schwellen?: Record<string, number | null>;
  notiz?: string | null;
  /** Wird in die vorhandenen Messwerte gemischt (jsonb ||), nicht ersetzt. */
  messwerte?: Record<string, unknown>;
  agent?: string;
}

const GANZZAHL_FELDER = ['ziel_dimension', 'num_ctx', 'num_batch', 'max_stueck_zeichen'] as const;
const TEXT_FELDER = ['query_praefix', 'dok_praefix', 'notiz'] as const;

function normalDigest(digest: string | undefined): string {
  const d = (digest ?? '').trim().toLowerCase().replace(/^sha256:/, '');
  if (d !== '' && !/^[a-f0-9]{12,64}$/.test(d)) {
    throw new InternModellprofilFehler('parameter_ungueltig', 'digest: leer (= jeder Digest) oder sha256-Anfang mit 12..64 Hex-Zeichen.');
  }
  return d;
}

function istZweck(z: string): z is ScoreZweck {
  return Object.prototype.hasOwnProperty.call(SCORE_ZWECKE, z);
}

/** Alle Profile (oder die eines Modells) samt Stand des aktiven Modells und Pruefhinweisen. */
export async function modellprofilAnzeigen(modell?: string): Promise<Record<string, unknown>> {
  const stand = await modellprofilStand({ neu: true });
  const { rows } = await getPool().query(
    `SELECT ${PROFIL_SPALTEN}, angelegt_am FROM embedding_modell_profile` +
      (modell ? ' WHERE modell = $1' : '') + ' ORDER BY modell, digest',
    modell ? [modell] : [],
  );
  const aktiv = stand.profil;
  const pruefung: string[] = [];
  let fehlendeZwecke: string[] = Object.keys(SCORE_ZWECKE);
  if (aktiv) {
    fehlendeZwecke = fehlendeZwecke.filter((z) => !(z in aktiv.scoreSchwellen));
    if (aktiv.queryPraefix === null) pruefung.push('query_praefix nicht gesetzt - Suchanfragen scheitern mit modell_nicht_kalibriert (ausser EMBEDDING_QUERY_PREFIX ist gesetzt).');
    if (aktiv.dokPraefix === null) pruefung.push('dok_praefix nicht gesetzt - Einbetten scheitert mit modell_nicht_kalibriert (ausser EMBEDDING_DOC_PREFIX ist gesetzt).');
    const envZiel = Number(process.env.EMBEDDING_TARGET_DIM) || null;
    if (aktiv.zielDimension !== null && envZiel !== null && aktiv.zielDimension !== envZiel) {
      pruefung.push(`ziel_dimension im Profil (${aktiv.zielDimension}) weicht von EMBEDDING_TARGET_DIM (${envZiel}) ab - wirksam ist die Env.`);
    }
    const envCtx = Number(process.env.EMBEDDING_NUM_CTX) || null;
    if (aktiv.numCtx !== null && envCtx !== null && aktiv.numCtx !== envCtx) {
      pruefung.push(`EMBEDDING_NUM_CTX (${envCtx}) uebersteuert num_ctx des Profils (${aktiv.numCtx}).`);
    }
    if (aktiv.maxStueckZeichen === null && aktiv.numBatch === null && !process.env.EMBEDDING_MAX_INPUT_CHARS) {
      pruefung.push('weder max_stueck_zeichen noch num_batch gesetzt - lange Texte werden erst nach einer Ablehnung von Ollama geteilt.');
    }
  }
  return {
    aktiv: { modell: stand.modell, digest: stand.digest, kalibriert: aktiv !== null, grund: stand.grund, profil: aktiv },
    fehlende_zwecke: fehlendeZwecke,
    pruefung,
    zwecke: SCORE_ZWECKE,
    profile: rows,
  };
}

/** Legt ein Profil an oder aendert es (nur die uebergebenen Felder). */
export async function modellprofilSetzen(aenderung: ProfilAenderung): Promise<Record<string, unknown>> {
  const modell = (aenderung.modell ?? '').trim() || embeddingModellName();
  const digest = normalDigest(aenderung.digest);

  const spalten: string[] = [];
  const werte: unknown[] = [modell, digest];
  const setze = (spalte: string, wert: unknown): void => {
    werte.push(wert);
    spalten.push(spalte);
  };
  for (const feld of GANZZAHL_FELDER) {
    const wert = aenderung[feld];
    if (wert === undefined) continue;
    if (wert !== null && !(Number.isInteger(wert) && wert > 0)) {
      throw new InternModellprofilFehler('parameter_ungueltig', `${feld}: positive ganze Zahl oder null (= nicht kalibriert).`);
    }
    setze(feld, wert);
  }
  for (const feld of TEXT_FELDER) {
    const wert = aenderung[feld];
    if (wert === undefined) continue;
    if (wert !== null && typeof wert !== 'string') throw new InternModellprofilFehler('parameter_ungueltig', `${feld}: Text oder null.`);
    setze(feld, wert);
  }

  const neueSchwellen: Record<string, number> = {};
  const entfernt: string[] = [];
  for (const [zweck, wert] of Object.entries(aenderung.score_schwellen ?? {})) {
    if (!istZweck(zweck)) {
      throw new InternModellprofilFehler('parameter_ungueltig', `score_schwellen: unbekannter Zweck "${zweck}" (${Object.keys(SCORE_ZWECKE).join(', ')}).`);
    }
    if (wert === null) { entfernt.push(zweck); continue; }
    if (typeof wert !== 'number' || !Number.isFinite(wert) || wert < -1 || wert > 1) {
      throw new InternModellprofilFehler('parameter_ungueltig', `score_schwellen.${zweck}: Zahl zwischen -1 und 1 (Cosinus-Skala) oder null zum Entfernen.`);
    }
    neueSchwellen[zweck] = wert;
  }
  if (aenderung.messwerte !== undefined && (typeof aenderung.messwerte !== 'object' || aenderung.messwerte === null || Array.isArray(aenderung.messwerte))) {
    throw new InternModellprofilFehler('parameter_ungueltig', 'messwerte: Objekt (wird in die vorhandenen Messwerte gemischt).');
  }
  if (spalten.length === 0 && Object.keys(neueSchwellen).length === 0 && entfernt.length === 0 && aenderung.messwerte === undefined) {
    throw new InternModellprofilFehler('parameter_fehlt', 'Nichts zu setzen: mindestens ein Feld, score_schwellen oder messwerte angeben.');
  }

  const n = werte.length;
  werte.push(JSON.stringify(neueSchwellen), entfernt, JSON.stringify(aenderung.messwerte ?? {}), aenderung.agent ?? null);
  const pS = n + 1, pR = n + 2, pM = n + 3, pV = n + 4;
  const einfuegeSpalten = ['modell', 'digest', ...spalten, 'score_schwellen', 'messwerte', 'kalibriert_am', 'kalibriert_von'];
  const einfuegeWerte = ['$1', '$2', ...spalten.map((_, i) => '$' + (i + 3)), `$${pS}::jsonb`, `$${pM}::jsonb`, 'NOW()', `$${pV}`];
  const update = [
    ...spalten.map((s) => `${s} = EXCLUDED.${s}`),
    `score_schwellen = (p.score_schwellen || $${pS}::jsonb) - $${pR}::text[]`,
    `messwerte = COALESCE(p.messwerte, '{}'::jsonb) || $${pM}::jsonb`,
    'kalibriert_am = NOW()',
    'kalibriert_von = EXCLUDED.kalibriert_von',
    'aktualisiert_am = NOW()',
  ];
  const { rows } = await getPool().query(
    `INSERT INTO embedding_modell_profile AS p (${einfuegeSpalten.join(', ')})
     VALUES (${einfuegeWerte.join(', ')})
     ON CONFLICT (modell, digest) DO UPDATE SET ${update.join(', ')}
     RETURNING ${PROFIL_SPALTEN}`,
    werte,
  );
  // Dieser Prozess liest beim naechsten Zugriff neu; andere Prozesse nach SYNAPSE_MODELLPROFIL_TTL_MS.
  vergissModellprofil();
  return { profil: rows[0], hinweis: 'Gilt in diesem Prozess sofort, in anderen nach dem Cache-Intervall (SYNAPSE_MODELLPROFIL_TTL_MS, Standard 60 s).' };
}

// ───── Kalibrieren ──────────────────────────────────────────────────────

export interface KalibrierAuftrag {
  zweck: string;
  /** Anfragen, die einen Treffer liefern SOLLEN; erwartet = Teil des Namens/Pfads des richtigen Treffers. */
  passend: Array<{ query: string; erwartet?: string }>;
  /** Anfragen, zu denen NICHTS passen soll ("ok mach weiter", "danke" ...). */
  rauschen: string[];
  /** Fuer graph_code, graph_wissen, code_semantic_fallback (sonst Filter fuer global_search). */
  project?: string;
  schreiben?: boolean;
  agent?: string;
}

interface Treffer { name: string; score: number }

const KALIBRIERBAR: ScoreZweck[] = ['hook', 'channel_skill', 'global_search', 'graph_code', 'code_semantic_fallback', 'graph_wissen', 'error_patterns'];

async function suche(zweck: ScoreZweck, query: string, project?: string): Promise<Treffer[]> {
  const brauchtProjekt = (): string => {
    if (!project) throw new InternModellprofilFehler('parameter_fehlt', `Zweck ${zweck} misst in einem Projekt: project angeben.`);
    return project;
  };
  switch (zweck) {
    case 'hook':
    case 'channel_skill':
      return (await searchSkills(query, 10)).map((h) => ({ name: h.skill_name, score: h.score }));
    case 'global_search':
      return (await globalSearch(query, { minScore: -1, limit: 10, projectFilter: project ? [project] : undefined }))
        .results.map((r) => ({ name: `${r.type}:${r.project}:${r.id}`, score: r.score }));
    case 'graph_code':
    case 'code_semantic_fallback':
      return (await searchCode(query, brauchtProjekt(), undefined, 10))
        .map((r) => ({ name: String(r.payload?.file_path ?? ''), score: r.score }));
    case 'graph_wissen': {
      const p = brauchtProjekt();
      const [mem, tho] = await Promise.all([searchMemories(query, p, 8), searchThoughts(query, p, 8)]);
      return [
        ...mem.map((r) => ({ name: `memory:${String(r.payload?.name ?? '')}`, score: r.score })),
        ...tho.map((r) => ({ name: `thought:${String(r.id)}`, score: r.score })),
      ];
    }
    case 'error_patterns': {
      const vektor = await embed(query, { art: 'query' });
      return (await searchVectors(COLLECTIONS.globalErrorPatterns, vektor, 10))
        .map((r) => ({ name: String((r.payload as Record<string, unknown>)?.description ?? r.id).slice(0, 80), score: r.score }));
    }
    default:
      throw new InternModellprofilFehler(
        'kalibrierung_nicht_unterstuetzt',
        `Zweck ${zweck} laesst sich nicht automatisch messen (kalibrierbar: ${KALIBRIERBAR.join(', ')}) - Wert mit modellprofil_setzen eintragen.`,
      );
  }
}

const rund = (x: number): number => Math.round(x * 1000) / 1000;

/** Misst passend vs. Rauschen fuer einen Zweck mit dem aktiven Modell und schlaegt eine Schwelle vor. */
export async function modellprofilKalibrieren(auftrag: KalibrierAuftrag): Promise<Record<string, unknown>> {
  const zweck = auftrag.zweck;
  if (!istZweck(zweck)) {
    throw new InternModellprofilFehler('parameter_ungueltig', `zweck: ${Object.keys(SCORE_ZWECKE).join(' | ')}.`);
  }
  if (auftrag.passend.length === 0 || auftrag.rauschen.length === 0) {
    throw new InternModellprofilFehler('parameter_fehlt', 'passend und rauschen brauchen je mindestens eine Anfrage (besser 10+ bzw. 5+).');
  }
  const passend = [];
  for (const p of auftrag.passend) {
    const treffer = (await suche(zweck, p.query, auftrag.project)).sort((a, b) => b.score - a.score);
    const richtig = p.erwartet
      ? treffer.find((t) => t.name.toLowerCase().includes(p.erwartet!.toLowerCase()))
      : treffer[0];
    passend.push({
      query: p.query,
      erwartet: p.erwartet ?? null,
      score: richtig ? rund(richtig.score) : null,
      rang: richtig ? treffer.indexOf(richtig) + 1 : null,
      bester: treffer[0] ? { name: treffer[0].name, score: rund(treffer[0].score) } : null,
    });
  }
  const rauschen = [];
  for (const query of auftrag.rauschen) {
    const treffer = (await suche(zweck, query, auftrag.project)).sort((a, b) => b.score - a.score);
    rauschen.push({ query, bester: treffer[0] ? { name: treffer[0].name, score: rund(treffer[0].score) } : null });
  }

  const passendScores = passend.map((p) => p.score).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const rauschScores = rauschen.map((r) => r.bester?.score).filter((s): s is number => s !== undefined);
  const passendMin = passendScores[0] ?? null;
  const rauschenMax = rauschScores.length > 0 ? Math.max(...rauschScores) : null;
  const nichtGefunden = passend.filter((p) => p.score === null).map((p) => p.query);
  const trennbar = passendMin !== null && rauschenMax !== null && passendMin > rauschenMax;
  const vorschlag = trennbar ? rund((passendMin! + rauschenMax!) / 2) : null;
  const durchgelassen = vorschlag === null ? null : {
    passend: `${passendScores.filter((s) => s >= vorschlag).length}/${auftrag.passend.length}`,
    rauschen: `${rauschScores.filter((s) => s >= vorschlag).length}/${auftrag.rauschen.length}`,
  };
  const stand = await modellprofilStand();
  const ergebnis: Record<string, unknown> = {
    zweck,
    modell: stand.modell,
    digest: stand.digest,
    passend_min: passendMin,
    passend_median: passendScores.length > 0 ? passendScores[Math.floor(passendScores.length / 2)] : null,
    rauschen_max: rauschenMax,
    trennbar,
    vorschlag,
    durchgelassen,
    nicht_gefunden: nichtGefunden,
    passend,
    rauschen,
  };
  if (!trennbar) {
    ergebnis.hinweis = 'Passende und Rausch-Anfragen ueberlappen (oder eine Gruppe ohne Treffer) - kein Vorschlag. Anfragen pruefen oder Schwelle bewusst von Hand setzen.';
  }
  if (auftrag.schreiben) {
    if (!trennbar || vorschlag === null) {
      ergebnis.geschrieben = false;
    } else {
      const gesetzt = await modellprofilSetzen({
        modell: stand.modell,
        digest: stand.profil?.digest ?? '',
        score_schwellen: { [zweck]: vorschlag },
        messwerte: {
          [zweck]: {
            am: new Date().toISOString(),
            passend_min: passendMin, passend_median: ergebnis.passend_median, rauschen_max: rauschenMax,
            n_passend: auftrag.passend.length, n_rauschen: auftrag.rauschen.length, nicht_gefunden: nichtGefunden.length,
          },
        },
        agent: auftrag.agent,
      });
      ergebnis.geschrieben = true;
      ergebnis.profil = gesetzt.profil;
    }
  }
  return ergebnis;
}
