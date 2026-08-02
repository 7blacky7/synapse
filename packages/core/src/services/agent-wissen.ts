/**
 * Agenten-Wissen in der Datenbank (API-Bruecke, Schritt 4)
 *
 * ZWECK: Alles, was heute als Datei unter .synapse/agents/<name>/ liegt, in der
 * Datenbank ablegen — damit ein Wrapper sein Wissen und seinen System-Prompt ueber
 * die API bekommt statt von der Platte, auf der der Daemon laeuft.
 *
 * ADDITIV: Der Dateiweg (packages/agents/src/skills.ts) bleibt unveraendert und
 * vollstaendig funktionsfaehig. Diese Schicht wird erst benutzt, wenn der Aufrufer
 * es ausdruecklich verlangt.
 *
 * ABBILDUNG (Quelle: packages/agents/src/skills.ts):
 *   meta.yaml            -> art='meta',          form='block'  (Inhalt: JSON)
 *   rules.md             -> art='regeln'
 *   errors.md            -> art='fehler'
 *   patterns.md          -> art='muster'
 *   context.md           -> art='kontext'
 *   system-prompt.txt    -> art='system_prompt',  form='block'
 *   writeSkillFile       -> setzeWissen()        (alles der Art ersetzen)
 *   appendToSkillFile    -> haengeWissenAn()     (eine Zeile, ein INSERT)
 *   readAllSkillFiles    -> leseAgentWissen().text
 *   createInitialAgent   -> legeAgentWissenAn()
 *   purgeAgentDir        -> loescheAgentWissen()
 *   update_skill remove  -> entferneWissenZeilen()
 *   logs/                -> NICHT abgebildet. Logs sind kein Wissen; sie gehoeren
 *                           dorthin, wo der Prozess laeuft.
 *
 * ⚠️ ZWEI EIGENHEITEN VON appendToSkillFile, die hier bewusst erhalten bleiben:
 *   (a) Ein neuer Eintrag steht INNERHALB seines Tages OBEN, nicht unten
 *       (skills.ts nutzt existing.replace(header, header + '\n- ' + entry)).
 *       Die Tagesbloecke selbst stehen chronologisch, aeltester zuerst.
 *       Grund fuer die Treue: dieser Text geht WOERTLICH in den System-Prompt.
 *       Eine gedrehte Reihenfolge waere kein Fehler, den ein Test faengt — sie
 *       aendert nur still, was das Modell zuerst liest.
 *   (b) Die Datums-Kopfzeile "## JJJJ-MM-TT" ist im Dateiweg Fliesstext und wird
 *       per includes() gesucht; steht dasselbe Datum zufaellig in einem Eintrag,
 *       schreibt der Dateiweg dorthin. Hier ist das Datum eine SPALTE — dieser
 *       Fehler kann nicht mehr auftreten. Das ist der einzige gewollte Unterschied.
 */

import { getPool } from '../db/index.js';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type WissensArt = 'regeln' | 'fehler' | 'muster' | 'kontext' | 'meta' | 'system_prompt';
export type WissensForm = 'block' | 'eintrag';

/** Die vier Arten, die in den Prompt-Text wandern — in genau dieser Reihenfolge. */
export const PROMPT_ARTEN: readonly WissensArt[] = ['regeln', 'fehler', 'muster', 'kontext'] as const;

export const ALLE_ARTEN: readonly WissensArt[] = [
  'regeln',
  'fehler',
  'muster',
  'kontext',
  'meta',
  'system_prompt',
] as const;

export interface WissensEintrag {
  id: string;
  tag: string;
  inhalt: string;
  quelle: string | null;
}

export interface ArtSicht {
  art: WissensArt;
  /** Ergebnis eines vollstaendigen Schreibens (writeSkillFile). null = nie gesetzt. */
  block: string | null;
  eintraege: WissensEintrag[];
  anzahl: number;
  /** block + gerenderte Datumsbloecke — das, was im Dateiweg in der Datei stuende. */
  text: string;
}

export interface AgentMetaDaten {
  name: string;
  model: string;
  expertise: string;
  created: string;
}

