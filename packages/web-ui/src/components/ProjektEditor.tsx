import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { apiFetch } from '../api/auth';
import '../editor-p22-t256.css';
// P22-T263: Editor-Live-Plan als durchgehender Strom aus PG (Schalter editor_plan_strom; AUS = Live-Pläne je Datei wie unten).
import { usePlanStrom, PlanStromListe, PlanStromDetail } from './editor/PlanStrom';
// P22-T266: Syntax-Hervorhebung (Schalter editor_syntax; CodeMirror nur per dynamischem import in editor/syntax.ts).
import { leseArbeitsbereichSchalter } from '../api/arbeitsbereich-schalter';
import { CodeFeld } from './editor/CodeFeld';
import { SyntaxAn, useZeilenTokens, ZeilenInhalt, HervorgehobenerText } from './editor/hervorhebung';

type Datei={file_path:string;inhalt:string;basis_hash?:string;maskiert?:boolean};
type Plan={id:string;owner_agent_id:string|null;status:string};
// P22-T264: EIN offener files-Plan des Users je Projekt (Datenvertrag claude-birke, Channel 34579); ersetzt die Prüfplan-Liste.
type UserOp={index:number;action:string;agent_id:string|null;ok:boolean;error?:string};
type UserPlanDatei={file_path:string;basis_hash?:string;aktuell_hash?:string;konflikt:boolean;ops:UserOp[]};
type UserPlan={plan_id:string;status:string;dateien:UserPlanDatei[]};
async function json(url:string, init?:RequestInit):Promise<any> {
  const r=await apiFetch(url,init),d=await r.json();
  if(!r.ok||d.success===false)throw new Error(typeof d.error==='string'?d.error:d.error?.message||'HTTP '+r.status);
  return d;
}
const q=(v:string)=>encodeURIComponent(v);

/*
 * P22-T262 Gestaltung (claude-linde): Bedienung wie VS Code - Explorer (Baum + Filter) links, Reiter, Pfadzeile und Code mit
 * Zeilennummern in der Mitte, Inspektor rechts (Live-Pläne mit Nachleuchten und Pins | Meine Prüfpläne), Drei-Wege-Vergleich als
 * unteres Panel, Statusleiste unten (Freeze = oranges Segment). Strg+S speichert im Freeze als Prüfplan.
 * Datenverträge, Routen und Agentenlogik von P22-T256 sind unverändert; neu sind nur reine Bedienzustände (Reiter, offene Ordner,
 * Filter, Inspektor-Seite). DEBUG: data-abbild / data-modus / data-live / data-reiter am Wurzelelement.
 */
type Knoten={name:string;pfad:string;ordner:Knoten[];dateien:string[]};
/** Baum aus der flachen Pfadliste: Ordner zuerst, dann Dateien, je alphabetisch. */
function baueBaum(pfade:string[]):Knoten {
  const wurzel:Knoten={name:'',pfad:'',ordner:[],dateien:[]}, index=new Map<string,Knoten>([['',wurzel]]);
  for (const p of pfade) {
    const teile=p.split('/'); let eltern=wurzel, weg='';
    for (const teil of teile.slice(0,-1)) {
      weg=weg?weg+'/'+teil:teil; let k=index.get(weg);
      if(!k){k={name:teil,pfad:weg,ordner:[],dateien:[]};index.set(weg,k);eltern.ordner.push(k);}
      eltern=k;
    }
    eltern.dateien.push(p);
  }
  const sortiere=(k:Knoten)=>{k.ordner.sort((a,b)=>a.name.localeCompare(b.name));k.dateien.sort((a,b)=>a.localeCompare(b));k.ordner.forEach(sortiere);};
  sortiere(wurzel); return wurzel;
}
const dateiname=(p:string)=>p.slice(p.lastIndexOf('/')+1);
const ordnerVon=(p:string)=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
const vorfahren=(p:string)=>{const t=p.split('/');return t.slice(0,-1).map((_,i)=>t.slice(0,i+1).join('/'));};
const kurzId=(id:string)=>id.length>12?id.slice(0,8):id;

