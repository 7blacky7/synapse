/** P18-T49/RV34: Spurtabellen-Pruefung in TS (pruefeReverseSpurtabelle) und im Runner (disc.py pruefe_spurtabelle)
 * liefern fuer dieselben synthetischen Tabellen dasselbe Ergebnis (ok bzw. Fehlercode). Keine DB, keine Spieldaten. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const core=await import('../dist/index.js');
const DISC_PY=fileURLToPath(new URL('../../../docker/synapse-reverse/disc.py',import.meta.url));

const ab=(lba,sektoren,datei,byte_offset,sektorgroesse=2352,subchannel=null)=>({lba,sektoren,datei,byte_offset,sektorgroesse,subchannel});
const spur=(nummer,session,mode,start,laenge,abschnitte,pregap=0,sektorgroesse=2352)=>({nummer,session,art:mode==='AUDIO'?'audio':'daten',mode,
 sektorgroesse,subchannel:null,datei:null,byte_offset:null,start_lba:start,laenge_sektoren:laenge,pregap,pregap_in_datei:false,postgap:0,
 indizes:[{nummer:1,lba:start}],isrc:null,titel:null,audio_byte_reihenfolge:mode==='AUDIO'?'le':null,abschnitte});
/** Mixed Mode: Spur 1 MODE1, Spur 2 Audio mit Pregap im Image, Spur 3 Audio mit Pregap ausserhalb des Images. */
const basis=()=>({version:core.REVERSE_SPURTABELLE_VERSION,medium:'cd',format:'test',katalognummer:null,lead_out_lba:430,layer_break:null,
 parser:{id:'test',version:'1',registry_version:'2'},sessions:[{nummer:1,lead_out_lba:430,spuren:[
  spur(1,1,'MODE1',0,100,[ab(0,100,'a.bin',0)]),
  spur(2,1,'AUDIO',250,100,[ab(100,150,'a.bin',100*2352),ab(250,100,'a.bin',250*2352)],150),
  spur(3,1,'AUDIO',400,30,[ab(350,50,null,0),ab(400,30,'a.bin',350*2352)],50)]}]});
const G={'a.bin':380*2352};
const mit=(fn,groessen=G)=>{const t=basis();fn(t);return {t,g:groessen};};
const sp=(t,i)=>t.sessions[0].spuren[i];

