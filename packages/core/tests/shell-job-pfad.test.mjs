/**
 * P9-T13: Shell-Job-PATH um ~/.local/bin und mise-Shims ergaenzen
 * (packages/core/src/services/shell-job-umgebung.ts: ergaenzeJobPfad + baueJobUmgebung).
 *
 * ANLASS: cc-send liegt in ~/.local/bin; der Daemon startet ohne Login-Shell-PATH, deshalb
 * fand kein Shell-Job (sh -c) das Kommando (Exit 127).
 *
 * Ohne DB: reine Funktion mit eingespieltem existiert(); baueJobUmgebung mit eingespieltem
 * Lookup. Kein Zugriff auf Dateisystem-Zustand des Rechners.
 *
 * Voraussetzung: pnpm --filter @synapse/core build
 * Aufruf:        node packages/core/tests/shell-job-pfad.test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const core = await import(path.join(HIER, '../dist/index.js'));

let fehler = 0;
const ok = (name, bedingung) => {
  console.log((bedingung ? 'OK   ' : 'FAIL ') + name);
  if (!bedingung) fehler++;
};

const { ergaenzeJobPfad, baueJobUmgebung } = core;
ok('ergaenzeJobPfad ist exportiert', typeof ergaenzeJobPfad === 'function');

if (typeof ergaenzeJobPfad === 'function') {
  const HOME = '/home/t';
  const LOKAL = `${HOME}/.local/bin`;
  const SHIMS = `${HOME}/.local/share/mise/shims`;
  const alle = () => true;
  const keine = () => false;
  const nur = (...p) => (x) => p.includes(x);

  // fehlt -> angehaengt, Reihenfolge des Bestands bleibt
  ok('beide fehlen -> ans Ende angehaengt',
    ergaenzeJobPfad('/usr/bin:/bin', HOME, alle) === `/usr/bin:/bin:${LOKAL}:${SHIMS}`);
  ok('nichts wird vorangestellt (Bestand zuerst)',
    ergaenzeJobPfad('/opt/x:/usr/bin', HOME, alle).startsWith('/opt/x:/usr/bin:'));

  // schon drin -> keine Dopplung (auch mit Schluss-Slash)
  ok('.local/bin schon drin -> nur Shims dazu',
    ergaenzeJobPfad(`/usr/bin:${LOKAL}`, HOME, alle) === `/usr/bin:${LOKAL}:${SHIMS}`);
  ok('.local/bin mit Schluss-Slash gilt als vorhanden',
    ergaenzeJobPfad(`/usr/bin:${LOKAL}/`, HOME, nur(LOKAL, SHIMS)) === `/usr/bin:${LOKAL}/:${SHIMS}`);
  ok('beide schon drin -> unveraendert',
    ergaenzeJobPfad(`${SHIMS}:/usr/bin:${LOKAL}`, HOME, alle) === `${SHIMS}:/usr/bin:${LOKAL}`);

  // nur wenn vorhanden
  ok('nur .local/bin existiert -> Shims nicht angehaengt',
    ergaenzeJobPfad('/usr/bin', HOME, nur(LOKAL)) === `/usr/bin:${LOKAL}`);
  ok('nur Shims existieren -> .local/bin nicht angehaengt',
    ergaenzeJobPfad('/usr/bin', HOME, nur(SHIMS)) === `/usr/bin:${SHIMS}`);

  // API-Container: home ohne diese Verzeichnisse -> unveraendert
  ok('API-Container (keins existiert) -> PATH unveraendert',
    ergaenzeJobPfad('/usr/local/bin:/usr/bin', '/root', keine) === '/usr/local/bin:/usr/bin');

  // leer/fehlend -> unveraendert
  ok('leerer PATH bleibt leer', ergaenzeJobPfad('', HOME, alle) === '');
  ok('fehlender PATH bleibt undefined', ergaenzeJobPfad(undefined, HOME, alle) === undefined);

  // bestehende Duplikate werden nicht angefasst
  ok('Duplikate im Bestand bleiben',
    ergaenzeJobPfad('/usr/bin:/usr/bin', HOME, keine) === '/usr/bin:/usr/bin');

  // Trenner injizierbar (Windows ';')
  ok('eigener Trenner',
    ergaenzeJobPfad('C:\\a', HOME, nur(LOKAL), ';') === `C:\\a;${LOKAL}`);
}

// Verdrahtung in baueJobUmgebung
if (typeof baueJobUmgebung === 'function') {
  const lookup = async () => null;
  const basis = { PATH: '/usr/bin:/bin', HOME: '/home/t', USER: 't' };
  const home = '/home/t';
  const lokal = `${home}/.local/bin`;
  const mit = await baueJobUmgebung('wegwerf-ohne-db', {
    basis, leseZugang: lookup, secretsPfad: '/nicht/da', home, existiert: (p) => p === lokal,
  });
  ok(`baueJobUmgebung haengt .local/bin an (${mit.env.PATH})`, mit.env.PATH === `/usr/bin:/bin:${lokal}`);
  const ohne = await baueJobUmgebung('wegwerf-ohne-db', {
    basis, leseZugang: lookup, secretsPfad: '/nicht/da', home: '/root', existiert: () => false,
  });
  ok('baueJobUmgebung im API-Container: PATH unveraendert', ohne.env.PATH === '/usr/bin:/bin');
  const keinPfad = await baueJobUmgebung('wegwerf-ohne-db', {
    basis: { HOME: '/home/t' }, leseZugang: lookup, secretsPfad: '/nicht/da', home, existiert: () => true,
  });
  ok('baueJobUmgebung ohne PATH in der Basis: PATH bleibt ungesetzt', keinPfad.env.PATH === undefined);
  ok('basis wird nicht veraendert', basis.PATH === '/usr/bin:/bin');
}

console.log(fehler ? `\n${fehler} FEHLER` : '\nALLE OK');
process.exit(fehler ? 1 : 0);
