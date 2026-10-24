/**
 * P22-T131: Ausweis-Parameter agent_kennung (token bleibt Alias), Werbung per Produkt-Schalter agent_kennung_werbung (Standard AUS).
 * Teil A (ohne DB): Normalisierung, Widerspruch, Debug-Zaehler, Katalog, Schwaerzung (wertbasiert, Name egal).
 * Teil B (synapse_test:5433, nur mit DATABASE_URL): tools/list AUS = token, EIN = nur agent_kennung; Aufruf mit agent_kennung
 * identifiziert wie token; beide verschieden -> agent_kennung_widerspruch.
 *   node packages/core/tests/agent-kennung-p22-t131.test.mjs
 */
import assert from 'node:assert/strict';
let checks = 0;
const check = (ok, msg, extra) => { checks++; if (!ok) { console.error('FAIL', msg, extra ?? ''); process.exitCode = 1; } else console.log('ok', msg); };

const C = await import('../dist/index.js');
const S = await import('../dist/services/agent-profil-schalter.js');
const W = await import('../dist/services/tool-args-schwaerzen.js');

// ---------------- Teil A ----------------
const vorher = C.agentKennungDiagnose();
const a = C.normalisiereAgentKennung({ action: 'get', agent_kennung: 'sai_x1' });
check(a.eingabe.token === 'sai_x1' && !('agent_kennung' in a.eingabe) && !a.fehler, 'agent_kennung -> token');
const t = C.normalisiereAgentKennung({ action: 'get', token: 'sai_x1' });
check(t.eingabe.token === 'sai_x1' && !t.fehler, 'token unveraendert angenommen (Alias)');
const g = C.normalisiereAgentKennung({ token: 'sai_x1', agent_kennung: 'sai_x1' });
check(g.eingabe.token === 'sai_x1' && !('agent_kennung' in g.eingabe) && !g.fehler, 'beide gleich -> ok');
const w = C.normalisiereAgentKennung({ token: 'sai_x1', agent_kennung: 'sai_x2' });
check(w.fehler === 'agent_kennung_widerspruch', 'beide verschieden -> agent_kennung_widerspruch');
const o = C.normalisiereAgentKennung({ action: 'get' });
check(!('token' in o.eingabe) && !o.fehler, 'ohne Ausweis unveraendert');
const nachher = C.agentKennungDiagnose();
check(nachher.agent_kennung === vorher.agent_kennung + 1 && nachher.token === vorher.token + 1
  && nachher.beide_gleich === vorher.beide_gleich + 1 && nachher.widerspruch === vorher.widerspruch + 1, 'Debug-Zaehler je Name', nachher);
check(C.AGENT_KENNUNG_FELD === 'agent_kennung' && C.AGENT_KENNUNG_FUNKTION === 'agent_kennung_werbung', 'Konstanten');
check(!/token/i.test(C.AGENT_KENNUNG_PARAMETER.agent_kennung.description), 'Beschreibung nennt token nicht');
check(S.PROFIL_PRODUKT_FUNKTIONEN.includes('agent_kennung_werbung') && S.NUR_AUSDRUECKLICH.includes('agent_kennung_werbung')
  && !S.STANDARD_EIN.includes('agent_kennung_werbung'), 'Schalter im Katalog, nur ausdruecklich, Standard AUS');
const geschwaerzt = W.schwaerzeToolDaten({ agent_kennung: 'sai_8', token: 'sai_8', access_token: 'geheim123456' });
check(geschwaerzt.agent_kennung === 'sai_8' && geschwaerzt.token === 'sai_8', 'Ausweis unter beiden Namen nie geschwaerzt (P22-T55)', geschwaerzt);
check(geschwaerzt.access_token !== 'geheim123456', 'echte Tokens bleiben geschwaerzt', geschwaerzt);