export interface AgentWissen {
  project: string;
  agent: string;
  meta: AgentMetaDaten | null;
  /** Zeichengleich zu readAllSkillFiles — geht woertlich in den System-Prompt. */
  text: string;
  arten: Record<WissensArt, ArtSicht>;
  systemPrompt: string | null;
  systemPromptLaenge: number;
  /** true, wenn alle vier Prompt-Arten leer sind. Der Aufrufer soll das als DEFEKT werten. */
  leer: boolean;
  zeilenGesamt: number;
  warnungen: string[];
}

interface ZeileRoh {
  id: string;
  art: WissensArt;
  form: WissensForm;
  inhalt: string;
  tag: string;
  quelle: string | null;
}

// ---------------------------------------------------------------------------
// Arten-Namen
// ---------------------------------------------------------------------------

/**
 * Deutsche UND englische Schreibweise werden angenommen — der Vorschlag des
 * Koordinators ist deutsch, der SkillFile-Typ auf der Aufruferseite englisch.
 * Ein unbekannter Wert gibt null und damit einen Fehler; der heutige Code faellt
 * an dieser Stelle still auf 'rules' zurueck (specialists.ts:684), das wird hier
 * bewusst NICHT uebernommen: ein Tippfehler schriebe sonst in die Regeln.
 */
const ART_ALIASSE: Record<string, WissensArt> = {
  regeln: 'regeln',
  rules: 'regeln',
  fehler: 'fehler',
  errors: 'fehler',
  muster: 'muster',
  patterns: 'muster',
  pattern: 'muster',
  kontext: 'kontext',
  context: 'kontext',
  meta: 'meta',
  system_prompt: 'system_prompt',
  'system-prompt': 'system_prompt',
  systemprompt: 'system_prompt',
};

export function normalisiereArt(roh: unknown): WissensArt | null {
  if (typeof roh !== 'string') return null;
  return ART_ALIASSE[roh.trim().toLowerCase()] ?? null;
}

/** Fuer Fehlermeldungen: was darf hier stehen? */
export function erlaubteArten(): string[] {
  return Object.keys(ART_ALIASSE);
}

// ---------------------------------------------------------------------------
// Rendern
// ---------------------------------------------------------------------------

function heute(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Baut aus Block und Eintraegen den Text, den der Dateiweg in der Datei haette.
 * Reihenfolge: erst der Block (ein frueher vollstaendig geschriebener Inhalt),
 * danach je Tag eine Kopfzeile mit den Eintraegen dieses Tages, NEUESTER ZUERST.
 */
function rendereArt(block: string | null, eintraege: WissensEintrag[]): string {
  const teile: string[] = [];
  if (block !== null && block.trim().length > 0) teile.push(block.trimEnd());

  const tage = new Map<string, WissensEintrag[]>();
  for (const e of eintraege) {
    const liste = tage.get(e.tag);
    if (liste) liste.push(e);
    else tage.set(e.tag, [e]);
  }

  for (const tag of [...tage.keys()].sort()) {
    const desTages = (tage.get(tag) ?? [])
      .slice()
      // Absteigend nach id: der zuletzt angehaengte Eintrag steht oben.
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0));
    const zeilen = desTages.map((e) => `- ${e.inhalt}`).join('\n');
    teile.push(`## ${tag}\n${zeilen}`);
  }

  return teile.length > 0 ? teile.join('\n\n') + '\n' : '';
}

/**
 * Der Wortlaut aus readAllSkillFiles (skills.ts:142-171), Zeichen fuer Zeichen.
 * Wer diesen Text nachbaut statt ihn hier zu holen, laesst die beiden Wege
 * auseinanderlaufen, ohne dass es auffaellt.
 */
function baueWissensText(
  agent: string,
  meta: AgentMetaDaten | null,
  regeln: string,
  fehler: string,
  muster: string,
  kontext: string,
): string {
  const kopf = meta
    ? `# Agent: ${meta.name} (${meta.model})\nExpertise: ${meta.expertise}`
    : `# Agent: ${agent}`;

  return `${kopf}

## Regeln
${regeln.trim() || '(Keine)'}

## Fehler → Loesung
${fehler.trim() || '(Keine)'}

## Patterns
${muster.trim() || '(Keine)'}

## Kontext
${kontext.trim() || '(Kein Kontext)'}
`;
}

