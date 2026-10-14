/**
 * P16-T18 E3a: echte GCC/g++-Diagnosen + Core PG/Schatten/Basisvergleich.
 * NUR Testphase: DATABASE_URL=synapse_test:5433 (Shell setzt sie), eigenes Projekt, kein Docker.
 * node packages/core/tests/build-pruefung-e3a-p16-t18.test.mjs
 * Basis-Rotkontrolle: P16_CORE_DIST=/tmp/synapse-basis-f6b5a3a0/packages/core/dist <gleicher Befehl>.
 * Der erste fachliche Check erwartet einen Header-Folgefehler im unveraenderten Aufrufer (t101: null).
 */
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const url = new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env, {BUILD_PRUEFUNG_CACHE_MS:'0', BUILD_PRUEFUNG_SPRACHEN:'c,cpp',
  QDRANT_URL:'http://127.0.0.1:9', OLLAMA_URL:'http://127.0.0.1:9', SYNTAX_WORKER_THREADS:'0'});
const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.P16_CORE_DIST || resolve(hier, '../dist');
const db = await import(pathToFileURL(join(dist,'db/client.js')));
const bp = await import(pathToFileURL(join(dist,'services/build-pruefung.js')));
const {BUILD_PRUEFUNG_SCHEMA_SQL} = await import(pathToFileURL(join(dist,'db/build-pruefung-schema.js')));
const pool = db.getPool(), project = 'test-sol16-cpp-' + randomUUID().slice(0,8);
const tmp = mkdtempSync(join(tmpdir(), 'sol16-cpp-test-'));
const provider = process.env.P16_C_PRUEFER_DIR || resolve(hier, '../../../docker/synapse-pruefcontainer');
const python = `
import json,sys
sys.path.insert(0,sys.argv[1])
import pruefer_cprojekt as c
a=json.load(sys.stdin)
print(json.dumps(c.pruefe(a.pop("art"),a)))
`;
let aufrufe = 0, checks = 0;
const adapter = (art, dateien) => {
  const r = spawnSync('uv', ['run','--no-project','--python',process.env.P16_PYTHON || '/usr/bin/python3',
    'python','-c', python, provider], {
    input:JSON.stringify({art, dateien, projekte:['.'], zeitlimit_s:30}), encoding:'utf8', timeout:60000,
    maxBuffer:16*1024*1024,
    env:{...process.env, PRUEF_CC:process.env.PRUEF_CC || '/usr/bin/gcc',
      PRUEF_CXX:process.env.PRUEF_CXX || '/usr/bin/g++', PYTHONDONTWRITEBYTECODE:'1'}
  });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  return JSON.parse(r.stdout);
};
const fake = {
  pruefe: async a => { aufrufe++; assert(['cbuild','cppbuild'].includes(a.art)); return adapter(a.art,a.dateien); },
  budget: () => ({speicher_mb:1536,tmpfs_mb:512}), setzeBudget:()=>{},
};
const H = 'int f(int x);\n';
const H2 = 'int f(int x, int y);\n';
const C = '#include "api.h"\nint main(void) { return f(1); }\n';
const files = ext => [
  {pfad:'include/api.h',inhalt:H},
  {pfad:'src/main.'+ext,inhalt:C}
];
const seed = async (p,c) => {
  await pool.query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored,parsed_at,parser_version)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),1)
  ON CONFLICT(project,file_path) DO UPDATE SET content=$7,content_hash=$8,file_size=$6,deleted_at=NULL`,
  [randomUUID(),project,p,p.split('/').at(-1),p.split('.').at(-1),Buffer.byteLength(c),c,createHash('sha256').update(c).digest('hex')]);
};
const pd = (p,alt,neu) => ({file_path:p,basis:alt,ergebnis:neu,geloescht:false,
  ops:[{op_index:0,agent_id:'sol16-test',spannen:[[0,neu.split('\n').length]]}]});
const check = async (name,fn)=>{await fn();checks++;console.log('OK '+name);};
try {
  assert.equal(typeof BUILD_PRUEFUNG_SCHEMA_SQL,'string');
  await pool.query(BUILD_PRUEFUNG_SCHEMA_SQL);
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)',[project,'sol16-test',tmp]);
  await pool.query(`INSERT INTO build_pruefung_einstellungen(bereich,werte) VALUES($1,$2::jsonb)`,
    ['projekt:'+project,JSON.stringify({aktiv:true,sprachen:['c','cpp']})]);
  for(const d of files('c')) await seed(d.pfad,d.inhalt);
  await seed('src/alt.c','int alt(void) { return unbekannt; }\n');
  bp.registriereBuildPruefer(fake);
  await check('Header-Signatur -> neuer Fehler im unveraenderten C-Aufrufer; Altfehler ignoriert',async()=>{
    const r=await bp.pruefeBuildFuerPlan(project,[pd('include/api.h',H,H2)],{warten:true});
    assert(r && r.befunde.some(b=>b.datei==='src/main.c'),'Fachliche Rotkontrolle: Headerfehler muss Aufrufer erreichen: '+JSON.stringify(r));
    assert.equal(r.stand.status,'fertig',JSON.stringify(r));
    assert.equal(r.befunde.length,1,JSON.stringify(r));
    assert.equal(r.befunde[0].op_index,null);
    assert.deepEqual(r.befunde[0].beteiligt,[0]);
    assert.equal(r.befunde[0].quelle,'build');
    assert(!r.befunde.some(b=>b.datei==='src/alt.c'));
  });
  await check('C/C++ lassen sich ueber build_einstellungen sprachen explizit zuschalten',async()=>{
    const r=await bp.fuehreBuildActionAus('build_einstellungen',
      {project,modus:'setzen',sprachen:['c','cpp'],grund:'P16-T18 explizite C/C++-Testauswahl'},'koordinator');
    assert.equal(r.success,true,JSON.stringify(r));
    assert.deepEqual(r.sprachen_wirksam,['c','cpp']);
    assert(bp.BUILD_PARAMETER.sprachen.items.enum.includes('c'));
    assert(bp.BUILD_PARAMETER.sprachen.items.enum.includes('cpp'));
  });
  await check('Zeilenverschiebung eines Altfehlers bleibt ohne neuen Befund',async()=>{
    const r=await bp.pruefeBuildFuerPlan(project,[pd('src/alt.c','int alt(void) { return unbekannt; }\n',
      '\n\nint alt(void) { return unbekannt; }\n')],{warten:true});
    assert.equal(r.stand.neue_fehler,0,JSON.stringify(r));
  });
  await check('Abwahl sprachen: C/C++ im Projekt leer -> kein Adapteraufruf',async()=>{
    await pool.query('UPDATE build_pruefung_einstellungen SET werte=$2 WHERE bereich=$1',
      ['projekt:'+project,{aktiv:true,sprachen:[]}]);
    const n=aufrufe;
    assert.equal(await bp.pruefeBuildFuerPlan(project,[pd('include/api.h',H,H2)],{warten:true}),null);
    assert.equal(aufrufe,n);
    await pool.query('UPDATE build_pruefung_einstellungen SET werte=$2 WHERE bereich=$1',
      ['projekt:'+project,{aktiv:true,sprachen:['c','cpp']}]);
  });
  await check('C++-TU: Header-Signatur ueber Dateigrenze',async()=>{
    const ds=files('cpp').map(d=>d.pfad==='include/api.h'?{...d,inhalt:H2}:d);
    const r=adapter('cppbuild',ds);
    assert.equal(r.status,'fertig',JSON.stringify(r));
    assert(r.diagnosen.some(d=>d.datei==='src/main.cpp'));
  });
  await check('compile_commands: relative Flags -I/-D/-std, unbekannter Compilername nur Daten',async()=>{
    const ds=[{pfad:'api.h',inhalt:'int f(int x);\n'}, {pfad:'main.c',inhalt:'#include "api.h"\nint main(void) { return f(VALUE); }\n'},
      {pfad:'compile_commands.json',inhalt:JSON.stringify([{directory:'.',file:'main.c',
        arguments:['niemals-ausfuehren','-I.','-DVALUE=1','-std=c17','-c','main.c','-o','x.o']}])}];
    const r=adapter('cbuild',ds);
    assert.equal(r.status,'fertig',JSON.stringify(r));assert.equal(r.diagnosen.length,0);
  });
  await check('Absolute compile_commands-Wurzel wird auf PG-Quellen abgebildet',async()=>{
    const ds=[...files('c'),{pfad:'compile_commands.json',inhalt:JSON.stringify([{
      directory:'/home/example/projekt/build',file:'../src/main.c',
      arguments:['/untrusted/wrapper','-I/home/example/projekt/include','-std=c17','-c','../src/main.c']
    }])}];
    const r=adapter('cbuild',ds);
    assert.equal(r.status,'fertig',JSON.stringify(r));assert.equal(r.diagnosen.length,0);
  });
  await check('Plugin/Wrapper/Shell/Output werden nie ausgefuehrt: teilweise statt falschem Gruen',async()=>{
    const marker=join(tmp,'nicht-anlegen');
    const ds=[...files('c'),{pfad:'compile_commands.json',inhalt:JSON.stringify([{
      directory:'.',file:'src/main.c',command:'sh -c "touch '+marker+'" gcc -Iinclude -fplugin=/tmp/boese.so -o /tmp/boese.o src/main.c'
    }])}];
    const r=adapter('cbuild',ds);
    assert.equal(r.status,'teilweise',JSON.stringify(r));assert.equal(r.diagnosen.length,0);
    assert.match(r.hinweis,/ignoriert/);assert.equal(existsSync(marker),false);
  });
  await check('Fehlender Systemheader/SDK -> teilweise, kein Befund',async()=>{
    const r=adapter('cbuild',[{pfad:'src/main.c',inhalt:'#include <sdk_nicht_da_16.h>\nint f(void) { return 1; }\n'}]);
    assert.equal(r.status,'teilweise',JSON.stringify(r));assert.equal(r.diagnosen.length,0);
    assert.match(r.hinweis,/Header|SDK/);
  });
  await check('Ohne Include-Kontext -> teilweise; ObjC sichtbar nicht unterstuetzt',async()=>{
    const r=adapter('cbuild',[{pfad:'main.c',inhalt:'int main(void) { return 0; }\n'}]);
    assert.equal(r.status,'teilweise',JSON.stringify(r));
    const objc=adapter('cbuild',[{pfad:'src/main.m',inhalt:'@interface A\n@end\n'}]);
    assert.equal(objc.status,'teilweise');assert.match(objc.hinweis,/ObjC nicht unterstuetzt/);
  });
  await check('Stabile Spanne und relativer Pfad bei verschobener Compilerdiagnose',async()=>{
    const bad='#include "api.h"\nint main(void) { return f(1, 2); }\n';
    const a=adapter('cbuild',files('c').map(d=>d.pfad==='src/main.c'?{...d,inhalt:bad}:d));
    const b=adapter('cbuild',files('c').map(d=>d.pfad==='src/main.c'?{...d,inhalt:'\n\n'+bad}:d));
    assert.equal(a.status,'fertig');assert.equal(b.status,'fertig');
    assert.equal(a.diagnosen[0].stabile_spanne,b.diagnosen[0].stabile_spanne);
    assert.equal(b.diagnosen[0].zeile,a.diagnosen[0].zeile+2);
    assert.equal(a.diagnosen[0].datei,'src/main.c');
  });
  await check('build_status meldet Basis unter c (keine Python-Fehlzuordnung)',async()=>{
    await bp.pruefeBuildBasis(project,30000);
    const r=await bp.fuehreBuildActionAus('build_status',{project},'sol16-test');
    const s=r.projekte.find(p=>p.project===project);
    assert(s.basis_sprachen.c,JSON.stringify(r));
    assert.equal(s.basis_sprachen.python,undefined);
  });
  console.log('TEST_GRUEN P16-T18 E3a checks='+checks);
} finally {
  bp.registriereBuildPruefer(null);
  await pool.query('DELETE FROM code_files WHERE project=$1',[project]);
  await pool.query('DELETE FROM build_pruefung_einstellungen WHERE bereich=$1',['projekt:'+project]);
  await pool.query('DELETE FROM projects WHERE name=$1',[project]);
  rmSync(tmp,{recursive:true,force:true});await db.closePool();
}
