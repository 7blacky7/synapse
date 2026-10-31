/** P22-T202: echte Laufwahl und bestehender Chat gegen die private Browser-Test-API. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ApiAgentLaufwahl} from '../src/components/ApiAgentLaufwahl';
import {EinheitlicherAgentChat} from '../src/components/EinheitlicherAgentChat';
import {HauptagentModellChip} from '../src/components/HauptagentModellChip';
import {ApiBudgetPanel} from '../src/components/ApiBudgetPanel';
import {AUSWEIS_OEFFNEN_EVENT} from '../src/ausweis-deeplink';
import '../src/workspace-mock.css';
import '../src/control-plane-settings.css';
import '../src/hauptagent-verlauf.css';
const q=new URLSearchParams(location.search),project=q.get('project')!,worker=q.get('worker')!,koord=q.get('koord')!;
(window as unknown as {__fehler:string[]}).__fehler=[];
window.addEventListener('error',e=>(window as unknown as {__fehler:string[]}).__fehler.push(e.message));
function Probe(){
 const [settings,setSettings]=useState(false);
 window.addEventListener(AUSWEIS_OEFFNEN_EVENT,()=>setSettings(true),{once:true});
 return <main className="standard-page" style={{display:'block',padding:20}}>
   <h1>Agententeam · API-Laufwahl · T202</h1>
   <section data-test-agent="main"><h2>Hauptagent</h2><HauptagentModellChip/></section>
   <section data-test-agent="worker"><h2>Arbeitsagent</h2><ApiAgentLaufwahl identityId={worker} project={project} name="Arbeitsagent"/></section>
   <section data-test-agent="koord"><h2>Koordinator</h2><ApiAgentLaufwahl identityId={koord} project={project} name="Koordinator"/></section>
   <section data-test-chat><h2>Bestehendes Agenten-Chatfenster</h2><EinheitlicherAgentChat identityId={worker} project={project} name="Arbeitsagent"/></section>
   {settings&&<section data-test-settings><h2>Einstellungen &gt; API-Agenten</h2><ApiBudgetPanel/></section>}
 </main>;
}
const root=document.getElementById('root')!;root.className='synapse-control';root.dataset.theme='dark';root.style.display='block';
createRoot(root).render(<Probe/>);