/**
 * meta wird als JSON abgelegt. Angenommen wird zusaetzlich das alte
 * meta.yaml-Format ("k: v" je Zeile) — damit eine Migration den Dateiinhalt roh
 * schicken kann. Unlesbares gibt null MIT Warnung statt eines leeren Kopfes.
 */
function leseMetaAusText(roh: string, warnungen: string[]): AgentMetaDaten | null {
  const text = roh.trim();
  if (!text) return null;

  let felder: Record<string, unknown> | null = null;
  if (text.startsWith('{')) {
    try {
      const geparst: unknown = JSON.parse(text);
      if (geparst && typeof geparst === 'object') felder = geparst as Record<string, unknown>;
    } catch (fehler) {
      warnungen.push(`meta ist kein gueltiges JSON: ${String(fehler)}`);
      return null;
    }
  } else {
    felder = {};
    for (const zeile of text.split('\n')) {
      const idx = zeile.indexOf(':');
      if (idx === -1) continue;
      const schluessel = zeile.slice(0, idx).trim();
      const wert = zeile.slice(idx + 1).trim();
      if (schluessel && wert) felder[schluessel] = wert;
    }
  }

  const holen = (name: string): string | null => {
    const wert = felder?.[name];
    return typeof wert === 'string' && wert.length > 0 ? wert : null;
  };
  const name = holen('name');
  const model = holen('model');
  const expertise = holen('expertise');
  const created = holen('created');

  // Dieselbe Strenge wie readMeta (skills.ts:78): fehlt ein Feld, gilt meta als
  // nicht vorhanden. Anders als dort wird es hier aber GEMELDET.
  if (!name || !model || !expertise || !created) {
    warnungen.push('meta unvollstaendig (name/model/expertise/created) — wird als fehlend behandelt');
    return null;
  }
  return { name, model, expertise, created };
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

async function leseZeilen(project: string, agent: string): Promise<ZeileRoh[]> {
  const { rows } = await getPool().query<ZeileRoh>(
    `SELECT id::text AS id, art, form, inhalt,
            to_char(tag, 'YYYY-MM-DD') AS tag, quelle
       FROM agent_wissen
      WHERE project = $1 AND agent_name = $2
      ORDER BY art, form, tag, id`,
    [project, agent],
  );
  return rows;
}

function baueArtSicht(art: WissensArt, zeilen: ZeileRoh[]): ArtSicht {
  const derArt = zeilen.filter((z) => z.art === art);
  const blockZeile = derArt.find((z) => z.form === 'block');
  const eintraege: WissensEintrag[] = derArt
    .filter((z) => z.form === 'eintrag')
    .map((z) => ({ id: z.id, tag: z.tag, inhalt: z.inhalt, quelle: z.quelle }));
  const block = blockZeile ? blockZeile.inhalt : null;
  return { art, block, eintraege, anzahl: derArt.length, text: rendereArt(block, eintraege) };
}

/**
 * Das Wissen eines Agenten in EINEM Aufruf.
 * null bedeutet: zu diesem Agenten existiert KEINE Zeile — entspricht dem
 * heutigen readSkill() === null. Ein bekannter Agent mit leerem Wissen liefert
 * dagegen ein Objekt mit leer=true. Diese Unterscheidung entscheidet auf der
 * Aufruferseite darueber, ob createInitialAgent laeuft; faellt sie zusammen,
 * ueberschreibt jeder Spawn die gelernten Regeln.
 */
export async function leseAgentWissen(project: string, agent: string): Promise<AgentWissen | null> {
  const zeilen = await leseZeilen(project, agent);
  if (zeilen.length === 0) return null;

  const warnungen: string[] = [];
  const arten = {} as Record<WissensArt, ArtSicht>;
  for (const art of ALLE_ARTEN) arten[art] = baueArtSicht(art, zeilen);

  const meta = leseMetaAusText(arten.meta.text, warnungen);
  const systemPrompt = arten.system_prompt.block;

  const text = baueWissensText(
    agent,
    meta,
    arten.regeln.text,
    arten.fehler.text,
    arten.muster.text,
    arten.kontext.text,
  );

  const leer = PROMPT_ARTEN.every((art) => arten[art].text.trim().length === 0);

  return {
    project,
    agent,
    meta,
    text,
    arten,
    systemPrompt,
    systemPromptLaenge: systemPrompt ? systemPrompt.length : 0,
    leer,
    zeilenGesamt: zeilen.length,
    warnungen,
  };
}

/** Eine einzelne Art. null = der Agent ist unbekannt (nicht: die Art ist leer). */
export async function leseWissensArt(
  project: string,
  agent: string,
  art: WissensArt,
): Promise<ArtSicht | null> {
  const zeilen = await leseZeilen(project, agent);
  if (zeilen.length === 0) return null;
  return baueArtSicht(art, zeilen);
}

/** Gibt es zu diesem Agenten ueberhaupt etwas? */
export async function agentIstBekannt(project: string, agent: string): Promise<boolean> {
  const { rows } = await getPool().query<{ da: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM agent_wissen WHERE project = $1 AND agent_name = $2) AS da`,
    [project, agent],
  );
  return rows[0]?.da === true;
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

async function inTransaktion<T>(arbeit: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (fehler) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fehler;
  } finally {
    client.release();
  }
}

/**
 * Eine Art vollstaendig ersetzen (= writeSkillFile). Alles Bisherige dieser Art
 * faellt weg, genau wie ein Ueberschreiben der Datei alles Bisherige verwirft.
 * Die Zahl der ersetzten Zeilen wird zurueckgegeben — ein blosses "ok" waere
 * hier wertlos, weil ein Schreiben ins Leere genauso aussaehe.
 */
export async function setzeWissen(
  project: string,
  agent: string,
  art: WissensArt,
  inhalt: string,
  quelle?: string | null,
): Promise<{ ersetzteZeilen: number; id: string }> {
  return inTransaktion(async (client) => {
    const geloescht = await client.query(
      `DELETE FROM agent_wissen WHERE project = $1 AND agent_name = $2 AND art = $3`,
      [project, agent, art],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO agent_wissen (project, agent_name, art, form, inhalt, quelle)
       VALUES ($1, $2, $3, 'block', $4, $5)
       RETURNING id::text AS id`,
      [project, agent, art, inhalt, quelle ?? null],
    );
    return { ersetzteZeilen: geloescht.rowCount ?? 0, id: rows[0].id };
  });
}

