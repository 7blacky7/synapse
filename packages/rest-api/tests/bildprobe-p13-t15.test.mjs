/** P13-T15: DB-freie Zeitfenster-Probe, Fake-Uhr statt Wartezeiten. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BildprobeDienst, ladeBildprobeKonfiguration } from '../../core/dist/services/bildprobe.js';
import { bildprobeRoutes } from '../dist/routes/bildprobe.js';
const require = createRequire(new URL('../package.json',import.meta.url));
const Fastify = require('fastify');
const config = ladeBildprobeKonfiguration({
  SYNAPSE_BILDPROBE_TTL_MS:'100',
  SYNAPSE_BILDPROBE_OFFEN_S:'2',
  SYNAPSE_BILDPROBE_OFFEN_MAX_S:'4',
  SYNAPSE_BILDPROBE_BASE_URL:'https://example.invalid',
});
const defaults = ladeBildprobeKonfiguration({});
assert.equal(defaults.offenSekunden,600, 'Default600s vorhanden');
assert.equal(defaults.offenMaxSekunden,3600);
let now = 1000;
const dienst = new BildprobeDienst(config,{jetzt:()=>now,wort:()=> 'FALKE-7381'});
const json = r => JSON.parse(r.content[0].text);
const token = r => new URL(r.link).pathname.split('/').at(-1);
const details = {ip:'127.0.0.1',userAgent:'test'};
const link = json(dienst.ausfuehren({modus:'link'}));
assert.equal(link.offen_bis,new Date(3000).toISOString());
assert.equal(link.einmalig,false);
assert.equal(link.modus,'link');
assert.equal(dienst.abrufen(token(link),details).status,200);
now = 1500; // Separate100ms Inline-TTL darf das2s Linkfenster nicht verkürzen.
assert.equal(dienst.abrufen(token(link),details).status,200);
now = 2999;
assert.equal(dienst.abrufen(token(link),details).status,200);
now = 3000;
const expired = dienst.abrufen(token(link),details);
assert.equal(expired.status,410);
assert.equal(expired.error,'bildprobe_abgelaufen');
const stats = json(dienst.ausfuehren({probe_id:link.probe_id,wort:'FALSCH'}));
assert.equal(stats.offen_bis,link.offen_bis);
assert.equal(stats.modus,'link');
assert.equal(stats.abrufanzahl,4);
assert.deepEqual(stats.abrufe.map(x=>x.status),[200,200,200,410]);
const once = json(dienst.ausfuehren({modus:'link',offen_sekunden:1,einmalig:true}));
assert.equal(dienst.abrufen(token(once),details).status,200);
assert.equal(dienst.abrufen(token(once),details).error,'bildprobe_verbraucht');
now += 1000;
assert.equal(dienst.abrufen(token(once),details).error,'bildprobe_abgelaufen');
for (const offen_sekunden of [5,0,-1,1.5,'2',NaN]) {
  const bad = json(dienst.ausfuehren({modus:'link',offen_sekunden}));
  assert.equal(bad.success,false);
  assert.equal(bad.error,'bildprobe_offen_sekunden_ungueltig');
  assert.equal(bad.max_offen_sekunden,4);
}
assert.equal(json(dienst.ausfuehren({modus:'link',einmalig:'true'})).success,false);
const max = json(dienst.ausfuehren({modus:'link',offen_sekunden:4}));
assert.equal(max.offen_bis,new Date(now+4000).toISOString());
const app = Fastify({logger:false});
await app.register(bildprobeRoutes,{dienst});
try {
  const fresh = json(dienst.ausfuehren({modus:'link',offen_sekunden:1}));
  const path = new URL(fresh.link).pathname;
  const request = {method:'GET',url:path,headers:{'cf-connecting-ip':'198.51.100.9','user-agent':'image-proxy'}};
  const double = await Promise.all([app.inject(request),app.inject(request)]);
  assert.deepEqual(double.map(x=>x.statusCode),[200,200]);
  const check = json(dienst.ausfuehren({probe_id:fresh.probe_id,wort:'FALSCH'}));
  assert.equal(check.abrufe[0].ip,'198.51.100.9');
  assert.equal(check.abrufe[0].user_agent,'image-proxy');
  assert.ok(check.abrufe[0].zeit);
  now += 1000;
  const gone = await app.inject(request);
  assert.equal(gone.statusCode,410);
  assert.equal(gone.json().error,'bildprobe_abgelaufen');
  const strict = json(dienst.ausfuehren({modus:'link',einmalig:true}));
  const strictPath = new URL(strict.link).pathname;
  assert.equal((await app.inject(strictPath)).statusCode,200);
  assert.equal((await app.inject(strictPath)).json().error,'bildprobe_verbraucht');
} finally {await app.close();}
console.log('P13-T15 PASS: Fenster ab Erzeugung, Default/Max, Mehrfach/Race200, Ablauf410, Einmal410, CF-IP, UTC-Metadaten; DB-frei.');
