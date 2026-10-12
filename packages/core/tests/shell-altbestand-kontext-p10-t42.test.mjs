/** P10-T42 Korrektur: bestehende Live-Maske bytegleich, präziser Trefferkontext, Fake-Jev. */
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const env=await import('../dist/services/env-maske.js'),alt=await import('../dist/services/shell-altbestand.js');
const cases=[['port=5433 hash=abcdef0123456789',[]],['TOKEN=fake-token-abcdefgh',[]],['API_TOKEN="fake-token-abcdefgh"',[]],['{"password":"fake-json-abcdefgh","count":5}',[]],['AUTHORIZATION=Bearer fake-bearer-abcdefgh',[]],['https://user:fake-url-abcdefgh@example/path',[]],['command sshpass -p fake-known-abcdefgh host',['fake-known-abcdefgh']],['ordinary ordinary',['ordinary']],['TOKEN=fake-token-abcdefgh\nPASSWORD=fake-pass-abcdefgh',[]]];
const outputs=cases.map(([s,w])=>env.maskiereShellText(s,w));
assert.equal(createHash('sha256').update(JSON.stringify(outputs)).digest('hex'),'69de6f1db9950231f6b0075e46c10cb4ca27d672cc11ad42dbc613f5bc2fd5a7','ALT-Golden 56146f26 unverändert');
assert.equal(typeof env.maskiereShellTextMitTreffern,'function','RED: Live-Maske muss Kategorien und Originalspannen liefern');
for(const [i,[text,values]]of cases.entries()){
 const traced=env.maskiereShellTextMitTreffern(text,values);
 assert.deepEqual({text:traced.text,maskiert:traced.maskiert},outputs[i],'Trace-Variante ändert keine Maskierung');
 for(const hit of traced.treffer){assert(hit.regel);assert(hit.start>=0&&hit.ende>hit.start&&hit.ende<=text.length);}
}
const uiKey=env.maskiereShellTextMitTreffern('<node password="false">',['password']);
assert.equal(uiKey.treffer.length,1,'RED: maskierter Feldname darf keine phantomartige Wert-Ersetzung erzeugen');
assert.equal(uiKey.treffer[0].regel,'env_literal');
assert.equal('<node password="false">'.slice(uiKey.treffer[0].start,uiKey.treffer[0].ende),'password');
const secret='fake-selected-abcdefgh',other='fake-other-abcdefgh';
const raw=Array.from({length:80},(_,i)=>i===49?'TOKEN='+secret:i===51?'PASSWORD='+other:'line '+(i+1)).join('\n');
const rows=[{tabelle:'shell_jobs',id:'fixture',project:'test-t42-kontext',daten:{output:raw}}];
const groups=alt.gruppiereShellAltbestand(rows,[secret,other]);
assert.equal(groups.length,2);
const selected=groups.find(g=>g.name==='TOKEN');assert(selected,'Name');
assert.equal(selected.zeile,50);assert.equal(selected.regel,'kv_geheimname');
assert(selected.fenster.includes('50: TOKEN=⟦TREFFER⟧'));
assert(selected.fenster.includes('52: PASSWORD=[WERT]'));
assert.equal((selected.fenster.match(/⟦TREFFER⟧/g)||[]).length,1,'genau eine Zielmarkierung');
assert(!JSON.stringify(groups).includes(secret));assert(!JSON.stringify(groups).includes(other));
assert(!selected.fenster.includes('line 46'));assert(!selected.fenster.includes('line 54'));
const diagnostic=[
 {text:'DATABASE_URL=postgres://alice:fake-url-abcdefgh@host/db',values:[],regel:'url_passwort'},
 {text:'Authorization: Bearer fake-bearer-abcdefgh',values:[],regel:'bearer'},
 {text:'sshpass -p fake-known-abcdefgh host',values:['fake-known-abcdefgh'],regel:'sshpass_passwort'},
 {text:'TOKEN=fake-token-abcdefgh',values:[],regel:'kv_geheimname'},
];
let sent=0;
for(const f of diagnostic){
 const gs=alt.gruppiereShellAltbestand([{...rows[0],daten:{output:f.text}}],f.values);
 assert(gs.some(g=>g.regel===f.regel));
 const r=await alt.bewerteShellAltbestand(gs,{project:null},{rufeJev:async()=>{sent++;throw Error('Deterministisch darf Jev nicht aufrufen');}});
 assert(r.bewertungen.every(b=>b.bewertung==='geheimnis'&&b.grund==='deterministisch'));
}
assert.equal(sent,0);
const ui=alt.gruppiereShellAltbestand([{...rows[0],daten:{output:'UI ordinary label'}}],['ordinary']);
assert.equal(ui[0].regel,'env_literal');assert.equal(ui[0].literal_normales_wort,true);
const json=alt.gruppiereShellAltbestand([{...rows[0],tabelle:'tool_calls',daten:{result:JSON.stringify({api_key:'fake-json-abcdefgh'})}}],[]);
assert(json.some(g=>g.regel==='json_geheimname'&&g.name==='api_key'));
const fake=(choice,confidence)=>async a=>{
 assert(a.state.regel);assert(a.state.fenster.includes('⟦TREFFER⟧'));assert.equal(a.state.zeile,1);
 assert(!JSON.stringify(a).includes('ordinary'),'kein Roh-Literal im Jev-Auftrag');
 return {ok:true,daten:{answers:{bewertung:{choice,confidence}}},dauer_ms:0,modell:'fake',kosten:{usd:0,quelle:'keine',input_tokens:null,output_tokens:null}};
};
for(const [choice,below,at]of [['falsch',0.89,0.9],['geheimnis',0.59,0.6],['beispiel',0.69,0.7]]){
 const low=await alt.bewerteShellAltbestand(ui,{project:null},{rufeJev:fake(choice,below)});assert.equal(low.bewertungen[0].bewertung,'offen');
 const good=await alt.bewerteShellAltbestand(ui,{project:null},{rufeJev:fake(choice,at)});assert.equal(good.bewertungen[0].bewertung,choice);
 if(choice==='geheimnis')assert.equal(alt.planeShellAltbestand([{...rows[0],daten:{output:'UI ordinary label'}}],['ordinary'],good.bewertungen).length,1);
}
const previous=ui[0].fenster;ui[0].fenster='raw injected value';
await assert.rejects(()=>alt.bewerteShellAltbestand(ui,{project:null},{rufeJev:fake('falsch',0.99)}));
ui[0].fenster=previous;
console.log('OK ALT-Golden, Regeln/Spannen, markiertes ±3-Zeilenfenster, deterministische Fälle, asymmetrische Tore, kein Klartext an Jev');