/**
 * Einen Eintrag anhaengen (= appendToSkillFile / update_skill add).
 * EIN INSERT — kein Lesen, Zusammensetzen und Zurueckschreiben. Damit koennen
 * zwei gleichzeitige Eintraege einander nicht mehr verlieren; im Dateiweg ist
 * genau das moeglich.
 */
export async function haengeWissenAn(
  project: string,
  agent: string,
  art: WissensArt,
  inhalt: string,
  quelle?: string | null,
  tag?: string | null,
): Promise<{ id: string; tag: string }> {
  const tagWert = tag && /^\d{4}-\d{2}-\d{2}$/.test(tag) ? tag : heute();
  const { rows } = await getPool().query<{ id: string; tag: string }>(
    `INSERT INTO agent_wissen (project, agent_name, art, form, inhalt, tag, quelle)
     VALUES ($1, $2, $3, 'eintrag', $4, $5::date, $6)
     RETURNING id::text AS id, to_char(tag, 'YYYY-MM-DD') AS tag`,
    [project, agent, art, inhalt, tagWert, quelle ?? null],
  );
  return { id: rows[0].id, tag: rows[0].tag };
}

/**
 * Zeilen entfernen, die einen Text enthalten (= update_skill remove).
 * Gefiltert wird ZEILENWEISE ueber alle Zeilen der Art — genau wie heute
 * (specialists.ts:705). Ein Eintrag, von dem nichts uebrig bleibt, verschwindet.
 * entfernteZeilen zaehlt TEXTZEILEN, nicht Tabellenzeilen.
 */
