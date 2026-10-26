import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MeineInbox } from '../src/components/MeineInbox';
import '../src/control-plane.css';
import '../src/workspace-mock.css';
import '../src/ui-scale.css';
function App() {
  const [project,setProject]=useState('Alfa');
  return <div className="synapse-control" data-theme="dark" style={{'--accent':'#66d9c0'} as React.CSSProperties}>
    <aside className="control-sidebar"><div className="brand"><span>S</span><div><strong>Synapse</strong><small>Inbox-Abnahme P22-T192</small></div></div>
      <nav><p>Aktives Projekt: {project}</p><button id="projektwechsel" onClick={()=>setProject(project==='Alfa'?'Beta':'Alfa')}>Projekt wechseln</button></nav>
      <footer><MeineInbox /></footer></aside>
    <main className="control-main"><h1>Projekt {project}</h1><p>Meine Inbox sammelt Nachrichten aus allen Projekten.</p></main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
