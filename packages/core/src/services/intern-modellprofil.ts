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

import { aktuelleAgentAkteurIdentityId } from './agent-bezug.js';
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
import { searchTasks, searchPlans } from './plan-suche.js';
import { globalSearch } from './global-search.js';
import { searchTechDocs } from './tech-docs.js';

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
  /** Wird in die vorhandenen Messwerte gemischt - wie, sagt messwerte_modus. */
  messwerte?: Record<string, unknown>;
  /**
   * P15-T18: 'tief' (Standard) mischt rekursiv, null entfernt einen Schluessel; 'oben' ersetzt nur die
   * Schluessel der obersten Ebene (Verhalten vor T18 - ein Teil-Objekt ersetzte den ganzen Zweck);
   * 'ersetzen' setzt das gesamte messwerte-Objekt neu.
   */
  messwerte_modus?: string;
  agent?: string;
}

export const MESSWERTE_MODI = ['tief', 'oben', 'ersetzen'] as const;

function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rekursiv mischen: Objekte werden zusammengefuehrt, null entfernt den Schluessel, alles andere ersetzt. */
export function mischeTief(alt: unknown, neu: Record<string, unknown>): Record<string, unknown> {
  const ergebnis: Record<string, unknown> = istObjekt(alt) ? { ...alt } : {};
  for (const [k, v] of Object.entries(neu)) {
    if (v === null) delete ergebnis[k];
    else if (istObjekt(v)) ergebnis[k] = mischeTief(ergebnis[k], v);
    else ergebnis[k] = v;
  }
  return ergebnis;
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
  const modus = aenderung.messwerte_modus ?? 'tief';
  if (!(MESSWERTE_MODI as readonly string[]).includes(modus)) {
    throw new InternModellprofilFehler('parameter_ungueltig', `messwerte_modus: ${MESSWERTE_MODI.join(' | ')}.`);
  }
  if (spalten.length === 0 && Object.keys(neueSchwellen).length === 0 && entfernt.length === 0 && aenderung.messwerte === undefined) {
    throw new InternModellprofilFehler('parameter_fehlt', 'Nichts zu setzen: mindestens ein Feld, score_schwellen oder messwerte angeben.');
  }

  // P15-T18: tief/ersetzen brauchen den alten Stand -> in einer Transaktion lesen (FOR UPDATE) und das
  // fertige Objekt schreiben. 'oben' (und ohne messwerte) bleibt beim jsonb || auf oberster Ebene.
  const ganzesObjekt = aenderung.messwerte !== undefined && modus !== 'oben';
  const client = ganzesObjekt ? await getPool().connect() : null;
  try {
  let messwerteNeu: Record<string, unknown> = aenderung.messwerte ?? {};
  if (client) {
    await client.query('BEGIN');
    const alt = await client.query<{ messwerte: unknown }>(
      'SELECT messwerte FROM embedding_modell_profile WHERE modell = $1 AND digest = $2 FOR UPDATE', [modell, digest],
    );
    messwerteNeu = modus === 'ersetzen' ? mischeTief({}, messwerteNeu) : mischeTief(alt.rows[0]?.messwerte ?? {}, messwerteNeu);
  }
  const n = werte.length;
  werte.push(JSON.stringify(neueSchwellen), entfernt, JSON.stringify(messwerteNeu), aenderung.agent ?? null, aktuelleAgentAkteurIdentityId(aenderung.agent));
  const pS = n + 1, pR = n + 2, pM = n + 3, pV = n + 4, pI = n + 5;
  const einfuegeSpalten = ['modell', 'digest', ...spalten, 'score_schwellen', 'messwerte', 'kalibriert_am', 'kalibriert_von', 'calibrator_identity_id'];
  const einfuegeWerte = ['$1', '$2', ...spalten.map((_, i) => '$' + (i + 3)), `$${pS}::jsonb`, `$${pM}::jsonb`, 'NOW()', `$${pV}`, `$${pI}`];
  const update = [
    ...spalten.map((s) => `${s} = EXCLUDED.${s}`),
    `score_schwellen = (p.score_schwellen || $${pS}::jsonb) - $${pR}::text[]`,
    ganzesObjekt ? `messwerte = $${pM}::jsonb` : `messwerte = COALESCE(p.messwerte, '{}'::jsonb) || $${pM}::jsonb`,
    'kalibriert_am = NOW()',
    'kalibriert_von = EXCLUDED.kalibriert_von',
    'calibrator_identity_id = EXCLUDED.calibrator_identity_id',
    'aktualisiert_am = NOW()',
  ];
  const { rows } = await (client ?? getPool()).query(
    `INSERT INTO embedding_modell_profile AS p (${einfuegeSpalten.join(', ')})
     VALUES (${einfuegeWerte.join(', ')})
     ON CONFLICT (modell, digest) DO UPDATE SET ${update.join(', ')}
     RETURNING ${PROFIL_SPALTEN}`,
    werte,
  );
  if (client) await client.query('COMMIT');
  // Dieser Prozess liest beim naechsten Zugriff neu; andere Prozesse nach SYNAPSE_MODELLPROFIL_TTL_MS.
  vergissModellprofil();
  return { profil: rows[0], messwerte_modus: modus, hinweis: 'Gilt in diesem Prozess sofort, in anderen nach dem Cache-Intervall (SYNAPSE_MODELLPROFIL_TTL_MS, Standard 60 s).' };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client?.release();
  }
}

