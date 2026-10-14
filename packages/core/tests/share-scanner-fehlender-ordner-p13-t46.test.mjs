/** P13-T46: fehlender Projekt-Share-Ordner = kein Fehler, kein Eintrag; echte Fehler bleiben laut.
 * Reines FS mit mkdtemp-Wurzel und In-Memory-Checkpointstore (keine SQL, keine DB). */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {ShareScanner}=await import('../dist/services/share-scanner.js');
const {ladeAssetKonfiguration}=await import('../dist/config/asset-konfig.js');

async function aufbau(t){
 const root=await fs.mkdtemp(join(tmpdir(),'p13-t46-'));
 t.after(async()=>{await fs.chmod(join(root,'share','gesperrt'),0o755).catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
 const share=join(root,'share'),aussen=join(root,'aussen');
 await fs.mkdir(share);await fs.mkdir(aussen);
 const cfg=ladeAssetKonfiguration({SYNAPSE_ASSET_ENABLED:'1',SYNAPSE_PROJEKTE_ROOT:share});
 const checkpoints=new Map(),fehler=[],dateien=[];
 const store={laden:async k=>checkpoints.get(k)??null,speichern:async(k,v)=>{checkpoints.set(k,structuredClone(v));}};
 const scanner=wurzeln=>{
  const s=new ShareScanner({konfiguration:cfg,store,fehler:e=>fehler.push(e)});
  s.registrieren('projekt',{wurzeln:async()=>wurzeln,datei:async d=>{dateien.push(d.wurzel.id+':'+d.pfad);}});
  return s;
 };
 return {root,share,aussen,cfg,checkpoints,fehler,dateien,scanner};
}
function debugZaehler(t){
 const meldungen=[],alt=console.debug;
 console.debug=(...a)=>{meldungen.push(a.join(' '));};
 t.after(()=>{console.debug=alt;});
 return meldungen;
}

test('fehlender Projektordner und fehlender assets/binaries-Ordner: kein Fehler, kein Eintrag, Debug nur einmal',async t=>{
 const e=await aufbau(t),debug=debugZaehler(t);
 await fs.mkdir(join(e.share,'teilweise'));
 const s=e.scanner([
  {id:'fehlt:assets',pfad:join(e.share,'fehlt','assets')},
  {id:'fehlt:binaries',pfad:join(e.share,'fehlt','binaries')},
  {id:'teilweise:assets',pfad:join(e.share,'teilweise','assets')},
 ]);
 await s.durchlauf();await s.durchlauf();
 assert.deepEqual(e.fehler.map(String),[]);
 assert.equal(e.checkpoints.size,0,'kein Checkpoint fuer fehlende Ordner');
 assert.deepEqual(e.dateien,[]);
 assert.equal(debug.filter(m=>m.includes('share-scanner')).length,3,'je fehlender Wurzel hoechstens einmal debug');
});

test('vorhandene Wurzel wird weiter gescannt, fehlende daneben stoert nicht',async t=>{
 const e=await aufbau(t);debugZaehler(t);
 await fs.mkdir(join(e.share,'da','assets'),{recursive:true});
 await fs.writeFile(join(e.share,'da','assets','bild.gif'),'GIF89a');
 const s=e.scanner([{id:'fehlt',pfad:join(e.share,'fehlt','assets')},{id:'da',pfad:join(e.share,'da','assets')}]);
 await s.durchlauf();await s.durchlauf();
 assert.deepEqual(e.fehler.map(String),[]);
 assert.deepEqual(e.dateien,['da:bild.gif']);
 assert.equal(e.checkpoints.size,1);
});

test('Symlink-Ausbruch als Wurzel bleibt laut',async t=>{
 const e=await aufbau(t);
 await fs.mkdir(join(e.share,'p'));await fs.symlink(e.aussen,join(e.share,'p','assets'));
 await e.scanner([{id:'p',pfad:join(e.share,'p','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.match(String(e.fehler[0]),/verlässt/);
});

test('Symlinkter Projektordner (Elternteil) bleibt laut, auch wenn das Ziel darunter fehlt',async t=>{
 const e=await aufbau(t);
 await fs.symlink(e.aussen,join(e.share,'p'));
 await e.scanner([{id:'p',pfad:join(e.share,'p','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.equal(e.fehler[0].code,'ENOENT');
});

test('haengender Symlink als Wurzel bleibt laut',async t=>{
 const e=await aufbau(t);
 await fs.mkdir(join(e.share,'p'));await fs.symlink(join(e.aussen,'gibtsnicht'),join(e.share,'p','assets'));
 await e.scanner([{id:'p',pfad:join(e.share,'p','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.equal(e.fehler[0].code,'ENOENT');
});

test('Symlink-Schleife bleibt laut (ELOOP)',async t=>{
 const e=await aufbau(t);
 await fs.mkdir(join(e.share,'p'));await fs.symlink(join(e.share,'p','assets'),join(e.share,'p','assets'));
 await e.scanner([{id:'p',pfad:join(e.share,'p','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.equal(e.fehler[0].code,'ELOOP');
});

test('fehlende Wurzel ausserhalb des Mounts bleibt laut',async t=>{
 const e=await aufbau(t);
 await e.scanner([{id:'x',pfad:join(e.aussen,'fehlt','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.equal(e.fehler[0].code,'ENOENT');
});

test('fehlende Rechte bleiben laut (EACCES)',{skip:process.getuid?.()===0&&'root ignoriert Rechte'},async t=>{
 const e=await aufbau(t);
 await fs.mkdir(join(e.share,'gesperrt','p'),{recursive:true});await fs.chmod(join(e.share,'gesperrt'),0o000);
 await e.scanner([{id:'g',pfad:join(e.share,'gesperrt','p','assets')}]).durchlauf();
 assert.equal(e.fehler.length,1);assert.equal(e.fehler[0].code,'EACCES');
});