/** Eine Spalte des Drei-Wege-Vergleichs; Zeilen, die im Bezug fehlen, sind markiert (neu/geändert bzw. entfernt). */
function DreiWegeSpalte({titel,text,bezug,art,pfad}:{titel:string;text:string|null;bezug:Set<string>|null;art:'basis'|'entwurf'|'aktuell';pfad:string}) {
  const zeilen=text===null?null:text.split('\n');
  const tokens=useZeilenTokens(pfad,text);
  return <div className="ed-vergleich-spalte" data-art={art}><h4>{titel}</h4>
    {zeilen===null?<p className="ed-vergleich-fehlt">Datei fehlt</p>
      :<pre>{zeilen.map((z,i)=><span key={i} className={bezug&&!bezug.has(z)?(art==='basis'?'weg':'anders'):undefined}><i aria-hidden="true">{i+1}</i>{z?<ZeilenInhalt tokens={tokens?.[i]} roh={z}/>:' '}</span>)}</pre>}
  </div>;
}

/** P22-T256: lesender Projektindex und festes Abbild. P22-T264: Speichern legt die Änderung als Ops in EINEN offenen files-Plan des Users
 * (Co-Edit an); „Prüfen lassen“ schickt ausdrücklich einen Prüfauftrag an den Koordinator. */