// ───── Kalibrieren ──────────────────────────────────────────────────────

/** Eine Mess-Anfrage. framework nur fuer tech_docs_gut (Qdrant-Filter wie searchTechDocs). */
export interface KalibrierAnfrage { query: string; erwartet?: string; framework?: string }

export interface KalibrierAuftrag {
  zweck: string;
  /**
   * Anfragen, die einen Treffer liefern SOLLEN; erwartet = Teil des Namens/Pfads des richtigen Treffers
   * (error_patterns: ID-Anfang ODER Teil der Beschreibung). Text oder {query, erwartet?, framework?}.
   */
  passend: Array<string | KalibrierAnfrage>;
  /** Anfragen, zu denen NICHTS passen soll ("ok mach weiter", "danke" ...). Text oder {query, framework?}. */
  rauschen: Array<string | KalibrierAnfrage>;
  /** Fuer graph_code, graph_wissen, code_semantic_fallback (sonst Filter fuer global_search). */
  project?: string;
  schreiben?: boolean;
  agent?: string;
}

interface Treffer { name: string; score: number }

const KALIBRIERBAR: ScoreZweck[] = ['tasks', 'plans', 'hook', 'channel_skill', 'global_search', 'graph_code', 'code_semantic_fallback', 'graph_wissen', 'error_patterns', 'tech_docs_gut'];

/** Text oder Objekt -> KalibrierAnfrage; leere Anfragen fallen weg (Connector schickt evtl. JSON-Text). */
export function normalisiereAnfragen(roh: unknown[]): KalibrierAnfrage[] {
  return roh.map((p): KalibrierAnfrage => {
    if (typeof p === 'string') return { query: p };
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      query: String(o.query ?? ''),
      erwartet: o.erwartet ? String(o.erwartet) : undefined,
      framework: o.framework ? String(o.framework) : undefined,
    };
  }).filter((p) => p.query.trim() !== '');
}

