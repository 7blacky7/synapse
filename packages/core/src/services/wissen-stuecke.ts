/**
 * P12-T10: persistierte Wissens-Stuecke mit Wiederaufnahme.
 * Kurze Eintraege ohne Alt-Stuecke nehmen unveraendert den bisherigen Weg.
 * Lange Eintraege behalten ihren bisherigen Kopf-/Gesamtvektor und erhalten
 * zusaetzliche Vektoren (2000 Zeichen, 200 Zeichen Ueberlappung).
 * PG wird vor Qdrant geschrieben. Quellzeilen werden nur fuer Stage/Upsert/Ack
 * gesperrt, nie waehrend eines Embedding-Aufrufs. Ein veralteter Lauf schreibt nichts.
 */
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { getHintergrundPool } from '../db/client.js';
import { embedBatch, embeddingModellKennung, type EmbedOptions } from '../embeddings/index.js';
import { ensureCollection, insertVectors, deleteByFilter } from '../qdrant/index.js';
import type { NachzugPunkt, NachzugQuelle } from './embed-nachzug.js';

export const WISSEN_STUECK_ZEICHEN = 2000;
export const WISSEN_STUECK_OVERLAP = 200;
// Bei Aenderung von Grenzen/Verfahren Version erhoehen: Altbestand wird gezielt nachgezogen.
export const WISSEN_STUECK_VERSION = '1:2000:200';

export function istWissensQuelle(name: string): boolean {
  return name === 'memories' || name === 'thoughts' || name === 'tech_docs';
}

export function teileWissen(text: string): string[] {
  const zeichen = Array.from(text);
  const stuecke: string[] = [];
  for (let start = 0; start < zeichen.length; start += WISSEN_STUECK_ZEICHEN - WISSEN_STUECK_OVERLAP) {
    const ende = Math.min(zeichen.length, start + WISSEN_STUECK_ZEICHEN);
    stuecke.push(zeichen.slice(start, ende).join(''));
    if (ende === zeichen.length) break;
  }
  return stuecke;
}

/** Nur lange Altzeilen brauchen eine neue Version; kurze Bestandsvektoren bleiben stehen. */
export function wissensNachzugWo(quelle: NachzugQuelle): string {
  if (!istWissensQuelle(quelle.tabelle)) return 't.embedded_at IS NULL';
  const text = quelle.tabelle === 'tech_docs'
    ? "(t.framework || ' ' || t.version || ' ' || COALESCE(t.section,'') || ' ' || t.content)"
    : 't.content';
  return `(t.embedded_at IS NULL OR (char_length(${text}) > ${WISSEN_STUECK_ZEICHEN}
    AND NOT EXISTS (SELECT 1 FROM wissen_stueck_status ws
      WHERE ws.quelle = '${quelle.tabelle}' AND ws.eintrag_id = t.id::text
        AND ws.version = '${WISSEN_STUECK_VERSION}' AND ws.abgeschlossen
        AND ws.stand IS NOT DISTINCT FROM (${quelle.standSql}))))`;
}

type Status = { stand: string | null; version: string; modell: string; abgeschlossen: boolean };
type Stueck = { stueck_nr: number; punkt_id: string; inhalt: string };
const STAPEL = 32; // Drossel je Eintrag; jeder Stapel geht durch die normale Embedding-Queue.