export function ProjektEditor({project}:{project:string}) {
 const [dateien,setDateien]=useState<string[]>([]),[pfad,setPfad]=useState(''),[datei,setDatei]=useState<Datei|null>(null);
 const [freeze,setFreeze]=useState<string|null>(null),[abbilder,setAbbilder]=useState<string[]>([]),[pauseAbbild,setPauseAbbild]=useState(false),[entwuerfe,setEntwuerfe]=useState<Record<string,string>>({});
 const [plaene,setPlaene]=useState<Plan[]>([]),[auswahl,setAuswahl]=useState(''),[schatten,setSchatten]=useState('');
 const [nachklang,setNachklang]=useState<Plan[]>([]),[pins,setPins]=useState<Record<string,{text:string;pfad:string}>>({});
 const offeneRef=useRef<Plan[]>([]), timers=useRef<number[]>([]);
 const [fehler,setFehler]=useState(''),[info,setInfo]=useState(''),[busy,setBusy]=useState(false),[live,setLive]=useState(true);
 const [userPlan,setUserPlan]=useState<UserPlan|null>(null),[pruefText,setPruefText]=useState('');
 const [vergleich,setVergleich]=useState<{basis:string|null;entwurf:string|null;aktuell:string|null;konflikt:boolean;file_path?:string}|null>(null);
 const [ereignisNr,setEreignisNr]=useState(0);
 // P22-T266: Syntax-Hervorhebung (Schalter editor_syntax, Standard AUS; AUS = Textfeld und Klartext wie P22-T262).
 const [syntaxAn,setSyntaxAn]=useState(false);
 useEffect(()=>{let lebt=true;setSyntaxAn(false);void leseArbeitsbereichSchalter(project,'editor_syntax').then(s=>{if(lebt)setSyntaxAn(s.aktiv);});return()=>{lebt=false;};},[project]);
 const pfadRef=useRef(pfad);pfadRef.current=pfad;
 const auswahlRef=useRef(auswahl);auswahlRef.current=auswahl;
 const dateiliste=async()=>{const d=await json('/api/main-agent/editor/dateien?project='+q(project));setDateien(d.dateien);};
 const userPlanLaden=async()=>{const d=await json('/api/main-agent/editor/user-plan?project='+q(project));setUserPlan((d.plan??null) as UserPlan|null);};
 const userPlanDatei=async(path:string)=>{try{const d=await json('/api/main-agent/editor/user-plan/datei?project='+q(project)+'&path='+q(path));setVergleich(d.datei);}catch(e){setFehler(String(e));}};
 const aktuellePlaene=async(path:string)=>{if(!path)return;const d=await json('/api/main-agent/editor/plaene?project='+q(project)+'&path='+q(path));
  if(pfadRef.current!==path)return; const neu=d.plaene as Plan[], entfernt=offeneRef.current.filter(p=>!neu.some(x=>x.id===p.id)); offeneRef.current=neu;setPlaene(neu);
  if(entfernt.length){setNachklang(v=>[...v.filter(x=>!entfernt.some(p=>p.id===x.id)),...entfernt]);
   const ids=entfernt.map(x=>x.id);const timer=window.setTimeout(()=>setNachklang(v=>v.filter(x=>!ids.includes(x.id))),Number(d.nachleuchten_sekunden)*1000);timers.current.push(timer);}
 };
 useEffect(()=>{let lebt=true;setDateien([]);setPfad('');setDatei(null);setFreeze(null);setAbbilder([]);setPauseAbbild(false);setEntwuerfe({});setPlaene([]);offeneRef.current=[];setNachklang([]);setPins({});timers.current.forEach(t=>window.clearTimeout(t));timers.current=[];setAuswahl('');setInfo('');
  void dateiliste().catch(e=>{if(lebt)setFehler(String(e));});void userPlanLaden().catch(e=>{if(lebt)setFehler(String(e));});return()=>{lebt=false;timers.current.forEach(t=>window.clearTimeout(t));timers.current=[];};},[project]);
 useEffect(()=>{if(!pfad)return;let lebt=true;setDatei(null);setSchatten('');setAuswahl('');
  const url=freeze&&!pauseAbbild?'/api/main-agent/editor/abbild/'+q(freeze)+'/datei?project='+q(project)+'&path='+q(pfad)
    :'/api/projects/'+q(project)+'/code-intel/file?path='+q(pfad);
  void json(url).then(d=>{if(!lebt)return;const f=d.datei??d.file;setDatei({file_path:pfad,inhalt:f.inhalt??f.content??'',basis_hash:f.basis_hash,maskiert:f.maskiert===true});},e=>{if(lebt)setFehler(String(e));});
  offeneRef.current=[];setPlaene([]);setNachklang([]); if(live)void aktuellePlaene(pfad).catch(e=>{if(lebt)setFehler(String(e));});
  return()=>{lebt=false;};
 },[project,pfad,freeze,pauseAbbild,live]);
 useEffect(()=>{if(!live)return;const source=new EventSource('/api/main-agent/editor/ereignisse?project='+q(project));
  source.onmessage=()=>{setEreignisNr(n=>n+1);void userPlanLaden().catch(e=>setFehler(String(e)));void aktuellePlaene(pfadRef.current).catch(e=>setFehler(String(e))); const id=auswahlRef.current, path=pfadRef.current;
   if(id && path) void json('/api/main-agent/editor/schatten?project='+q(project)+'&path='+q(path)+'&plan='+q(id)).then(d=>setSchatten(String(d.content??d.file?.content??''))).catch(e=>setFehler(String(e)));};
  return()=>source.close();
 },[project,live]);
 const einfrieren=async()=>{setBusy(true);try {const d=await json('/api/main-agent/editor/abbild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project})});
   const snapshot=await json('/api/main-agent/editor/abbild/'+q(d.abbild.id)+'?project='+q(project));setDateien(snapshot.abbild.dateien);setFreeze(d.abbild.id);setAbbilder(v=>[...v,d.abbild.id]);setPauseAbbild(false);setInfo('Abbild '+d.abbild.id+' eingefroren.');
  }catch(e){setFehler(String(e));}finally{setBusy(false);}};
 const speichern=async()=>{if(!datei||!freeze)return;setBusy(true);try {const d=await json('/api/main-agent/editor/user-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,abbild_id:freeze,file_path:pfad,entwurf:entwuerfe[(freeze??'')+'::'+pfad]??datei.inhalt})});
   const p=(d.plan??null) as UserPlan|null;setUserPlan(p);setSeite('userplan');
   setInfo(p?'Gespeichert in deinem files-Plan '+p.plan_id+' ('+p.dateien.length+(p.dateien.length===1?' Datei':' Dateien')+'). Zum Prüfen rechts „Prüfen lassen“.':'Keine Änderung mehr: Die Ops dieser Datei sind aus deinem Plan genommen.');setFehler('');}catch(e){setFehler(String(e));}finally{setBusy(false);}};
 // P22-T264 U3: ausdrücklicher Prüfauftrag an den Koordinator, optional mit Text; Speichern allein benachrichtigt niemanden.
 const pruefenLassen=async()=>{if(!userPlan)return;setBusy(true);try {const d=await json('/api/main-agent/editor/pruefauftrag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project,plan_id:String(userPlan.plan_id),text:pruefText.trim()||undefined})});
   setInfo(d.koordinatoren_benachrichtigt?'Prüfauftrag für Plan '+userPlan.plan_id+' an den Koordinator geschickt.':'Kein aktiver Koordinator erreichbar. Der Plan bleibt offen.');setPruefText('');setFehler('');}catch(e){setFehler(String(e));}finally{setBusy(false);}};
 const planZeigen=async(id:string)=>{setAuswahl(id);try{const d=await json('/api/main-agent/editor/schatten?project='+q(project)+'&path='+q(pfad)+'&plan='+q(id));setSchatten(String(d.content??d.file?.content??''));}catch(e){setFehler(String(e));}};
 // Freeze lösen/fortsetzen und Abbildwahl: unverändert aus P22-T256, nur aus dem Markup herausgezogen.
 const freezeUmschalten=()=>{setPauseAbbild(v=>!v);if(!pauseAbbild)void dateiliste().catch(e=>setFehler(String(e)));else void json('/api/main-agent/editor/abbild/'+q(freeze ?? '') + '?project='+q(project)).then(d=>setDateien(d.abbild.dateien)).catch(e=>setFehler(String(e)));};
 const abbildWaehlen=(id:string)=>{setFreeze(id);setPauseAbbild(false);void json('/api/main-agent/editor/abbild/'+q(id)+'?project='+q(project)).then(d=>setDateien(d.abbild.dateien)).catch(err=>setFehler(String(err)));};

 // P22-T262: reine Bedienzustände.
 const [reiter,setReiter]=useState<string[]>([]),[offen,setOffen]=useState<Set<string>>(()=>new Set()),[filter,setFilter]=useState(''),[seite,setSeite]=useState<'live'|'userplan'>('live');
 const zeilenRef=useRef<HTMLPreElement>(null);
 const strom=usePlanStrom({project,live,ereignisNr,onFehler:setFehler});
 useEffect(()=>{setReiter([]);setOffen(new Set());setFilter('');},[project]);
 const baum=useMemo(()=>baueBaum(dateien),[dateien]);
 const treffer=useMemo(()=>{const f=filter.trim().toLowerCase();return f?dateien.filter(p=>p.toLowerCase().includes(f)).slice(0,400):null;},[dateien,filter]);
 const oeffnen=(p:string)=>{setPfad(p);setReiter(r=>r.includes(p)?r:[...r,p]);setOffen(o=>{const n=new Set(o);vorfahren(p).forEach(v=>n.add(v));return n;});};
 const schliessen=(p:string)=>{const i=reiter.indexOf(p),rest=reiter.filter(x=>x!==p);setReiter(rest);if(p===pfad)setPfad(rest[Math.min(i,rest.length-1)]??'');};
 const ordnerUmschalten=(p:string)=>setOffen(o=>{const n=new Set(o);if(n.has(p))n.delete(p);else n.add(p);return n;});
 const aktiv=datei&&pfad&&datei.file_path===pfad?datei:null;
 const entwurfVon=(p:string)=>entwuerfe[(freeze??'')+'::'+p];
 const wert=aktiv?(pauseAbbild?aktiv.inhalt:(entwurfVon(pfad)??aktiv.inhalt)):'';
 const geaendert=!!aktiv&&!pauseAbbild&&entwurfVon(pfad)!==undefined&&entwurfVon(pfad)!==aktiv.inhalt;
 const lesend=!freeze||pauseAbbild||!!aktiv?.maskiert;
 const speicherbar=!(!freeze||pauseAbbild||busy||!aktiv||aktiv.maskiert);
 const modus=!freeze?'index':pauseAbbild?'geloest':'freeze';
 const sperrgrund=!aktiv?'Lädt':aktiv.maskiert?'Sensible Datei · nur maskierte Lesesicht':!freeze?'Live-Index · zum Bearbeiten Codebild einfrieren':pauseAbbild?'Freeze gelöst · aktueller Index, nur lesen':'Bearbeitbar · Abbild '+kurzId(freeze);
 const zeilen=useMemo(()=>{const n=wert.split('\n').length;let s='';for(let i=1;i<=n;i++)s+=i+'\n';return {n,s};},[wert]);
 const bezug=useMemo(()=>vergleich?{basis:new Set((vergleich.basis??'').split('\n')),entwurf:new Set((vergleich.entwurf??'').split('\n'))}:null,[vergleich]);
 const taste=(e:KeyboardEvent<HTMLElement>)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(speicherbar)void speichern();}};
 // P22-T262 Textfeld mit Zeilennummern; seit P22-T266 auch Rueckfall, wenn CodeMirror nicht laedt (Schalter editor_syntax AUS = immer).
 const entwurfSetzen=(text:string)=>setEntwuerfe(v=>({...v,[(freeze??'')+'::'+pfad]:text}));
 const textfeld=<>
       <pre className="ed-zeilen" ref={zeilenRef} aria-hidden="true">{zeilen.s}</pre>
       <textarea aria-label={'Datei '+pfad} spellCheck={false} wrap="off" readOnly={lesend} value={wert}
        onScroll={e=>{if(zeilenRef.current)zeilenRef.current.scrollTop=e.currentTarget.scrollTop;}}
        onChange={e=>entwurfSetzen(e.target.value)}/></>;

 const dateiKnopf=(p:string,tiefe:number,mitOrdner:boolean)=><li key={'d:'+p}>
  <button type="button" className={'ed-baum-datei'+(p===pfad?' aktiv':'')} aria-current={p===pfad?'true':undefined} title={p} style={{'--tiefe':tiefe} as CSSProperties} onClick={()=>oeffnen(p)}>
   <span className="ed-baum-name">{dateiname(p)}</span>{mitOrdner&&ordnerVon(p)&&<small>{ordnerVon(p)}</small>}
   {entwurfVon(p)!==undefined&&<i className="ed-entwurf-punkt" title="Entwurf im Abbild"/>}
  </button></li>;
 const zweig=(k:Knoten,tiefe:number):ReactNode[]=>[
  ...k.ordner.map(o=>{const auf=offen.has(o.pfad);return <li key={'o:'+o.pfad}>
   <button type="button" className="ed-baum-ordner" aria-expanded={auf} title={o.pfad} style={{'--tiefe':tiefe} as CSSProperties} onClick={()=>ordnerUmschalten(o.pfad)}>
    <span className="ed-baum-pfeil" aria-hidden="true">›</span><span className="ed-baum-name">{o.name}</span></button>
   {auf&&<ul>{zweig(o,tiefe+1)}</ul>}</li>;}),
  ...k.dateien.map(p=>dateiKnopf(p,tiefe,false)),
 ];

 return <SyntaxAn.Provider value={syntaxAn}><section className="projekt-editor" data-syntax={syntaxAn?'an':'aus'} data-abbild={freeze??''} data-modus={modus} data-live={live?'an':'aus'} data-reiter={reiter.length} data-strom={strom.aktiv?'an':'aus'} onKeyDown={taste}>
  {/* User 01.11. (34584): keine Überschrift mehr, Baum und Code bekommen den Platz; Schalter und Status bleiben in einer schmalen Werkzeugzeile. */}
  <header className="ed-kopf" aria-label="Editor-Werkzeuge">
   <span className="ed-projekt-chip" title="Projekt im Editor"><span aria-hidden="true">▤</span>{project}</span>
   <div className="ed-werkzeuge">
    <button type="button" className="ed-umschalter" aria-pressed={live} onClick={()=>setLive(v=>!v)} title="Offene files-Pläne der Agenten live mitverfolgen"><span aria-hidden="true">◉</span>Pläne live</button>
    <div className="ed-gruppe" role="group" aria-label="Codebild">
     {!freeze
      ? <button type="button" className="ed-umschalter" disabled={busy} onClick={()=>void einfrieren()}><span aria-hidden="true">◇</span>Codebild einfrieren</button>
      : <button type="button" className="ed-umschalter" data-an={!pauseAbbild?'':undefined} disabled={busy} onClick={freezeUmschalten}><span aria-hidden="true">{pauseAbbild?'◇':'◆'}</span>{pauseAbbild?'Abbild fortsetzen':'Freeze lösen'}</button>}
     {freeze&&<>
      <label className="ed-abbild"><span>Abbild</span><select value={freeze} onChange={e=>abbildWaehlen(e.target.value)}>{abbilder.map((id,i)=><option key={id} value={id}>{'#'+(i+1)+' · '+kurzId(id)}</option>)}</select></label>
      <button type="button" className="ed-knopf" disabled={busy} onClick={()=>void einfrieren()}><span aria-hidden="true">+</span>Neues Abbild</button></>}
    </div>
    <button type="button" className="ed-knopf primaer" disabled={!speicherbar} onClick={()=>void speichern()} title="Strg+S · Änderung als Ops in deinen offenen files-Plan"><span aria-hidden="true">↥</span>Im Plan speichern</button>
   </div>
  </header>
  {info&&<p className="ed-hinweis" role="status"><span>{info}</span><button type="button" aria-label="Hinweis schließen" onClick={()=>setInfo('')}>×</button></p>}
  {fehler&&<p className="ed-hinweis fehler" role="alert"><span>{fehler}</span><button type="button" aria-label="Fehlermeldung schließen" onClick={()=>setFehler('')}>×</button></p>}

  <div className="ed-werkbank">
   <nav className="ed-explorer" aria-label="Projektdateien">
    <div className="ed-leiste"><span>Explorer</span><b>{dateien.length}</b></div>
    <input className="ed-filter" type="search" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Datei suchen …" aria-label="Dateien filtern" spellCheck={false}/>
    <ul className="ed-baum">{treffer?treffer.map(p=>dateiKnopf(p,0,true)):zweig(baum,0)}</ul>
    {treffer&&!treffer.length&&<p className="ed-leer-text">Keine Datei passt.</p>}
    {!dateien.length&&!fehler&&<p className="ed-leer-text laedt">Projektindex lädt</p>}
   </nav>

   <div className="ed-mitte">
    <div className="ed-reiter" role="tablist" aria-label="Geöffnete Dateien">{reiter.map(p=>{const dirty=p===pfad?geaendert:entwurfVon(p)!==undefined;
     return <div key={p} className={'ed-reiter-eintrag'+(p===pfad?' aktiv':'')+(dirty?' geaendert':'')}>
      <button type="button" role="tab" aria-selected={p===pfad} title={p} onClick={()=>setPfad(p)} onAuxClick={e=>{if(e.button===1)schliessen(p);}}>{dateiname(p)}</button>
      <button type="button" className="ed-reiter-zu" aria-label={'Reiter '+dateiname(p)+' schließen'} onClick={()=>schliessen(p)}><span aria-hidden="true">×</span></button></div>;})}</div>
    {pfad&&<div className="ed-pfadzeile">
     <span className="ed-brotkrumen">{pfad.split('/').map((t,i,a)=><span key={i} className={i===a.length-1?'ende':undefined}>{t}</span>)}</span>
     <span className={'ed-modus '+(aktiv&&!lesend?'bearbeitbar':'lesend')}>{sperrgrund}</span></div>}
    {aktiv
     ? <div key={(freeze??'')+'::'+pfad} className={'ed-code'+(syntaxAn?' mit-syntax':'')} data-bearbeitbar={!lesend?'':undefined}>
       {syntaxAn
        ? <CodeFeld pfad={pfad} wert={wert} lesend={lesend} label={'Datei '+pfad} onChange={entwurfSetzen} rueckfall={textfeld}/>
        : textfeld}
      </div>
     : <div className="ed-leer">{pfad
       ? <p className="laedt">{dateiname(pfad)} lädt</p>
       : <><strong>Keine Datei offen</strong><p>Links im Explorer eine Datei wählen. Im Freeze ändern und mit <kbd>Strg</kbd>+<kbd>S</kbd> in deinem files-Plan speichern.</p></>}</div>}
    {vergleich&&<section className={'ed-vergleich'+(vergleich.konflikt?' konflikt':'')} aria-label="Drei-Wege-Vergleich">
     <header><span className="ed-auge">Drei-Wege-Vergleich</span><strong>{vergleich.konflikt?'Konflikt mit aktuellem Stand':'Abbildbasis stimmt mit aktuellem Stand überein'}</strong>
      <button type="button" className="ed-mini" onClick={()=>setVergleich(null)}>Schließen</button></header>
     <div className="ed-vergleich-raster">
      <DreiWegeSpalte titel="Abbildbasis" text={vergleich.basis} bezug={bezug?.entwurf??null} art="basis" pfad={vergleich.file_path||pfad}/>
      <DreiWegeSpalte titel="User-Entwurf" text={vergleich.entwurf} bezug={bezug?.basis??null} art="entwurf" pfad={vergleich.file_path||pfad}/>
      <DreiWegeSpalte titel="Aktueller Stand" text={vergleich.aktuell} bezug={bezug?.basis??null} art="aktuell" pfad={vergleich.file_path||pfad}/>
     </div></section>}
    {strom.aktiv&&<PlanStromDetail strom={strom}/>}
   </div>

   <aside className="ed-inspektor" aria-label="Pläne und Prüfungen">
    <div className="ed-seiten" role="tablist" aria-label="Inspektor">
     <button type="button" role="tab" aria-selected={seite==='live'} onClick={()=>setSeite('live')}>Live-Pläne{live&&<b>{strom.aktiv?strom.anzahlEntstehend:plaene.length}</b>}</button>
     <button type="button" role="tab" aria-selected={seite==='userplan'} onClick={()=>setSeite('userplan')}>Mein Plan<b>{userPlan?userPlan.dateien.length:0}</b></button>
    </div>
    {seite==='live'&&strom.aktiv
     ? <PlanStromListe strom={strom} pfad={pfad}/>
     : seite==='live'
     ? <div className="ed-seite" role="tabpanel">
      {!live ? <p className="ed-leer-text">Live-Ansicht aus. Oben „Pläne live“ einschalten, um offenen files-Plänen der Agenten beim Entstehen zuzusehen.</p>
       : !pfad ? <p className="ed-leer-text">Eine Datei öffnen, um ihre offenen Pläne zu sehen.</p>
       : <>
        <section className="ed-abschnitt"><h3><i className="ed-live-punkt" aria-hidden="true"/>Offen · diese Datei</h3>
         {plaene.map(p=><button key={p.id} type="button" className="ed-plan offen" onClick={()=>void planZeigen(p.id)} aria-pressed={auswahl===p.id}>
          <span className="ed-plan-wer">{p.owner_agent_id||'unbekannt'}</span><span className="ed-chip">{p.status}</span><span className="ed-plan-id">Plan {p.id}</span></button>)}
         {!plaene.length&&<p className="ed-leer-text">Keine offenen Pläne für diese Datei.</p>}</section>
        {nachklang.length>0&&<section className="ed-abschnitt"><h3>Nachleuchten</h3>
         {nachklang.map(p=><div key={'ende:'+p.id} className="ed-plan nachklang"><span className="ed-plan-wer">{p.owner_agent_id||'unbekannt'}</span><span className="ed-chip">abgeschlossen</span><span className="ed-plan-id">Plan {p.id}</span></div>)}</section>}
        {auswahl&&<section className="ed-abschnitt"><h3>Schatten · Plan {auswahl}
          <button type="button" className="ed-mini" onClick={()=>setPins(v=>({...v,[auswahl]:{text:schatten,pfad}}))}>{pins[auswahl]!==undefined?'Pin aktualisieren':'Schatten anpinnen'}</button></h3>
         <pre className="ed-schatten schreibt">{schatten?<HervorgehobenerText pfad={pfad} text={schatten}/>:'Kein Schatteninhalt'}</pre></section>}
       </>}
      {Object.keys(pins).length>0&&<section className="ed-abschnitt"><h3>Angepinnt</h3>
       {Object.entries(pins).map(([id,pin])=><div key={'pin:'+id} className="ed-pin"><header><strong>Plan {id}</strong>
        <button type="button" className="ed-mini" onClick={()=>setPins(v=>{const n={...v};delete n[id];return n;})}>Pin lösen</button></header>
        <pre className="ed-schatten">{pin.text?<HervorgehobenerText pfad={pin.pfad} text={pin.text}/>:'Kein Schatteninhalt'}</pre></div>)}</section>}
     </div>
     : <div className="ed-seite" role="tabpanel" data-userplan={userPlan?.plan_id??''}>
      {!userPlan
       ? <p className="ed-leer-text">Noch kein offener Plan. Im Freeze eine Datei ändern und mit Strg+S speichern; jede weitere Datei kommt in denselben files-Plan. Committete Pläne zeigt der Plan-Strom bzw. sein Verlauf.</p>
       : <>
        <section className="ed-abschnitt"><h3>Dein files-Plan<span className="ed-chip">{userPlan.status}</span></h3>
         <p className="ed-userplan-info">Plan {userPlan.plan_id} · {userPlan.dateien.length} {userPlan.dateien.length===1?'Datei':'Dateien'} · {userPlan.dateien.reduce((n,f)=>n+f.ops.length,0)} Ops · Co-Edit an</p></section>
        {userPlan.dateien.map(f=><section key={f.file_path} className="ed-userplan-datei" data-konflikt={f.konflikt?'':undefined}>
         <button type="button" className="ed-userplan-pfad" onClick={()=>void userPlanDatei(f.file_path)} title="Drei-Wege-Vergleich öffnen">
          <span className="ed-plan-wer">{dateiname(f.file_path)}</span><span className="ed-chip">{f.konflikt?'Konflikt':f.ops.length+(f.ops.length===1?' Op':' Ops')}</span><small>{f.file_path}</small></button>
         <ol className="ed-userplan-ops">{f.ops.map(o=><li key={o.index} data-fehler={o.ok?undefined:''} data-agent={o.agent_id&&o.agent_id!=='user'?'':undefined} title={o.error||undefined}>
          <span className="ed-userplan-nr">#{o.index}</span><span>{o.action}</span><span className="ed-userplan-wer">{o.agent_id&&o.agent_id!=='user'?'korrigiert · '+o.agent_id:'du'}</span>{!o.ok&&<b>{o.error||'fehlerhaft'}</b>}</li>)}</ol>
        </section>)}
        <section className="ed-abschnitt ed-pruefauftrag"><h3>Prüfen lassen</h3>
         <textarea className="ed-pruef-text" value={pruefText} onChange={e=>setPruefText(e.target.value)} rows={3} maxLength={2000} aria-label="Hinweis zum Prüfauftrag"
          placeholder="Optional: Hinweis an den Koordinator, z. B. was geprüft oder korrigiert werden soll"/>
         <button type="button" className="ed-knopf primaer breit" disabled={busy} onClick={()=>void pruefenLassen()}><span aria-hidden="true">✓</span>Prüfen lassen</button>
         <p className="ed-leer-text">Der Koordinator gibt den Plan einem Agenten. Der prüft, korrigiert notfalls im Co-Edit und committet, oder fragt dich über die Inbox.</p></section>
       </>}
      <button type="button" className="ed-knopf breit" onClick={()=>void userPlanLaden().catch(e=>setFehler(String(e)))}><span aria-hidden="true">↻</span>Aktualisieren</button>
     </div>}
   </aside>

   <footer className="ed-status">
    <span className={'ed-status-modus '+modus}>{modus==='freeze'?'Freeze · Abbild '+kurzId(freeze??''):modus==='geloest'?'Freeze gelöst · Index':'Live-Index'}</span>
    <span>{live?'Pläne live · '+(strom.aktiv?strom.anzahlEntstehend:plaene.length)+' offen':'Pläne live aus'}</span>
    {busy&&<span className="laedt">Arbeitet</span>}
    <span className="ed-status-rest">{aktiv&&<>{geaendert&&<b>Entwurf geändert</b>}<span>{zeilen.n} Zeilen</span><span>{lesend?'Nur lesen':'Bearbeitbar'}</span></>}<span>Strg+S speichern</span></span>
   </footer>
  </div>
 </section></SyntaxAn.Provider>;
}
