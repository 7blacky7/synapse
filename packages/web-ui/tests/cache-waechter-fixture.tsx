/** P22-T194 Testfixture: echte Cacheanzeige und dauerhafter Chatentwurf, keine Produkt-Datenattrappen. */
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {CacheWaechterStatus} from '../src/components/CacheWaechterStatus';
import '../src/control-plane.css';
function App(){
 const q=new URLSearchParams(location.search),[id,setId]=useState(q.get('id')!),[text,setText]=useState('');
 return <div className="synapse-control" data-theme="dark" style={{color:"#e8e8e8",background:"#151719",minHeight:"100vh",padding:24,"--border":"#4b5055"} as React.CSSProperties}><main className="control-main">
 <h1>Agentenchat · Cache-Telemetrie</h1><button id="andere" onClick={()=>setId(q.get('andere')!)}>Andere Identität</button>
 <CacheWaechterStatus identityId={id} pollMs={250}/>
 <label>Nachricht an Agent<textarea value={text} onChange={e=>setText(e.target.value)} style={{display:'block',width:'90%',minHeight:120}}/></label>
 </main></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
