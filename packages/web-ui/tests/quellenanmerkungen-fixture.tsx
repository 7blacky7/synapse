/** P22-T195: echtes Lesefenster und Sammelkorb gegen private Test-API; kein Inhaltsmock. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VerweisFensterProvider,VerweisText} from '../src/components/Lesefenster';
import {AnmerkungSammelkorb} from '../src/components/QuellenAnmerkungen';
import '../src/control-plane.css';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/components/project-coordinator-dock.css';
const q=new URLSearchParams(location.search),project=q.get('project')!;
function App(){
 const [seite,setSeite]=useState(false);
 return <div className="synapse-control" data-theme="dark" style={{padding:24,minHeight:'100vh',display:'block',color:'var(--text)'}}>
 <VerweisFensterProvider>
 <h1>Quellenanmerkungen · Testphase T195</h1>
 <button id="seitenwechsel" onClick={()=>setSeite(!seite)}>Seite wechseln</button>
 <p>{seite?'Andere Seite':'Quellenübersicht'}</p>
 {!seite&&<nav><p id="quelle-task"><VerweisText project={project} text="P1-T1"/></p>
 <p id="quelle-thought"><VerweisText project={project} text={'thought '+q.get('thought')}/></p>
 <p id="quelle-plan"><VerweisText project={project} text="Plan P1"/></p></nav>}
 <AnmerkungSammelkorb project={project}/>
 </VerweisFensterProvider></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
