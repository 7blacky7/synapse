/**
 * MODUL: Neu-Einbetten nach Modellwechsel (P12-T12)
 * ZWECK: Baut den Qdrant-Index aus PostgreSQL neu auf — in-place, ueber die vorhandenen Nachzuege.
 *
 * USER-ENTSCHEID 11.10.2026: keine parallelen Collections, keine zweite Qdrant. PostgreSQL ist die
 * Quelle der Wahrheit und code_intel arbeitet ohne Embeddings; waehrend des Neuaufbaus ist nur die
 * semantische Suche unvollstaendig. Vorher wurden alle Qdrant-Payloads gesichert (Thought 2930f82c).
 *
 * ABLAUF mit ausfuehren:true
 *   1. Jede VERALTETE Collection (andere Dimension, andere Modell-Kennung oder nicht als 'angelegt'
 *      registriert) wird geloescht und sofort leer mit der aktuellen Dimension neu angelegt — die
 *      Suche wirft so keinen Fehler, sie findet nur weniger, bis der Nachzug durch ist.
 *   2. embedded_at der zugehoerigen PG-Zeilen -> NULL. Code ueber resetProjectEmbeddings (setzt auch
 *      code_files.indexed_at, sonst greift der Idempotenz-Skip in parseAndEmbed).
 *   3. Zeilen, deren Ziel-Collection gar nicht existiert, bekommen ebenfalls NULL.
 *   4. Den Rest machen die vorhandenen Nachzuege: embed-backlog (Wissen, Plaene, Error-Patterns,
 *      Tech-Docs, Skills) und Parser-Worker/GPU-Claims (Code). Schneller: intern(nachzug_jetzt).
 * NICHT ANGEFASST: *_media (nur aus Originaldateien, P13) und unbekannte Collection-Namen — beides
 *   wird nur gemeldet. Skills nur, wenn sie in der Synapse-Qdrant liegen.
 * ⚠️ ERST NACH DEM UMSCHALTEN DER MODELL-ENV AUSFUEHREN (P12-T14). Vorher wuerde mit dem alten
 *   Modell neu eingebettet. Ohne ausfuehren:true nur Vorschau.
 */

import { getPool } from '../db/client.js';
import { listCollections, getCollectionVectorSize, deleteCollection, ensureCollection } from '../qdrant/collections.js';
import { getEmbeddingDimension } from '../embeddings/index.js';
import { embeddingModellKennung, sichereModellprofil } from '../embeddings/modell-profil.js';
import { COLLECTIONS } from '../types/index.js';
import { resetProjectEmbeddings } from './code.js';
/** P22-T157: Name wie VERLAUF_COLLECTION in verlauf-einbetten.ts (dort exportiert); hier ohne Import, sonst Importzyklus ueber intern-tool. */
const VERLAUF_COLLECTION = 'agent_verlauf';

export const NEU_EINBETTEN_ARTEN = [
  'code', 'memories', 'thoughts', 'proposals', 'plans', 'tasks', 'docs', 'tech_docs_cache', 'error_patterns', 'skills',
  // P22-T157: Sitzungsverlaeufe (verlauf_stuecke -> agent_verlauf); Zuruecksetzen bettet dieselben Stuecke mit denselben IDs neu ein.
  'verlauf',
] as const;
export type NeuEinbettenArt = (typeof NEU_EINBETTEN_ARTEN)[number];

const SKILL_COLLECTION = process.env.SKILL_COLLECTION || 'skills';
/** Skills in einer eigenen Qdrant? Dann kann ensureCollection (spricht QDRANT_URL an) sie nicht anlegen. */
const SKILLS_GETRENNT = !!process.env.SKILL_QDRANT_URL && process.env.SKILL_QDRANT_URL !== process.env.QDRANT_URL;

interface Einordnung {
  art: NeuEinbettenArt | 'media' | 'unbekannt';
  project: string | null;
}

