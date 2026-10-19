/**
 * P22-T27 (W12-D): Ausweis-Schema (project nicht Pflicht bei Schalter EIN, unveraendert bei AUS)
 * und verbindliche Texte aus dem Vertrag agent-profil-vertrag.ts (27acb98b).
 * Aufruf aus dem Repo-Root: node packages/core/tests/w1b-texte-p22-t27.test.mjs (nutzt dist/).
 * Keine Datenbank: reine Schema- und Textpruefung.
 */
import assert from 'node:assert/strict';

process.env.SYNAPSE_INTERN_TOOL = '0';

const T = await import('../dist/services/agent-token-tools.js');
const V = await import('../dist/services/agent-profil-vertrag.js');
const A = await import('../dist/services/agent-anmeldung.js');
const G = await import('../dist/guide/content.js');

const frisch = () => [
  { name: 'chat', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['register', 'anmelden'] }, project: { type: 'string', description: 'Projekt-Name' }, id: { type: 'string' } }, required: ['action', 'project'] } },
  { name: 'thought', inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Projekt-Name' }, content: { type: 'string' } }, required: ['project', 'content'] } },
];

let ok = 0;
const pruefe = (name, fn) => { fn(); ok++; console.log('ok', name); };

const setzeSchalter = (ein) => {
  // P22-T28: der Ausweis-Kern ist nur bei agent_bezug_modus 'beide' wirksam; kein Puffer (TTL 0).
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';
  if (ein) { process.env.SYNAPSE_TOKEN_IDENTITAET = '1'; process.env.SYNAPSE_W1B_ANMELDUNG = '1'; process.env.SYNAPSE_AGENT_BEZUG_MODUS = 'beide'; }
  else { process.env.SYNAPSE_TOKEN_IDENTITAET = '0'; delete process.env.SYNAPSE_W1B_ANMELDUNG; process.env.SYNAPSE_AGENT_BEZUG_MODUS = 'alt'; }
};

// --- Schema: Ausweis-Schalter AUS -> project bleibt Pflicht, token fehlt in der Werbung (auch bei tools/list MIT Ausweis) ---
setzeSchalter(false);
const aus = await T.beworbeneAgentTools(frisch());
pruefe('AUS: project bleibt Pflicht', () => {
  assert.deepEqual(aus[1].inputSchema.required, ['project', 'content']);
  assert.equal(aus[1].inputSchema.properties.project.description, 'Projekt-Name');
});
pruefe('AUS: token nicht beworben', () => {
  assert.equal(aus[1].inputSchema.properties.token, undefined);
});

const mitAusweisAus = await T.beworbeneAgentTools(frisch(), { mitAusweis: true });
pruefe('AUS: auch tools/list MIT Ausweis aendert nichts (wie t110)', () => {
  assert.deepEqual(mitAusweisAus[1].inputSchema.required, ['project', 'content']);
  assert.equal(mitAusweisAus[1].inputSchema.properties.token, undefined);
});

// --- Schema: Kern EIN, tools/list OHNE Ausweis -> Schema unveraendert (project Pflicht, token beworben) ---
setzeSchalter(true);
const einOhne = await T.beworbeneAgentTools(frisch());
pruefe('EIN ohne Ausweis in tools/list: project bleibt Pflicht (User-Vorgabe: ohne aktive Nutzung keine Pflichteingaben entfernen)', () => {
  assert.deepEqual(einOhne[1].inputSchema.required, ['project', 'content']);
  assert.deepEqual(einOhne[0].inputSchema.required, ['action', 'project']);
  assert.equal(einOhne[1].inputSchema.properties.project.description, 'Projekt-Name');
});

// --- Schema: Kern EIN UND tools/list MIT Ausweis -> project nicht Pflicht, Fachparameter bleiben ---
const ein = await T.beworbeneAgentTools(frisch(), { mitAusweis: true });
pruefe('EIN mit Ausweis in tools/list: project nicht mehr Pflicht', () => {
  assert.deepEqual(ein[1].inputSchema.required, ['content']);
  assert.deepEqual(ein[0].inputSchema.required, ['action']);
});
pruefe('EIN mit Ausweis: Parameterbeschreibung nennt Ausweis', () => {
  assert.equal(ein[1].inputSchema.properties.project.description, 'Projekt-Name (mit token/Ausweis optional)');
});
pruefe('EIN: Fachparameter unveraendert', () => {
  assert.ok(ein[1].inputSchema.properties.content);
  assert.deepEqual(ein[1].inputSchema.properties.content, { type: 'string' });
});
pruefe('EIN: Eingabe-Original wird nicht veraendert', () => {
  const original = frisch();
  return T.beworbeneAgentTools(original, { mitAusweis: true }).then(() => {
    assert.deepEqual(original[1].inputSchema.required, ['project', 'content']);
  });
});

// --- Texte aus dem Vertrag ---
pruefe('TEXT_AGENT_TOKEN_FEHLT nennt chat(anmelden, token) und admin token_abrufen', () => {
  assert.match(V.TEXT_AGENT_TOKEN_FEHLT, /chat\(action:"anmelden", token:<Ausweis>\)/);
  assert.match(V.TEXT_AGENT_TOKEN_FEHLT, /admin\(action:"token_abrufen", project, ziel_identity_id, anlass\)/);
});
pruefe('TEXT_NEUINSTANZ: anmelden statt register', () => {
  assert.match(V.TEXT_NEUINSTANZ, /chat\(action:"anmelden", token:<Ausweis>\)/);
  assert.match(V.TEXT_NEUINSTANZ, /nie chat\(register\)/);
});
pruefe('schattenBestaetigenAufruf: konkreter Aufruf mit Revision', () => {
  const t = V.schattenBestaetigenAufruf('synapse', 'sp-1', 3);
  assert.match(t, /^admin\(action:"schattenprofil_bestaetigen", project:"synapse", schattenprofil_id:"sp-1", erwartete_revision:3,/);
});
pruefe('TEXT_AGENT_VORBEREITEN_AUFRUF nennt agent_vorbereiten', () => {
  assert.match(V.TEXT_AGENT_VORBEREITEN_AUFRUF, /^admin\(action:"agent_vorbereiten"/);
});
pruefe('Koordinator-Hinweis nennt konkreten Aufruf statt Web-UI-Platzhalter', () => {
  assert.match(A.SCHATTEN_ABRUF_TEXT, /schattenprofil_bestaetigen/);
  assert.doesNotMatch(A.SCHATTEN_ABRUF_TEXT, /Web-UI/);
});
pruefe('Guide chat: Neuinstanz nur ueber anmelden', () => {
  assert.match(G.TOOL_GUIDES.chat.when_to_use, /chat\(action:"anmelden", token\), nie register/);
});

setzeSchalter(false);
console.log(`\nP22-T27 Texte/Schema: ${ok} Pruefungen gruen`);
