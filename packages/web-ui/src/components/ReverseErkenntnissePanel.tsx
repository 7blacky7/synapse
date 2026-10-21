import {useEffect,useState} from 'react';
import {apiFetch} from '../api/auth';
type Row=Record<string,any>;
export function ReverseErkenntnissePanel({project}:{project:string}){
 return <ReverseErkenntnisseInhalt key={project} project={project}/>;
}
function ReverseErkenntnisseInhalt({project}:{project:string}){
 const [eintraege,setEintraege]=useState<Row[]>([]),[rid,setRid]=useState(''),[liste,setListe]=useState<Row[]>([]),[nach,setNach]=useState<string|null>(null);
 const [bindungenNach,setBindungenNach]=useState<number|null>(null);
 const [query,setQuery]=useState(''),[detail,setDetail]=useState<Row|null>(null),[historie,setHistorie]=useState<Row[]>([]);
 const [historieNach,setHistorieNach]=useState<number|null>(null),[entwurf,setEntwurf]=useState<Row|null>(null),[anfrage,setAnfrage]=useState('');
 const [busy,setBusy]=useState(false),[fehler,setFehler]=useState(''),[meldung,setMeldung]=useState('');
 async function call(args:Row){
  const r=await apiFetch('/api/projects/'+encodeURIComponent(project)+'/reverse-erkenntnisse',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  const d=await r.json();
  if(!r.ok||d.success===false)throw Error(d.erkenntnis_fehler==='erkenntnis_versionskonflikt'?'Inzwischen gibt es eine neuere Version. Entwurf behalten und aktuellen Stand neu laden.':d.erkenntnis_fehler==='erkenntnisse_deaktiviert'?'Erkenntnisse sind für dieses Projekt ausgeschaltet.':d.erkenntnis_fehler??d.message??(typeof d.error==='string'?d.error:d.error?.code)??'Anfrage fehlgeschlagen');
  return d;
 }
 async function lauf(fn:()=>Promise<void>){setBusy(true);setFehler('');setMeldung('');try{await fn();}catch(e){setFehler(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 async function laden(after?:string){const d=await call({action:'erkenntnis_liste',reverse_id:rid,...(query.trim()?{query}:{}),...(after?{liste_nach:after}:{})});setListe(old=>after?[...old,...d.erkenntnisse]:d.erkenntnisse);setNach(d.liste_nach);}
 async function oeffnen(row:Row){
  const d=await call({action:'erkenntnis_get',reverse_id:rid,verweis_id:row.verweis_id,version:row.version});
  setDetail({...d.erkenntnis,neueste_version:d.neueste_version,neuester_status:d.neuester_status,quellstaende:d.quellstaende});
  const h=await call({action:'erkenntnis_get',reverse_id:rid,verweis_id:row.verweis_id,historie:true});setHistorie(h.versionen);setHistorieNach(h.naechster_offset);
 }
 useEffect(()=>{let aktiv=true;setRid('');setListe([]);setDetail(null);setEntwurf(null);
  void call({action:'bindungen'}).then(d=>{if(aktiv){setEintraege(d.bindungen);setBindungenNach(d.naechster_offset??null);setRid(d.bindungen[0]?.reverse_id??'');}}).catch(e=>{if(aktiv)setFehler(String(e.message));});
  return()=>{aktiv=false;};
 // Project scopes all requests.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[project]);
 useEffect(()=>{setDetail(null);setEntwurf(null);setHistorie([]);if(rid)void lauf(()=>laden());else setListe([]);
 // A changed entry starts a fresh page.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[rid]);
 function neu(){
  setEntwurf({titel:'',kategorie:'notiz',inhalt:{text:'',status:'aktiv',aussagen:[{schluessel:'aussage-1',text:'',konfidenz:'vermutet',begruendung:'Noch nicht unabhängig belegt.',belege:[]}],belege:[],ziele:[]}});
  setAnfrage(crypto.randomUUID());
 }
 function bearbeiten(){if(!detail)return;const x=structuredClone(detail);delete x.inhalt.review;setEntwurf(x);setAnfrage(crypto.randomUUID());}
 async function speichern(){
  if(!entwurf)return;
  const d=await call({action:'erkenntnis_speichern',reverse_id:rid,titel:entwurf.titel,kategorie:entwurf.kategorie,inhalt:entwurf.inhalt,idempotency_key:anfrage,basis_version:entwurf.version??0,...(entwurf.verweis_id?{verweis_id:entwurf.verweis_id}:{})});
  setEntwurf(null);await laden();await oeffnen(d.erkenntnis);setMeldung('Version '+d.erkenntnis.version+' gespeichert.');
 }
 return <section className="cp-fields" aria-label="Erkenntnisse der Reverse-Bibliothek">
  <div className="scope-warning wide"><b>Erkenntnisse am Eintrag</b><span>Aussagen, Quellen und frühere Versionen für die an diesen Eintrag gebundenen Projekte.</span></div>
  <label className="cp-setting-field wide"><span>Gebundener Eintrag</span><select value={rid} disabled={busy} onChange={e=>setRid(e.target.value)}>
   {!eintraege.length&&<option value="">Noch kein Eintrag gebunden</option>}{eintraege.map(e=><option key={e.reverse_id} value={e.reverse_id}>{e.reverse_id}</option>)}</select></label>
  {bindungenNach!==null&&<button disabled={busy} onClick={()=>void lauf(async()=>{const d=await call({action:'bindungen',offset:bindungenNach});setEintraege(old=>[...old,...d.bindungen.filter((e:Row)=>!old.some(x=>x.reverse_id===e.reverse_id))]);setBindungenNach(d.naechster_offset??null);})}>Weitere gebundene Einträge</button>}
  {rid&&<><div className="wide"><input aria-label="Erkenntnisse suchen" value={query} onChange={e=>setQuery(e.target.value)}/>
   <button disabled={busy} onClick={()=>void lauf(()=>laden())}>Suchen</button> <button disabled={busy} onClick={neu}>Neue Erkenntnis</button></div>
   <ul className="wide">{liste.map(e=><li key={e.verweis_id}><button disabled={busy} onClick={()=>void lauf(()=>oeffnen(e))}>{e.titel} · Version {e.version}</button> <span>{e.kategorie} · {e.status}</span></li>)}</ul>
   {nach&&<button disabled={busy} onClick={()=>void lauf(()=>laden(nach))}>Weitere Erkenntnisse</button>}
  </>}
  {detail&&<article className="wide">
   <h3>{detail.titel} · Version {detail.version}</h3>
   <p>{detail.inhalt.status} · Autor {detail.autor}</p>
   {detail.neueste_version!==detail.version&&<p>Neuere Version: {detail.neueste_version} ({detail.neuester_status})</p>}
   <p style={{whiteSpace:'pre-wrap'}}>{detail.inhalt.text}</p>
   {detail.inhalt.grund&&<p>Grund: {detail.inhalt.grund}</p>}
   <ul>{detail.inhalt.aussagen.map((a:Row)=><li key={a.schluessel}><b>{a.konfidenz==='belegt'?'Belegt (Autorenangabe)':'Vermutet'}: {a.text}</b><p>{a.begruendung}</p><small>Belege: {a.belege.join(', ')||'keine'}</small></li>)}</ul>
   <p>Review: {detail.inhalt.review?detail.inhalt.review.status+' · '+detail.inhalt.review.autor+' · '+detail.inhalt.review.grund:'Nicht geprüft'}</p>
   <details><summary>Quellen und Ziele</summary>{detail.inhalt.belege.map((b:Row)=><p key={b.id}><b>{b.id}: {b.pfad}</b><br/>SHA-256: <code>{b.sha256}</code><br/>{b.art==='bytes'?'Bytes '+b.offset+' bis '+(BigInt(b.offset)+BigInt(b.laenge)-1n):b.art==='funktion'?b.funktion+' · '+b.adressraum+' '+b.adresse:b.ableitung_pfad+' · Zeilen '+b.from_line+'–'+b.to_line}<br/>{b.ableitung_sha256&&<code>{b.ableitung_sha256}</code>}<br/>{quellstatus(detail.quellstaende?.find((s:Row)=>s.beleg_id===b.id)?.status)}</p>)}
    {detail.inhalt.ziele.map((z:Row,i:number)=><p key={i}>{z.art}: {z.pfad??z.format_id??z.verweis_id}{z.version?' · Version '+z.version:''}</p>)}
    <p>Quellen beziehen sich auf den gespeicherten Stand. Eine Neuanalyse ändert diese Anker nicht.</p></details>
   <button onClick={()=>void lauf(async()=>{await navigator.clipboard.writeText(detail.ref);setMeldung('Referenz kopiert.');})}>Referenz kopieren</button>{' '}
   <button disabled={busy||detail.version!==detail.neueste_version} onClick={bearbeiten}>Neue Version verfassen</button>
   <details><summary>Versionen</summary>{historie.map(h=><button key={h.version} disabled={busy} onClick={()=>void lauf(()=>oeffnen(h))}>v{h.version} · {h.status}</button>)}
    {historieNach!==null&&<button disabled={busy} onClick={()=>void lauf(async()=>{const h=await call({action:'erkenntnis_get',reverse_id:rid,verweis_id:detail.verweis_id,historie:true,offset:historieNach});setHistorie(old=>[...old,...h.versionen]);setHistorieNach(h.naechster_offset);})}>Weitere Versionen</button>}</details>
  </article>}
  {entwurf&&<form className="wide cp-fields" onSubmit={e=>{e.preventDefault();void lauf(speichern);}}>
   <label className="wide">Titel<input required value={entwurf.titel} onChange={e=>setEntwurf({...entwurf,titel:e.target.value})}/></label>
   <label>Kategorie<input required value={entwurf.kategorie} onChange={e=>setEntwurf({...entwurf,kategorie:e.target.value})}/></label>
   <label className="wide">Erklärung<textarea required rows={5} value={entwurf.inhalt.text} onChange={e=>setEntwurf({...entwurf,inhalt:{...entwurf.inhalt,text:e.target.value}})}/></label>
   {entwurf.inhalt.aussagen.map((a:Row,i:number)=><label className="wide" key={a.schluessel}>Aussage ({a.konfidenz})<textarea required value={a.text} onChange={e=>{const aussagen=[...entwurf.inhalt.aussagen];aussagen[i]={...a,text:e.target.value,konfidenz:'vermutet',begruendung:'Aussage überarbeitet; erneute Prüfung erforderlich.'};setEntwurf({...entwurf,inhalt:{...entwurf.inhalt,aussagen}});}}/></label>)}
   <label>Status<select value={entwurf.inhalt.status} onChange={e=>setEntwurf({...entwurf,inhalt:{...entwurf.inhalt,status:e.target.value}})}>
    <option value="aktiv">Aktiv</option><option value="korrigiert">Korrigiert</option><option value="widersprochen">Widersprochen</option><option value="zurueckgezogen">Zurückgezogen</option></select></label>
   {entwurf.inhalt.status!=='aktiv'&&<label className="wide">Grund<input required value={entwurf.inhalt.grund??''} onChange={e=>setEntwurf({...entwurf,inhalt:{...entwurf.inhalt,grund:e.target.value}})}/></label>}
   <div className="wide"><button type="submit" disabled={busy}>Version speichern</button> <button type="button" disabled={busy} onClick={()=>setEntwurf(null)}>Entwurf schließen</button></div>
  </form>}
  {fehler&&<p className="wide" role="alert">{fehler}</p>}{meldung&&<p className="wide" role="status">{meldung}</p>}
 </section>;
}

function quellstatus(status?:string):string{
 const labels:Record<string,string>={original_unveraendert:'Original unverändert',ableitung_unveraendert:'Original und Ableitung unverändert',quellstand_abweichend:'Original inzwischen geändert – historischer Beleg',quelle_nicht_mehr_verfuegbar:'Original nicht mehr verfügbar – historischer Beleg',ableitung_abweichend:'Ableitung inzwischen geändert – historischer Beleg',ableitung_nicht_mehr_verfuegbar:'Ableitung nicht mehr verfügbar – historischer Beleg'};
 return status?labels[status]??status:'Quellstand nicht geprüft';
}