/** Collection-Name -> Art und Projekt (Gegenstueck zu COLLECTIONS). */
export function ordneCollectionEin(name: string): Einordnung {
  if (name === COLLECTIONS.techDocs) return { art: 'tech_docs_cache', project: null };
  if (name === COLLECTIONS.globalErrorPatterns) return { art: 'error_patterns', project: null };
  if (name === SKILL_COLLECTION) return { art: 'skills', project: null };
  if (name === VERLAUF_COLLECTION) return { art: 'verlauf', project: null };
  const m = /^project_(.+)_(code|media|memories|thoughts|plans|tasks|proposals|docs)$/.exec(name);
  if (!m) return { art: 'unbekannt', project: null };
  return { art: m[2] as Einordnung['art'], project: m[1] };
}

/** PG-Zeilen hinter einer Art: Tabelle + Bedingung ($1 = Projekt, falls mitProjekt). */
const PG_QUELLE: Record<Exclude<NeuEinbettenArt, 'code'>, { tabelle: string; wo: string; mitProjekt: boolean }> = {
  memories: { tabelle: 'memories', wo: 'project = $1', mitProjekt: true },
  thoughts: { tabelle: 'thoughts', wo: 'project = $1', mitProjekt: true },
  proposals: { tabelle: 'proposals', wo: 'project = $1', mitProjekt: true },
  plans: { tabelle: 'plans', wo: 'project = $1', mitProjekt: true },
  tasks: { tabelle: 'plan_tasks', wo: 'project = $1', mitProjekt: true },
  docs: { tabelle: 'tech_docs', wo: 'project = $1', mitProjekt: true },
  tech_docs_cache: { tabelle: 'tech_docs', wo: 'project IS NULL', mitProjekt: false },
  error_patterns: { tabelle: 'error_patterns', wo: 'TRUE', mitProjekt: false },
  skills: { tabelle: 'skill_sections', wo: 'TRUE', mitProjekt: false },
  verlauf: { tabelle: 'verlauf_stuecke', wo: 'TRUE', mitProjekt: false },
};

function zielCollection(art: NeuEinbettenArt, project: string | null): string {
  const p = project ?? '';
  switch (art) {
    case 'code': return COLLECTIONS.projectCode(p);
    case 'memories': return COLLECTIONS.projectMemories(p);
    case 'thoughts': return COLLECTIONS.projectThoughts(p);
    case 'proposals': return COLLECTIONS.projectProposals(p);
    case 'plans': return COLLECTIONS.projectPlans(p);
    case 'tasks': return COLLECTIONS.projectTasks(p);
    case 'docs': return COLLECTIONS.projectDocs(p);
    case 'tech_docs_cache': return COLLECTIONS.techDocs;
    case 'error_patterns': return COLLECTIONS.globalErrorPatterns;
    case 'skills': return SKILL_COLLECTION;
    case 'verlauf': return VERLAUF_COLLECTION;
  }
}

interface Ziel {
  collection: string;
  art: NeuEinbettenArt;
  project: string | null;
}

interface VeralteteCollection extends Ziel {
  gruende: string[];
  pg_zeilen: number;
}

export interface NeuEinbettenOptionen {
  /** true = wirklich ausfuehren, sonst nur Vorschau. */
  ausfuehren?: boolean;
  /** Nur diese Arten (NEU_EINBETTEN_ARTEN), sonst alle. */
  arten?: string[];
}

async function zaehleZeilen(art: NeuEinbettenArt, project: string | null): Promise<number> {
  if (art === 'code') {
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM code_chunks WHERE project = $1', [project]);
    return rows[0].n;
  }
  const q = PG_QUELLE[art];
  const { rows } = await getPool().query(
    `SELECT count(*)::int AS n FROM ${art === 'skills' ? '(SELECT embedded_at FROM skill_sections UNION ALL SELECT embedded_at FROM agent_identitaet_skill_sections) skill_gesamt' : q.tabelle} WHERE ${q.wo}`,
    q.mitProjekt ? [project] : [],
  );
  return rows[0].n;
}