/** true = von diesem Weg behandelt, false = unveraenderter kurzer Standardweg. */
export async function betteWissenEin(
  quelle: NachzugQuelle, punkt: NachzugPunkt, optionen: EmbedOptions,
): Promise<boolean> {
  if (!istWissensQuelle(quelle.tabelle)) return false;
  const pool = getHintergrundPool();
  const lang = Array.from(punkt.text).length > WISSEN_STUECK_ZEICHEN;
  if (!lang) {
    const alt = await pool.query('SELECT 1 FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',
      [quelle.tabelle, punkt.id]);
    if (alt.rowCount === 0) return false;
  }
  const modell = embeddingModellKennung();
  const quellenSql = `SELECT t.id, (${quelle.standSql}) AS stand, t.embedded_at
    FROM ${quelle.tabelle} t WHERE t.${quelle.idSpalte} = $1::${quelle.idTyp} FOR UPDATE`;
  const passt = (row: { stand: string | null } | undefined) => !!row && row.stand === punkt.stand;
  const gleich = (s: Status | undefined) => !!s && s.stand === punkt.stand
    && s.version === WISSEN_STUECK_VERSION && s.modell === modell;

  // Staging vor dem ersten Embedding; unveraenderte offene Stuecke bleiben quittiert.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const src = (await client.query(quellenSql, [punkt.id])).rows[0];
    if (!passt(src)) { await client.query('ROLLBACK'); return true; }
    const vorher = (await client.query<Status>(
      'SELECT stand,version,modell,abgeschlossen FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2 FOR UPDATE',
      [quelle.tabelle, punkt.id])).rows[0];
    // NULL bei einem schon abgeschlossenen Eintrag bedeutet explizites Re-Embedding.
    if (!gleich(vorher) || (vorher?.abgeschlossen && src.embedded_at === null)) {
      await deleteByFilter(punkt.collection, {
        must: [{ key: 'wissen_stueck.eintrag_id', match: { value: punkt.id } }],
      });
      await client.query('DELETE FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2', [quelle.tabelle, punkt.id]);
      await client.query(`INSERT INTO wissen_stueck_status(quelle,eintrag_id,project,stand,version,modell)
        VALUES($1,$2,$3,$4,$5,$6)`, [quelle.tabelle,punkt.id,punkt.project,punkt.stand,WISSEN_STUECK_VERSION,modell]);
      const texte = lang ? teileWissen(punkt.text) : [];
      // -1: bestehender Gesamtvektor (ID/Original-Payload bleiben unveraendert).
      const alle = [{ nr:-1, id:punkt.id, text:punkt.text }, ...texte.map((text,nr) => ({
        nr, text, id:uuidv5([quelle.tabelle,punkt.id,WISSEN_STUECK_VERSION,punkt.stand,nr,text].join('|'),uuidv5.DNS),
      }))];
      await client.query(`INSERT INTO wissen_stuecke(quelle,eintrag_id,stueck_nr,punkt_id,inhalt)
        SELECT $1,$2,x.nr,x.id,x.inhalt FROM unnest($3::int[],$4::text[],$5::text[]) AS x(nr,id,inhalt)`,
        [quelle.tabelle,punkt.id,alle.map(x=>x.nr),alle.map(x=>x.id),alle.map(x=>x.text)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }

  while (true) {
    // Atomarer Claim (wie Code-Claims): mehrere Prozesse rechnen dieselben
    // offenen Stuecke nicht doppelt. Nach einem Crash gibt die Lease sie frei.
    const token = uuidv4();
    const leaseEnv = Number(process.env.SYNAPSE_WISSEN_STUECK_LEASE_MS);
    const leaseMs = Number.isFinite(leaseEnv) && leaseEnv > 0 ? leaseEnv : 600_000;
    const liste = (await pool.query<Stueck>(`WITH kandidat AS (
      SELECT quelle,eintrag_id,stueck_nr FROM wissen_stuecke
       WHERE quelle=$1 AND eintrag_id=$2 AND embedded_at IS NULL
         AND (lease_until IS NULL OR lease_until < NOW())
       ORDER BY stueck_nr LIMIT $3 FOR UPDATE SKIP LOCKED
    ) UPDATE wissen_stuecke w SET claim_token=$4::uuid,
        lease_until=NOW()+($5::double precision * interval '1 millisecond')
      FROM kandidat k WHERE w.quelle=k.quelle AND w.eintrag_id=k.eintrag_id AND w.stueck_nr=k.stueck_nr
      RETURNING w.stueck_nr,w.punkt_id,w.inhalt`,
      [quelle.tabelle,punkt.id,STAPEL,token,leaseMs])).rows.sort((a,b)=>a.stueck_nr-b.stueck_nr);
    if (!liste.length) break;
    const freigeben = (db: Pick<typeof pool, 'query'> = pool) => db.query(
      'UPDATE wissen_stuecke SET claim_token=NULL,lease_until=NULL WHERE quelle=$1 AND eintrag_id=$2 AND claim_token=$3::uuid',
      [quelle.tabelle,punkt.id,token]);
    let vektoren: number[][];
    try { vektoren = await embedBatch(liste.map(x=>x.inhalt),optionen); }
    catch (error) { await freigeben(); throw error; }
    const ack = await pool.connect();
    try {
      await ack.query('BEGIN');
      const src = (await ack.query(quellenSql,[punkt.id])).rows[0];
      const status = (await ack.query<Status>(
        'SELECT stand,version,modell,abgeschlossen FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',
        [quelle.tabelle,punkt.id])).rows[0];
      const eigene = await ack.query(
        'SELECT punkt_id FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2 AND claim_token=$3::uuid AND punkt_id=ANY($4::text[]) FOR UPDATE',
        [quelle.tabelle,punkt.id,token,liste.map(x=>x.punkt_id)]);
      if (!passt(src) || !gleich(status) || eigene.rowCount !== liste.length) {
        await ack.query('ROLLBACK'); await freigeben(ack); return true;
      }
      await ensureCollection(punkt.collection);
      await insertVectors(punkt.collection,liste.map((x,i)=>({
        id:x.punkt_id, vector:vektoren[i], payload: x.stueck_nr === -1 ? punkt.payload : {
          ...punkt.payload, content:x.inhalt, wissen_stueck: {
            eintrag_id:punkt.id, nr:x.stueck_nr, version:WISSEN_STUECK_VERSION, inhalt:x.inhalt,
          },
        },
      })));
      await ack.query(`UPDATE wissen_stuecke SET embedded_at=NOW(),claim_token=NULL,lease_until=NULL
        WHERE quelle=$1 AND eintrag_id=$2 AND punkt_id=ANY($3::text[])`,
        [quelle.tabelle,punkt.id,liste.map(x=>x.punkt_id)]);
      await ack.query('COMMIT');
    } catch (error) {
      await ack.query('ROLLBACK').catch(() => undefined);
      await freigeben(ack);
      throw error;
    } finally { ack.release(); }
  }
  const fertig = await pool.connect();
  try {
    await fertig.query('BEGIN');
    const src = (await fertig.query(quellenSql,[punkt.id])).rows[0];
    const status = (await fertig.query<Status>(
      'SELECT stand,version,modell,abgeschlossen FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',
      [quelle.tabelle,punkt.id])).rows[0];
    if (!passt(src) || !gleich(status)) { await fertig.query('ROLLBACK'); return true; }
    const offen = await fertig.query('SELECT 1 FROM wissen_stuecke WHERE quelle=$1 AND eintrag_id=$2 AND embedded_at IS NULL LIMIT 1',
      [quelle.tabelle,punkt.id]);
    if (offen.rowCount === 0) {
      await fertig.query(`UPDATE ${quelle.tabelle} SET embedded_at=NOW() WHERE ${quelle.idSpalte}=$1::${quelle.idTyp}`,[punkt.id]);
      if (lang) await fertig.query('UPDATE wissen_stueck_status SET abgeschlossen=TRUE WHERE quelle=$1 AND eintrag_id=$2',[quelle.tabelle,punkt.id]);
      else await fertig.query('DELETE FROM wissen_stueck_status WHERE quelle=$1 AND eintrag_id=$2',[quelle.tabelle,punkt.id]);
    }
    await fertig.query('COMMIT');
  } catch (error) {
    await fertig.query('ROLLBACK').catch(() => undefined); throw error;
  } finally { fertig.release(); }
  return true;
}
