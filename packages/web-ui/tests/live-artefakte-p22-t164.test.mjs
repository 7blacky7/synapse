/**
 * P22-T164: Kachelgeometrie aus src/components/live-artefakte-layout.ts.
 * User thought 2a67d969: Kacheln verschieben und in Größe ändern.
 * Ohne DB/Browser; node --experimental-strip-types packages/web-ui/tests/live-artefakte-p22-t164.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verschiebe, skaliere } from '../src/components/live-artefakte-layout.ts';
const basis = {x:20,y:30,breite:40,hoehe:200,revision:7};
test('P22-T164 live-artefakte-layout.ts: Bewegung hält Kachel im sichtbaren Bereich',()=>{
 const ergebnis=verschiebe(basis,100,-100);
 assert.deepEqual(ergebnis,{...basis,x:60,y:0},'P22-T164 erwartet x=60 y=0; tatsächlich '+JSON.stringify(ergebnis));
 assert.equal(basis.x,20,'P22-T164 Eingabe bleibt unverändert');
});
test('P22-T164 live-artefakte-layout.ts: Größe begrenzt und Revision erhalten',()=>{
 const gross=skaliere(basis,100,90), klein=skaliere(basis,-100,-200);
 assert.equal(gross.breite,80,'P22-T164 max. Breite bei x=20: '+gross.breite);
 assert.equal(klein.breite,10,'P22-T164 Mindestbreite: '+klein.breite);
 assert.equal(klein.hoehe,100,'P22-T164 Mindesthöhe: '+klein.hoehe);
 assert.equal(klein.revision,7,'P22-T164 Revision bei Geometrieänderung: '+klein.revision);
});