/** embedded_at -> NULL; Code ueber resetProjectEmbeddings (loescht und legt die Collection selbst neu an). */
async function setzeZurueck(art: NeuEinbettenArt, project: string | null): Promise<number> {
  if (art === 'code') return (await resetProjectEmbeddings(project ?? '')).chunksReset;
  const q = PG_QUELLE[art];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `UPDATE ${q.tabelle} SET embedded_at = NULL WHERE ${q.wo}`,
      q.mitProjekt ? [project] : [],
    );
    // P12-T10: auch teilweise quittierte Stuecke nach einem Collection-Reset
    // neu einplanen. Die Quellzeilen sind dabei gesperrt; alte ACKs schreiben
    // ohne ihren passenden Status nichts mehr.
    await client.query(
      'DELETE FROM wissen_stueck_status WHERE quelle=$1 AND project IS NOT DISTINCT FROM $2::text',
      [q.tabelle, project],
    );
    let identitaetsZeilen = 0;
    if (art === 'skills') {
      identitaetsZeilen = (await client.query('UPDATE agent_identitaet_skill_sections SET embedded_at=NULL')).rowCount ?? 0;
      await client.query("DELETE FROM wissen_stueck_status WHERE quelle='agent_identitaet_skill_sections'");
    }
    await client.query('COMMIT');
    return (res.rowCount ?? 0) + identitaetsZeilen;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Eingebettete PG-Zeilen, deren Ziel-Collection fehlt — ihre Vektoren gibt es dann nicht. */
