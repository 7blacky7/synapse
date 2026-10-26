import {createRoot} from 'react-dom/client';
import {ArtefaktDateienPanel} from '../src/components/ArtefaktDateienPanel';
import '../src/control-plane.css';
import '../src/workspace-mock.css';
import '../src/ui-scale.css';
import '../src/control-plane-settings.css';
// P22-T191: echtes Panel, nur isoliertes Testprojekt aus dem Browserlauf.
createRoot(document.getElementById('root')!).render(<div className="synapse-control" data-theme="dark" style={{display:"block",padding:24}}><main style={{maxWidth:1100,margin:"0 auto"}}><h1>Artefakte & Antworten — P22-T191</h1><ArtefaktDateienPanel project="p22-t191-browser"/></main></div>);
