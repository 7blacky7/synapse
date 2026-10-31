/**
 * P22-T254: Channel-Suche, channels/channel-suche-logik.ts.
 * node --experimental-strip-types packages/web-ui/tests/channel-suche-p22-t254.test.mjs
 * Herkunft: Aufgabe P22-T254, User thought b92a5a84; PG-Lesestand, ganzer Channel im Fenster.
 * Ohne DB/Netz; Browser- und PG-Tests folgen in der gebündelten Testphase.
 */
import assert from 'node:assert/strict';
import { sortiereChannelSuche } from '../src/components/channel-suche-logik.ts';
const c=(name,zeit)=>({name,description:'Beschreibung',letzteAktivitaet:zeit,project:'p',id:1,createdBy:'x',createdAt:'',source:'api'});
const eingabe=[c('alt','2026-01-01T00:00:00Z'),c('neu','2026-01-03T00:00:00Z'),c('ungelesen','2026-01-02T00:00:00Z')];
assert.deepEqual(sortiereChannelSuche(eingabe,{ungelesen:1},'').map(x=>x.name),['ungelesen','neu','alt'],'P22-T254 channel-suche-logik: Ungelesen vor Aktivität, danach neueste');
assert.deepEqual(sortiereChannelSuche(eingabe,{},'NEU').map(x=>x.name),['neu'],'P22-T254 channel-suche-logik: Suche ohne Beachtung der Großschreibung');
assert.deepEqual(eingabe.map(x=>x.name),['alt','neu','ungelesen'],'P22-T254 channel-suche-logik: Eingabe unverändert');
console.log('P22-T254 Channel-Sortierung OK');