// Teil A2: Textersatz (P22-T131 Folgeschritt) - nur Ausweis-Parameter, andere Tokens unberuehrt.
const T = C;
const vertrag = await import('../dist/services/agent-profil-vertrag.js');
const bereit = T.textMitAgentKennung(vertrag.tokenBereitText('sai_8'));
check(bereit.includes('agent_kennung:"sai_8"') && bereit.includes('agent_kennung:<Ausweis>') && !/\btoken[:)]/.test(bereit), 'tokenBereitText -> agent_kennung', bereit);
const neu = T.textMitAgentKennung(vertrag.TEXT_NEUINSTANZ);
check(neu.includes('agent_kennung:<Ausweis>') && !/\btoken:/.test(neu), 'TEXT_NEUINSTANZ -> agent_kennung', neu);
const tt = await import('../dist/services/agent-token-tools.js');
check(T.textMitAgentKennung(tt.TEXT_AUSWEIS_NUR_TOKEN).startsWith('Mit Ausweis nur agent_kennung mitgeben'), 'TEXT_AUSWEIS_NUR_TOKEN -> agent_kennung');
check(T.textMitAgentKennung(tt.TEXT_AGENT_ID_FACHFILTER('chat', ['get'])).endsWith('kommt aus agent_kennung.'), 'TEXT_AGENT_ID_FACHFILTER -> agent_kennung');
check(T.textMitAgentKennung('chat(action:"anmelden", token) (jede Anmeldung)').includes('chat(action:"anmelden", agent_kennung)'), 'Sitzungshinweis-Muster');
const andere = 'agent_token_fehlt, token_abrufen, Bearer-Token, wait_token, input_tokens, x-synapse-agent-token';
check(T.textMitAgentKennung(andere) === andere, 'andere Tokens/Codes unberuehrt');
const sk0 = vertrag.baueStartkonfiguration('sai_8', null);
check(sk0.erste_aktion.argumente.token === 'sai_8' && !('agent_kennung' in sk0.erste_aktion.argumente) && sk0.startsatz.includes('token:"sai_8"'), 'Startkonfiguration Standard = Bestand');
const sk1 = vertrag.baueStartkonfiguration('sai_8', null, undefined, true);
check(sk1.erste_aktion.argumente.agent_kennung === 'sai_8' && !('token' in sk1.erste_aktion.argumente) && sk1.startsatz.includes('agent_kennung:"sai_8"')
  && sk1.startsatz_vorlage.includes('agent_kennung:"{TOKEN}"'), 'Startkonfiguration kennung=true');
const fehlt = T.textMitAgentKennung(vertrag.TEXT_AGENT_TOKEN_FEHLT);
check(fehlt.startsWith('agent_token_fehlt:') && fehlt.includes('als agent_kennung mit') && fehlt.includes('agent_kennung:<Ausweis>')
  && fehlt.includes('token_abrufen'), 'TEXT_AGENT_TOKEN_FEHLT -> agent_kennung, Code/Admin-Aktion bleiben', fehlt);
const g0 = { when_to_use: 'chat(action:"anmelden", token), nie register' };
check(T.textMitAgentKennung(g0.when_to_use).includes('agent_kennung)'), 'Guide-Muster chat');

// ---------------- Teil B (Testdatenbank) ----------------
const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (!url) {
  console.log('Teil B uebersprungen (keine DATABASE_URL)');
} else {
  assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
  const pool = C.getPool();
  const P = 'p22_t131_' + process.pid;
  const defs = [{ name: 'thought', inputSchema: { type: 'object', properties: { action: { type: 'string' }, project: { type: 'string' }, agent_id: { type: 'string', description: 'Agent' } }, required: ['action', 'project'] } }];
  C.ergaenzeAgentTokenParameter(defs);
  check('token' in defs[0].inputSchema.properties && !('agent_kennung' in defs[0].inputSchema.properties), 'internes Schema unveraendert (RV9)');
  const setze = async aktiv => C.setzeProfilProduktSchalter({ ebene: 'projekt', project: P, funktion: 'agent_kennung_werbung', aktiv, grund: 'Test P22-T131' }, { system: 'user' });
  try {
    await C.setzeProfilProduktSchalter({ ebene: 'projekt', project: P, funktion: 'agenten_ausweis', aktiv: true, grund: 'Test P22-T131 Kern' }, { system: 'user' });
    const aus = (await C.beworbeneAgentTools(defs, { project: P }))[0].inputSchema.properties;
    check('token' in aus && !('agent_kennung' in aus), 'Schalter AUS: token beworben (Bestand)');
    await setze(true);
    const ein = (await C.beworbeneAgentTools(defs, { project: P }))[0].inputSchema.properties;
    check(!('token' in ein) && 'agent_kennung' in ein, 'Schalter EIN: nur agent_kennung beworben');
    check(!/kommt aus token/.test(ein.agent_id?.description ?? ''), 'agent_id-Text verweist auf agent_kennung', ein.agent_id);
    const k = await C.bereiteAgentToolAufrufVor('thought', { action: 'get', project: P, token: 'sai_a', agent_kennung: 'sai_b' }, 'srv-t131');
    check(k.antwort?.error === 'agent_kennung_widerspruch', 'Aufruf mit Widerspruch abgelehnt', k.antwort);
    check((await C.kennungsText('chat(anmelden, token)', P)) === 'chat(anmelden, agent_kennung)', 'kennungsText EIN');
    const gd = await C.guideFuerKennung(C.TOOL_GUIDES.chat, P);
    check(gd.when_to_use.includes('agent_kennung)') && C.TOOL_GUIDES.chat.when_to_use.includes('token)'), 'guideFuerKennung EIN, Original unveraendert');
    await setze(false);
    check((await C.kennungsText('chat(anmelden, token)', P)) === 'chat(anmelden, token)', 'kennungsText AUS = Bestand');
    check((await C.guideFuerKennung(C.TOOL_GUIDES.chat, P)) === C.TOOL_GUIDES.chat, 'guideFuerKennung AUS = dasselbe Objekt');
  } finally {
    await pool.query("DELETE FROM agent_profil_schalter WHERE project=$1", [P]).catch(() => {});
    await C.closePool?.();
  }
}
console.log(`P22-T131: ${checks} Pruefungen`);