async function fehlendeZiele(vorhanden: Set<string>, filter: Set<string> | null): Promise<Ziel[]> {
  const pool = getPool();
  const ergebnis: Ziel[] = [];
  const mitProjekt: Array<[NeuEinbettenArt, string]> = [
    ['code', 'code_chunks'], ['memories', 'memories'], ['thoughts', 'thoughts'],
    ['proposals', 'proposals'], ['plans', 'plans'], ['tasks', 'plan_tasks'], ['docs', 'tech_docs'],
  ];
  for (const [art, tabelle] of mitProjekt) {
    if (filter && !filter.has(art)) continue;
    const { rows } = await pool.query<{ project: string }>(
      `SELECT DISTINCT project FROM ${tabelle} WHERE embedded_at IS NOT NULL AND project IS NOT NULL`,
    );
    for (const r of rows) {
      const collection = zielCollection(art, r.project);
      if (!vorhanden.has(collection)) ergebnis.push({ collection, art, project: r.project });
    }
  }
  for (const art of ['tech_docs_cache', 'error_patterns', 'skills', 'verlauf'] as const) {
    if (filter && !filter.has(art)) continue;
    const collection = zielCollection(art, null);
    if (vorhanden.has(collection) || (art === 'skills' && SKILLS_GETRENNT)) continue;
    const q = PG_QUELLE[art];
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${art === 'skills' ? '(SELECT embedded_at FROM skill_sections UNION ALL SELECT embedded_at FROM agent_identitaet_skill_sections) skill_gesamt' : q.tabelle} WHERE ${q.wo} AND embedded_at IS NOT NULL`,
    );
    if (rows[0].n > 0) ergebnis.push({ collection, art, project: null });
  }
  return ergebnis;
}

function meldung(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Vorschau (Standard) oder Ausfuehrung des Neuaufbaus. Wirft nur bei Infrastrukturfehlern vor dem
 * ersten Eingriff; Fehler einzelner Collections stehen in ergebnis.fehler, der Rest laeuft weiter.
 */
export async function neuEinbetten(opt: NeuEinbettenOptionen = {}): Promise<Record<string, unknown>> {
  const pool = getPool();
  await sichereModellprofil();
  const kennung = embeddingModellKennung();
  const dimension = await getEmbeddingDimension();
  const filter = opt.arten && opt.arten.length > 0 ? new Set(opt.arten) : null;

  const register = new Map<string, { modell_kennung: string; quelle: string }>();
  const reg = await pool.query<{ collection: string; modell_kennung: string; quelle: string }>(
    'SELECT collection, modell_kennung, quelle FROM embedding_collections',
  );
  for (const r of reg.rows) register.set(r.collection, r);

  const namen = await listCollections();
  const veraltet: VeralteteCollection[] = [];
  const media: string[] = [];
  const unbekannt: string[] = [];
  for (const name of namen) {
    const e = ordneCollectionEin(name);
    if (e.art === 'media') { media.push(name); continue; }
    if (e.art === 'unbekannt') { unbekannt.push(name); continue; }
    if (e.art === 'skills' && SKILLS_GETRENNT) continue;
    if (filter && !filter.has(e.art)) continue;
    const gruende: string[] = [];
    const groesse = await getCollectionVectorSize(name);
    if (groesse !== dimension) gruende.push(`Dimension ${groesse ?? '?'} statt ${dimension}`);
    const r = register.get(name);
    if (!r) gruende.push('nicht im Kennungsregister');
    else {
      if (r.modell_kennung !== kennung) gruende.push('andere Modell-Kennung');
      if (r.quelle !== 'angelegt') gruende.push(`Register-Quelle ${r.quelle}`);
    }
    if (gruende.length === 0) continue;
    veraltet.push({ collection: name, art: e.art, project: e.project, gruende, pg_zeilen: await zaehleZeilen(e.art, e.project) });
  }

  const fehlende = await fehlendeZiele(new Set(namen), filter);

  const jeArt: Record<string, { collections: number; pg_zeilen: number }> = {};
  for (const v of veraltet) {
    const s = (jeArt[v.art] ??= { collections: 0, pg_zeilen: 0 });
    s.collections++;
    s.pg_zeilen += v.pg_zeilen;
  }

  // Der Parser-Worker bettet nur Projekte aus der Registry ein (Projekt-Regel 3) — Code anderer
  // Projekte bleibt nach dem Zuruecksetzen ohne Vektor, bis das Projekt registriert ist.
  const ohneRegistry = (await pool.query<{ project: string; chunks: number }>(
    `SELECT cc.project, count(*)::int AS chunks FROM code_chunks cc
      WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.name = cc.project)
      GROUP BY cc.project ORDER BY 2 DESC`,
  )).rows;

  const basis = {
    aktuell: { kennung, dimension },
    collections_gesamt: namen.length,
    ...(filter ? { arten: [...filter] } : {}),
    veraltet: {
      anzahl: veraltet.length,
      je_art: jeArt,
      beispiele: veraltet.slice(0, 15).map((v) => ({ collection: v.collection, gruende: v.gruende, pg_zeilen: v.pg_zeilen })),
    },
    fehlende_collections: fehlende.map((f) => f.collection),
    nicht_angefasst: { media, unbekannt },
    code_ohne_registry: ohneRegistry,
  };

  if (!opt.ausfuehren) {
    return {
      modus: 'vorschau',
      ...basis,
      hinweis:
        'Nur Vorschau, nichts geaendert. Ausfuehren mit ausfuehren:true — erst NACH dem Umschalten der ' +
        'Modell-Env (P12-T14). code_ohne_registry bettet der Parser-Worker nicht ein.',
    };
  }

  const t0 = Date.now();
  const zurueckgesetzt: Record<string, number> = {};
  const fehler: Array<{ collection: string; fehler: string }> = [];
  let neuAngelegt = 0;
  for (const v of veraltet) {
    try {
      if (v.art !== 'code') {
        await deleteCollection(v.collection);
        await ensureCollection(v.collection);
      }
      zurueckgesetzt[v.art] = (zurueckgesetzt[v.art] ?? 0) + await setzeZurueck(v.art, v.project);
      neuAngelegt++;
    } catch (err) {
      fehler.push({ collection: v.collection, fehler: meldung(err) });
    }
  }
  for (const f of fehlende) {
    try {
      if (f.art !== 'code') await ensureCollection(f.collection);
      zurueckgesetzt[f.art] = (zurueckgesetzt[f.art] ?? 0) + await setzeZurueck(f.art, f.project);
    } catch (err) {
      fehler.push({ collection: f.collection, fehler: meldung(err) });
    }
  }
  console.error(
    `[Synapse] neu_einbetten: ${neuAngelegt}/${veraltet.length} Collections neu angelegt, ` +
      `${fehlende.length} fehlende ergaenzt, ${fehler.length} Fehler. Zurueckgesetzt: ${JSON.stringify(zurueckgesetzt)}`,
  );
  return {
    modus: 'ausgefuehrt',
    ...basis,
    ergebnis: { collections_neu: neuAngelegt, fehlende_ergaenzt: fehlende.length, zurueckgesetzt, fehler, dauer_ms: Date.now() - t0 },
    hinweis:
      'Der Nachzug bettet jetzt im Hintergrund ein. Fortschritt: intern(status) offene_embeddings; ' +
      'schneller: intern(nachzug_jetzt, limit 500). Code laeuft ueber den Parser-Worker.',
  };
}