const faelle={
 gueltig:[mit(()=>{}),'ok'],
 spur_ausserhalb_der_datei:[mit(t=>{sp(t,2).laenge_sektoren=31;sp(t,2).abschnitte[1].sektoren=31;t.lead_out_lba=431;t.sessions[0].lead_out_lba=431;}),'beschaedigt'],
 ueberlappung:[mit(t=>{sp(t,0).laenge_sektoren=120;sp(t,0).abschnitte[0].sektoren=120;}),'beschaedigt'],
 audio_mit_2048:[mit(t=>{sp(t,1).sektorgroesse=2048;}),'nicht_unterstuetzt'],
 unbekannter_modus:[mit(t=>{sp(t,0).mode='MODE9';}),'nicht_unterstuetzt'],
 art_passt_nicht:[mit(t=>{sp(t,0).art='audio';}),'beschaedigt'],
 datei_fehlt:[mit(()=>{},{'b.bin':380*2352}),'nicht_gefunden'],
 abschnitt_luecke:[mit(t=>{sp(t,1).abschnitte[0].lba=101;sp(t,1).abschnitte[0].sektoren=149;}),'beschaedigt'],
 abschnitte_decken_nicht:[mit(t=>{sp(t,0).abschnitte[0].sektoren=99;}),'beschaedigt'],
 wechselnde_sektorgroesse:[mit(t=>{sp(t,1).abschnitte[0].sektoren=150;sp(t,1).abschnitte[0].sektorgroesse=2336;}),'nicht_unterstuetzt'],
 doppelte_spur:[mit(t=>{sp(t,2).nummer=2;}),'beschaedigt'],
 laenge_null:[mit(t=>{sp(t,2).laenge_sektoren=0;}),'beschaedigt'],
 version_unbekannt:[mit(t=>{t.version=2;}),'beschaedigt'],
 lead_out_vor_spurende:[mit(t=>{t.lead_out_lba=200;}),'beschaedigt'],
 sub_getrennt_ok:[mit(t=>{sp(t,0).abschnitte[0].subchannel={art:'getrennt',groesse:96,datei:'a.sub',byte_offset:0};},{...G,'a.sub':380*96}),'ok'],
 sub_getrennt_zu_kurz:[mit(t=>{sp(t,2).abschnitte[1].subchannel={art:'getrennt',groesse:96,datei:'a.sub',byte_offset:360*96};},{...G,'a.sub':380*96}),'beschaedigt'],
 sub_datei_fehlt:[mit(t=>{sp(t,0).abschnitte[0].subchannel={art:'getrennt',groesse:96,datei:'a.sub',byte_offset:0};}),'nicht_gefunden'],
 sub_verschachtelt_sprengt_datei:[mit(t=>{sp(t,2).abschnitte[1].subchannel={art:'verschachtelt',groesse:96,datei:null,byte_offset:null};}),'beschaedigt'],
 sub_groesse_unbekannt:[mit(t=>{sp(t,0).abschnitte[0].subchannel={art:'verschachtelt',groesse:32,datei:null,byte_offset:null};}),'nicht_unterstuetzt'],
 mode2_form2_2324:[{t:{...basis(),lead_out_lba:null,sessions:[{nummer:1,lead_out_lba:null,spuren:[spur(1,1,'MODE2_FORM2',0,10,[ab(0,10,'f2.bin',0,2324)],0,2324)]}]},g:{'f2.bin':10*2324}},'ok'],
 multisession:[{t:{...basis(),lead_out_lba:null,sessions:[{nummer:1,lead_out_lba:100,spuren:[spur(1,1,'AUDIO',0,100,[ab(0,100,'a.bin',0)])]},
  {nummer:2,lead_out_lba:null,spuren:[spur(2,2,'MODE1',11500,50,[ab(11500,50,'a.bin',100*2352)])]}]},g:G},'ok'],
 sessions_nicht_aufsteigend:[{t:{...basis(),lead_out_lba:null,sessions:[{nummer:2,lead_out_lba:null,spuren:[spur(1,2,'MODE1',0,10,[ab(0,10,'a.bin',0)])]},
  {nummer:1,lead_out_lba:null,spuren:[spur(2,1,'MODE1',20,10,[ab(20,10,'a.bin',10*2352)])]}]},g:G},'beschaedigt'],
};

const ts=({t,g})=>{try{core.pruefeReverseSpurtabelle(t,g);return 'ok';}catch(e){if(e instanceof core.ReverseSpurtabellenFehler)return e.code;throw e;}};
const PY=`import importlib.util,json,sys
s=importlib.util.spec_from_file_location('reverse_disc',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
out={}
for name,f in json.load(sys.stdin).items():
    try:
        d.pruefe_spurtabelle(f['t'],f['g']);out[name]='ok'
    except d.DiscFehler as e:
        out[name]=e.code
print(json.dumps(out))`;

test('P18-T49 Spurtabellen-Pruefung: TS und Runner (disc.py) gleich',()=>{
 const eingabe=Object.fromEntries(Object.entries(faelle).map(([n,[f]])=>[n,f]));
 const py=spawnSync('python3',['-I','-c',PY,DISC_PY],{input:JSON.stringify(eingabe),encoding:'utf8',timeout:60000});
 assert.equal(py.status,0,py.stderr);
 const pyErg=JSON.parse(py.stdout);
 for(const [name,[fall,erwartet]] of Object.entries(faelle)){
  assert.equal(ts(fall),erwartet,'TS '+name);
  assert.equal(pyErg[name],erwartet,'Runner '+name);
 }
 assert.equal(core.reverseSpurSchritt({sektorgroesse:2352,subchannel:{art:'verschachtelt',groesse:96,datei:null,byte_offset:null}}),2448);
 assert.equal(core.reverseSpurSchritt({sektorgroesse:2352,subchannel:{art:'getrennt',groesse:96,datei:'a.sub',byte_offset:0}}),2352);
 assert.deepEqual([...core.REVERSE_SPUR_MODI].sort(),JSON.parse(spawnSync('python3',['-I','-c',
  "import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(s);s.loader.exec_module(d)\nprint(json.dumps(sorted(d.MODI)))",DISC_PY],{encoding:'utf8'}).stdout),'gleiche Modi');
});
