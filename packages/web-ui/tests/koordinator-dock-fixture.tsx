/**
 * P22-T189/T187: echte ProjectCoordinatorDock-/PlattformAgentChat-Komponenten mit isolierter API-Attrappe.
 * Keine DB, kein Daemon, keine Produktionsanfragen. Nur der KI-Browser-Laeufer veraendert __dockTest.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectCoordinatorDock } from '../src/components/ProjectCoordinatorDock';
import '../src/workspace-mock.css';
import '../src/workspace-extensions.css';
import '../src/components/main-agent-assistant-dock.css';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const probe = {
  mehrfenster: false, chat: { [A]: true, [B]: true } as Record<string, boolean>,
  fehler: false, requests: [] as string[], posts: [] as Array<{ identity_id: string; text: string }>,
};
(window as unknown as { __dockTest: typeof probe }).__dockTest = probe;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) throw new Error('Unerwartete Fixture-Anfrage: ' + url.pathname);
  probe.requests.push(url.pathname + url.search);
  const id = url.searchParams.get('identity_id') ?? A;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/koordinatoren/online') return json({ koordinatoren: [
    { identity_id: A, name: 'koordinator-a', project: 'p22-t189-a', letzte_aktivitaet: new Date().toISOString(), herkunft: {} },
    { identity_id: B, name: 'koordinator-b', project: 'p22-t189-b', letzte_aktivitaet: new Date().toISOString(), herkunft: {} },
  ] });
  if (url.pathname.endsWith('/agent-chat/status')) {
    if (probe.fehler) return json({ success: false, error: { message: 'Test: Status nicht erreichbar' } }, 503);
    return json({ success: true, schalter: { aktiv: probe.chat[id], quelle: 'produkt-schalter', name: 'plattform_agent_chat',
      wert: probe.chat[id] ? 'ein' : 'aus', project: id === A ? 'p22-t189-a' : 'p22-t189-b', letzter_fehler: null,
      mehrfenster: { aktiv: probe.mehrfenster, quelle: 'produkt-schalter', name: 'koordinator_mehrfenster', letzter_fehler: null } },
      einheitlich: { aktiv: true } });
  }
  if (url.pathname.endsWith('/agent-verlauf')) return json({ verfuegbar: true, eintraege: [], mehr: false, max_rev: '0', tool_karten: { aktiv: false } });
  if (url.pathname.endsWith('/agent-chat/inbox')) return json({ aktiv: true, nachrichten: [], mehr: false });
  if (url.pathname.endsWith('/agent-chat') && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)); probe.posts.push(body);
    return json({ inbox_id: probe.posts.length, agent_id: body.identity_id === A ? 'koordinator-a' : 'koordinator-b', project: 'p22-t189' });
  }
  if (url.pathname.endsWith('/agent-heartbeat')) return json({ identity_id: id, project: 'p22-t189', agent_id: 'fixture',
    rolle: 'koordinator', weg: 'koordinator_heartbeat', verstellbar: false,
    schalter: { aktiv: false, name: 'koordinator_heartbeat', quelle: 'standard', letzter_fehler: null },
    gewuenscht: null, tatsaechlich: { lauf: false }, hinweis: 'Fixture: Heartbeat AUS' });
  return json({ success: true, aktiv: false, agenten: [], tasks: [], eintraege: [], nachrichten: [], herkunft: [], mehr: false });
};
createRoot(document.getElementById('root')!).render(
  <div className="synapse-control workspace-mock theme-dark"><p>P22-T189 / T187 · isolierte Dock-Abnahme</p><ProjectCoordinatorDock /></div>
);
