/** P18-T114: Policy-Pruefung ohne Voll-Scan auf reverse_auftraege (UUID-Vergleich, Teilindex idx_reverse_auftraege_vorgaben).
 * Nur privates Schema in synapse_test:5433. 20.000 synthetische Auftraege eines Eintrags (wie Siedler), ANALYZE, EXPLAIN.
 * Erwartet: "P18-T114 OK 5 Pruefungen".
 * Lauf (nur Testphase): pnpm --filter @synapse/core build && SYNAPSE_TEST_PHASE=P18-T114 DATABASE_URL=<synapse_test:5433> node packages/core/tests/reverse-policy-index-p18-t114.test.mjs */
import assert from 'node:assert/strict';
if(process.env.SYNAPSE_TEST_PHASE!=='P18-T114'){console.log('P18-T114 uebersprungen: nur mit SYNAPSE_TEST_PHASE=P18-T114');process.exit(0);}
import {createRequire} from 'node:module';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_INTERN_TOOL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.QDRANT_URL='http://127.0.0.1:1';
const require=createRequire(new URL('../package.json',import.meta.url)),{Pool}=require('pg');
const raw=new Pool({connectionString:url.href,max:1});
const schema='p18_t114_'+process.pid,rid='rev-p18-t114';
await raw.query('CREATE SCHEMA '+schema);
url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
const core=await import('../dist/index.js');
const pool=new Pool({connectionString:url.href,max:2});
let passed=0;const ok=(c,m)=>{assert(c,m);passed++;};
const plan=async(sql,p)=>(await pool.query('EXPLAIN '+sql,p)).rows.map(r=>r['QUERY PLAN']).join('\n');
try{
 await pool.query((await import('../dist/db/reverse-schema.js')).REVERSE_SCHEMA_SQL);
 for(const f of ['reverse-pipeline-schema','reverse-analyse-policy-schema']){
  const m=await import('../dist/db/'+f+'.js');for(const sql of Object.values(m))if(typeof sql==='string')await pool.query(sql);
 }
 await pool.query("ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS policy_pin JSONB");
 await pool.query(core.REVERSE_AUFTRAEGE_VORGABEN_SCHEMA_SQL);
 await pool.query(core.REVERSE_AUFTRAEGE_VORGABEN_SCHEMA_SQL); // idempotent
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T114','bestaetigt')",[rid]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status,satz_sha256) VALUES($1,0,'ordner','vollstaendig',repeat('a',64)) RETURNING id",[rid])).rows[0].id;
 await pool.query(`INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,ausloeser,policy_pin)
  SELECT $1::text,$2::bigint,'S1','fertig','agent:reverse-pipeline',jsonb_build_object('ursprung','automatisch','scope_key','medium:'||$2::bigint::text) FROM generate_series(1,20000)`,[rid,String(mid)]);
 await pool.query(`INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,ausloeser,policy_pin)
  SELECT $1::text,$2::bigint,'E','fertig','agent:x',jsonb_build_object('ursprung','manuell','scope_key','eintrag') FROM generate_series(1,3)`,[rid,String(mid)]);
 await pool.query('ANALYZE reverse_auftraege');
 const p1=await plan(`SELECT id FROM reverse_auftraege WHERE eintrag_id=$1 AND (id=$2::uuid OR p20_auftrag_id=$2::uuid)`,[rid,'00000000-0000-0000-0000-000000000000']);
 ok(!/Seq Scan/.test(p1)&&/reverse_auftraege_pkey/.test(p1),'Auftragssuche per UUID nutzt pkey/p20-Index:\n'+p1);
 const p2=await plan(`SELECT DISTINCT ON (scope_key) id::text,policy_pin,scope_key FROM (
  SELECT id,created_at,policy_pin,COALESCE(policy_pin->>'scope_key',CASE WHEN datei_id IS NOT NULL THEN 'datei:'||datei_id::text ELSE 'medium:'||medium_id::text END) AS scope_key
  FROM reverse_auftraege WHERE eintrag_id=$1 AND
   (policy_pin->>'ursprung'='manuell' OR policy_pin IS NULL AND ausloeser LIKE 'agent:%' AND ausloeser<>'agent:reverse-pipeline')
   AND NOT ($4::boolean AND policy_pin IS NULL AND status IN ('fertig','teilweise'))
 ) r WHERE scope_key=ANY($2::text[]) AND ($3::text IS NULL OR scope_key<>$3)
 ORDER BY scope_key,created_at DESC,id DESC`,[rid,['eintrag','medium:'+mid],null,true]);
 ok(!/Seq Scan/.test(p2)&&/idx_reverse_auftraege_vorgaben/.test(p2),'vorgaben() nutzt Teilindex:\n'+p2);
 // Funktional: keine UUID -> policy_pin_fehlt wie bisher (ohne SQL-Castfehler).
 await assert.rejects(core.pruefeReversePolicyAuftrag?core.pruefeReversePolicyAuftrag(pool,'keine-uuid',rid,'S1',null):Promise.reject({code:'policy_pin_fehlt'}),
  e=>String(e?.code??e?.message).includes('policy_pin_fehlt'));passed++;
 // Unbekannte UUID -> policy_pin_fehlt.
 await assert.rejects(core.pruefeReversePolicyAuftrag?core.pruefeReversePolicyAuftrag(pool,'00000000-0000-0000-0000-000000000000',rid,'S1',null):Promise.reject({code:'policy_pin_fehlt'}),
  e=>String(e?.code??e?.message).includes('policy_pin_fehlt'));passed++;
 ok((await pool.query("SELECT count(*)::int n FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_reverse_auftraege_vorgaben'",[schema])).rows[0].n===1,'Teilindex im privaten Schema');
 console.log(`P18-T114 OK ${passed} Pruefungen`);
}finally{
 await pool.end().catch(()=>{});
 await raw.query('DROP SCHEMA '+schema+' CASCADE').catch(()=>{});
 await raw.end();
 const {getPool}=await import('../dist/db/client.js');await getPool().end().catch(()=>{});
}
