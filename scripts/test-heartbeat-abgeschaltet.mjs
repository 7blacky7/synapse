#!/usr/bin/env node
// test-heartbeat-abgeschaltet.mjs — P7-T19: wake erreicht auch einen Spezialisten mit
// abgeschaltetem Heartbeat. Reine Entscheidungsfunktion, ohne DB und ohne Prozess.
//   - wartender Weckruf + Agent frei     -> ein Nachhol-Durchgang (Takt bleibt aus)
//   - wartender Weckruf + Agent busy     -> NICHT verwerfen: nichts tun, Weckruf bleibt
//                                           in der Queue, der naechste Waechter-Takt stellt zu
//   - nur Luecke im Live-Kanal           -> Nachhol-Durchgang (wie bisher)
//   - nichts                             -> nichts (Heartbeat still)
// Aufruf: node scripts/test-heartbeat-abgeschaltet.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const mod = await import('../packages/agents/dist/heartbeat-entscheidung.js');
const e = (o) => mod.entscheideAbgeschaltet({ luecke: false, wartendeWakes: 0, busy: false, ...o });

await pruefe('nichts anliegt: nichts tun', () => assert.equal(e({}).aktion, 'nichts'));
await pruefe('Weckruf wartet, Agent frei: Nachhol-Durchgang', () => {
  const r = e({ wartendeWakes: 1 });
  assert.equal(r.aktion, 'nachholPoll');
  assert.equal(r.grund, 'wake');
});
await pruefe('Weckruf wartet, Agent busy: nichts tun (Weckruf bleibt in der Queue)', () => {
  const r = e({ wartendeWakes: 2, busy: true });
  assert.equal(r.aktion, 'nichts');
  assert.equal(r.grund, 'wake-busy');
});
await pruefe('nur Luecke im Live-Kanal: Nachhol-Durchgang wie bisher', () => {
  const r = e({ luecke: true });
  assert.equal(r.aktion, 'nachholPoll');
  assert.equal(r.grund, 'luecke');
});
await pruefe('Luecke + Weckruf: Weckruf hat Vorrang als Grund', () => {
  assert.equal(e({ luecke: true, wartendeWakes: 1 }).grund, 'wake');
});
await pruefe('Takt bleibt aus: die Entscheidung kennt nur nichts/nachholPoll', () => {
  for (const luecke of [true, false]) for (const w of [0, 1]) for (const busy of [true, false]) {
    assert.ok(['nichts', 'nachholPoll'].includes(e({ luecke, wartendeWakes: w, busy }).aktion));
  }
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