async function suche(zweck: ScoreZweck, query: string, project?: string, framework?: string): Promise<Treffer[]> {
  const brauchtProjekt = (): string => {
    if (!project) throw new InternModellprofilFehler('parameter_fehlt', `Zweck ${zweck} misst in einem Projekt: project angeben.`);
    return project;
  };
  switch (zweck) {
    case 'tasks':
    case 'plans':
      return (await (zweck === 'tasks' ? searchTasks : searchPlans)(query, brauchtProjekt(), { alle: true, limit: 10 }))
        .results.map(r => ({ name: `${r.kurz_id ?? r.id}: ${r.title}`, score: r.score }));
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
      // P15-T18: die Qdrant-Payload traegt keine Beschreibung -> aus PG dazuholen. Name = "<id>: <Beschreibung>",
      // damit erwartet als ID-Anfang ODER als Teil der Beschreibung passt.
      const vektor = await embed(query, { art: 'query' });
      const treffer = await searchVectors(COLLECTIONS.globalErrorPatterns, vektor, 10);
      const ids = treffer.map((r) => String(r.id)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const beschreibung = new Map<string, string>();
      if (ids.length > 0) {
        const { rows } = await getPool().query<{ id: string; description: string }>(
          'SELECT id::text, description FROM error_patterns WHERE id = ANY($1::uuid[])', [ids],
        );
        for (const r of rows) beschreibung.set(r.id.toLowerCase(), r.description);
      }
      return treffer.map((r) => {
        const id = String(r.id);
        const text = beschreibung.get(id.toLowerCase()) ?? String((r.payload as Record<string, unknown>)?.description ?? '');
        return { name: (text ? `${id}: ${text}` : id).slice(0, 160), score: r.score };
      });
    }
    case 'tech_docs_gut':
      // P15-T18: derselbe Weg wie searchTechDocs (scope all, framework-Filter), aber ohne Context7-Nachladen.
      return (await searchTechDocs(query, { framework, project, scope: 'all', limit: 10, ohneNachladen: true }))
        .map((r) => ({ name: `${r.framework ?? ''}:${r.section ?? ''}:${r.id}`, score: r.score ?? 0 }));
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
  const passendAnfragen = normalisiereAnfragen(auftrag.passend);
  const rauschAnfragen = normalisiereAnfragen(auftrag.rauschen);
  if (passendAnfragen.length === 0 || rauschAnfragen.length === 0) {
    throw new InternModellprofilFehler('parameter_fehlt', 'passend und rauschen brauchen je mindestens eine Anfrage (besser 10+ bzw. 5+).');
  }
  const passend = [];
  for (const p of passendAnfragen) {
    const treffer = (await suche(zweck, p.query, auftrag.project, p.framework)).sort((a, b) => b.score - a.score);
    const richtig = p.erwartet
      ? treffer.find((t) => t.name.toLowerCase().includes(p.erwartet!.toLowerCase()))
      : treffer[0];
    passend.push({
      query: p.query,
      ...(p.framework ? { framework: p.framework } : {}),
      erwartet: p.erwartet ?? null,
      score: richtig ? rund(richtig.score) : null,
      rang: richtig ? treffer.indexOf(richtig) + 1 : null,
      bester: treffer[0] ? { name: treffer[0].name, score: rund(treffer[0].score) } : null,
    });
  }
  const rauschen = [];
  for (const r of rauschAnfragen) {
    const treffer = (await suche(zweck, r.query, auftrag.project, r.framework)).sort((a, b) => b.score - a.score);
    rauschen.push({ query: r.query, ...(r.framework ? { framework: r.framework } : {}), bester: treffer[0] ? { name: treffer[0].name, score: rund(treffer[0].score) } : null });
  }

  const passendScores = passend.map((p) => p.score).filter((s): s is number => s !== null).sort((a, b) => a - b);
  const rauschScores = rauschen.map((r) => r.bester?.score).filter((s): s is number => s !== undefined);
  const passendMin = passendScores[0] ?? null;
  const rauschenMax = rauschScores.length > 0 ? Math.max(...rauschScores) : null;
  const nichtGefunden = passend.filter((p) => p.score === null).map((p) => p.query);
  const trennbar = passendMin !== null && rauschenMax !== null && passendMin > rauschenMax;
  const vorschlag = trennbar ? rund((passendMin! + rauschenMax!) / 2) : null;
  const durchgelassen = vorschlag === null ? null : {
    passend: `${passendScores.filter((s) => s >= vorschlag).length}/${passendAnfragen.length}`,
    rauschen: `${rauschScores.filter((s) => s >= vorschlag).length}/${rauschAnfragen.length}`,
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
            n_passend: passendAnfragen.length, n_rauschen: rauschAnfragen.length, nicht_gefunden: nichtGefunden.length,
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