export async function entferneWissenZeilen(
  project: string,
  agent: string,
  art: WissensArt,
  enthaelt: string,
): Promise<{ entfernteZeilen: number; entfernteEintraege: number; geaenderteZeilen: number }> {
  if (enthaelt.length === 0) {
    // Ein leerer Suchtext trifft JEDE Zeile — das waere ein Loeschen als Unfall.
    throw new Error('entferneWissenZeilen: "enthaelt" darf nicht leer sein');
  }
  return inTransaktion(async (client) => {
    const { rows } = await client.query<{ id: string; inhalt: string }>(
      `SELECT id::text AS id, inhalt
         FROM agent_wissen
        WHERE project = $1 AND agent_name = $2 AND art = $3
        FOR UPDATE`,
      [project, agent, art],
    );

    let entfernteZeilen = 0;
    let entfernteEintraege = 0;
    let geaenderteZeilen = 0;

    for (const zeile of rows) {
      const alle = zeile.inhalt.split('\n');
      const behalten = alle.filter((z) => !z.includes(enthaelt));
      if (behalten.length === alle.length) continue;

      entfernteZeilen += alle.length - behalten.length;
      const neu = behalten.join('\n');
      if (neu.trim().length === 0) {
        await client.query(`DELETE FROM agent_wissen WHERE id = $1`, [zeile.id]);
        entfernteEintraege += 1;
      } else {
        await client.query(
          `UPDATE agent_wissen SET inhalt = $2, aktualisiert_am = NOW() WHERE id = $1`,
          [zeile.id, neu],
        );
        geaenderteZeilen += 1;
      }
    }

    return { entfernteZeilen, entfernteEintraege, geaenderteZeilen };
  });
}

/**
 * Wissen fuer einen neuen Agenten anlegen (= createInitialAgent): meta + vier
 * leere Arten. IDEMPOTENT und race-sicher ueber den Teilindex auf form='block':
 * ist der Agent schon da, wird NICHTS ueberschrieben. Das ist die Sicherung
 * dagegen, dass ein zweiter Spawn gelernte Regeln loescht.
 */
export async function legeAgentWissenAn(
  project: string,
  agent: string,
  meta: AgentMetaDaten,
  quelle?: string | null,
): Promise<{ angelegt: boolean; neueZeilen: number }> {
  const metaText = JSON.stringify(meta);
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO agent_wissen (project, agent_name, art, form, inhalt, quelle)
     SELECT $1, $2, art, 'block', CASE WHEN art = 'meta' THEN $3 ELSE '' END, $4
       FROM unnest(ARRAY['meta','regeln','fehler','muster','kontext']) AS art
     ON CONFLICT (project, agent_name, art) WHERE form = 'block'
     DO NOTHING
     RETURNING id::text AS id`,
    [project, agent, metaText, quelle ?? null],
  );
  return { angelegt: rows.length > 0, neueZeilen: rows.length };
}

/**
 * Alles zu einem Agenten entfernen (= der DB-Anteil von purgeAgentDir).
 * Idempotent: kein Fehler, wenn nichts da ist — die Zahl sagt, ob es etwas gab.
 */
export async function loescheAgentWissen(
  project: string,
  agent: string,
): Promise<{ geloeschteZeilen: number }> {
  const ergebnis = await getPool().query(
    `DELETE FROM agent_wissen WHERE project = $1 AND agent_name = $2`,
    [project, agent],
  );
  return { geloeschteZeilen: ergebnis.rowCount ?? 0 };
}

/** Alle Agenten, zu denen Wissen in der Datenbank liegt (= listAgentDirs). */
export async function listeWissensAgenten(
  project: string,
): Promise<Array<{ agent: string; zeilen: number; aktualisiertAm: string }>> {
  const { rows } = await getPool().query<{ agent: string; zeilen: string; aktualisiert_am: string }>(
    `SELECT agent_name AS agent, COUNT(*)::text AS zeilen,
            to_char(MAX(aktualisiert_am), 'YYYY-MM-DD"T"HH24:MI:SSOF') AS aktualisiert_am
       FROM agent_wissen
      WHERE project = $1
      GROUP BY agent_name
      ORDER BY agent_name`,
    [project],
  );
  return rows.map((r) => ({
    agent: r.agent,
    zeilen: Number(r.zeilen),
    aktualisiertAm: r.aktualisiert_am,
  }));
}
