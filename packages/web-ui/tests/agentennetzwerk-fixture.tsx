/** Browserabnahme: echte API des privaten synapse_test-Schemas; keine Mock-Daten. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import MainAgentDashboard from '../src/components/MainAgentDashboard';
import {netzwerkSzene} from '../src/components/Agentennetzwerk';
import '../src/main-agent-dashboard.css';
Object.assign(window,{p22szene:netzwerkSzene});
createRoot(document.getElementById('root')!).render(<MainAgentDashboard project="p22-t93-browser" toolCalls={[]} agentBusy={false} savedArtifacts={0} artifacts={[]}/>);
