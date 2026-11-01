/**
 * P22-T256: konsistentes, unveränderliches Editor-Abbild aus dem PG-Projektindex.
 * REPEATABLE READ liefert einen Snapshot ohne Dateisperren; Agentenpläne bleiben unberührt.
 * Sensible Dateien werden wie code_intel maskiert und bleiben im Editor lesend.
 */
import { randomUUID, createHash } from 'node:crypto';
import { getPool } from '../db/client.js';
import { istMaskierteDatei, maskiereDatei } from './env-maske.js';

export async function erstelleEditorAbbild(project: string) {
  const c = await getPool().connect(), id = randomUUID();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const projekt = await c.query('SELECT 1 FROM projects WHERE name=$1', [project]);
    if (!projekt.rows.length) throw new Error('projekt_unbekannt');
    const r = await c.query<{file_path:string;content:string}>(
      'SELECT file_path,content FROM code_files WHERE project=$1 AND deleted_at IS NULL AND ignored=false AND content IS NOT NULL ORDER BY file_path', [project]);
    await c.query('INSERT INTO editor_abbilder(id,project) VALUES($1,$2)', [id,project]);
    const dateien = r.rows.map(z => ({
      file_path:z.file_path, inhalt:maskiereDatei(z.file_path,z.content),
      basis_hash:createHash('sha256').update(z.content,'utf8').digest('hex'), maskiert:istMaskierteDatei(z.file_path),
    }));
    await c.query(`INSERT INTO editor_abbild_dateien(abbild_id,file_path,inhalt,basis_hash,maskiert)
      SELECT $1::uuid,x.file_path,x.inhalt,x.basis_hash,x.maskiert
      FROM jsonb_to_recordset($2::jsonb) AS x(file_path text,inhalt text,basis_hash text,maskiert boolean)`,[id,JSON.stringify(dateien)]);
    await c.query('COMMIT');
    return {id,project,dateien:dateien.length};
  } catch(e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function leseEditorAbbild(project:string,id:string) {
  const r=await getPool().query<{id:string;project:string;erstellt_am:Date;dateien:string[]}>(
    `SELECT a.id::text,a.project,a.erstellt_am,COALESCE(array_agg(d.file_path ORDER BY d.file_path)
     FILTER (WHERE d.file_path IS NOT NULL),ARRAY[]::text[]) AS dateien
     FROM editor_abbilder a LEFT JOIN editor_abbild_dateien d ON d.abbild_id=a.id
     WHERE a.project=$1 AND a.id::text=$2 GROUP BY a.id`,[project,id]);
  return r.rows[0] ?? null;
}
export async function leseEditorAbbildDatei(project:string,id:string,filePath:string) {
  const r=await getPool().query<{file_path:string;inhalt:string;basis_hash:string;maskiert:boolean}>(
    `SELECT d.file_path,d.inhalt,d.basis_hash,d.maskiert FROM editor_abbild_dateien d
     JOIN editor_abbilder a ON a.id=d.abbild_id WHERE a.project=$1 AND a.id::text=$2 AND d.file_path=$3`,[project,id,filePath]);
  return r.rows[0] ?? null;
}
