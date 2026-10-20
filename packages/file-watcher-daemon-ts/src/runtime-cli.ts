#!/usr/bin/env node
/**
 * MODUL: runtime-cli.ts (P22-T4, W2a) — Befehl `synapse-runtime` im Agenten-Runtime-Container.
 * ZWECK: Manuelle Bedienung der versionierten CLI-Installation und Statusanzeige (User per docker exec; der Weg fuer
 *        Koordinator/Hauptagent-Auftraege ueber die API kommt mit P22-T5/T6 und nutzt dieselben Funktionen).
 *
 *   synapse-runtime status                         status.json des Runtime-Daemons (sonst Live-Inventar)
 *   synapse-runtime cli list [claude|codex]        installierte Versionen, aktiver Launcher, letzte Aktion
 *   synapse-runtime cli install <cli> <version|tag> neue Version daneben installieren (aktiviert NICHT)
 *   synapse-runtime cli use <cli> <version>        Launcher auf eine installierte Version umschalten
 *   synapse-runtime cli update <cli> [version|tag] installieren + umschalten (Standard-Ziel: latest)
 *   synapse-runtime cli rollback <cli>             zurueck auf den Stand vor der letzten Umschaltung
 *   synapse-runtime cli verlauf <cli> [anzahl]     Verlauf (installiert/aktiviert/rollback/fehlgeschlagen/entfernt)
 *   synapse-runtime cli aufraeumen <cli> [anzahl]  alte Versionen entfernen bis auf [anzahl] (Standard SYNAPSE_RUNTIME_CLI_BEHALTEN)
 *
 * Optionen: --basis <dir> --launcher-dir <dir> (sonst SYNAPSE_CLI_BASIS / SYNAPSE_CLI_LAUNCHER_DIR bzw. Standard),
 *           --akteur <name> (Standard 'user'), --erzwingen (update auch auf aeltere Version),
 *           --behalten <n> (update: danach aufraeumen; Standard SYNAPSE_RUNTIME_CLI_BEHALTEN, 0 = alle behalten).
 * Ausgabe immer JSON auf stdout; Exit 0 = ok, 1 = Fehler, 2 = Bedienfehler. Laufende Agenten werden nicht beendet:
 * nur der Launcher-Symlink wechselt, alte Versionen bleiben liegen.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CLI_NAMEN, CliVersionFehler, istCliName, standardLayout, inventar, leseVerlauf, installiereVersion,
  aktiviereVersion, aktualisiere, rollback, raeumeAuf, type CliLayout, type CliName, type Akteur,
} from './cli-versionen.js';
import { leseRuntimeKonfig, RUNTIME_STATUS_DATEI } from './startprofile/runtime.js';

interface Argumente { positional: string[]; optionen: Record<string, string | true> }

function parse(argv: string[]): Argumente {
  const positional: string[] = [];
  const optionen: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const naechstes = argv[i + 1];
      if (name === 'erzwingen' || naechstes === undefined || naechstes.startsWith('--')) optionen[name] = true;
      else { optionen[name] = naechstes; i++; }
    } else positional.push(a);
  }
  return { positional, optionen };
}

class Bedienfehler extends Error {}

function cliArg(wert: string | undefined): CliName {
  if (!wert || !istCliName(wert)) throw new Bedienfehler(`CLI fehlt oder unbekannt (erlaubt: ${CLI_NAMEN.join(', ')})`);
  return wert;
}

function pflicht(wert: string | undefined, was: string): string {
  if (!wert) throw new Bedienfehler(`${was} fehlt`);
  return wert;
}

async function fuehreAus(argv: string[]): Promise<unknown> {
  const { positional, optionen } = parse(argv);
  const basis = standardLayout();
  const layout: CliLayout = {
    basis: typeof optionen.basis === 'string' ? path.resolve(optionen.basis) : basis.basis,
    launcherDir: typeof optionen['launcher-dir'] === 'string' ? path.resolve(optionen['launcher-dir']) : basis.launcherDir,
  };
  const akteur: Akteur = { quelle: 'manuell', akteur: typeof optionen.akteur === 'string' ? optionen.akteur : 'user' };
  const [bereich, aktion, a1, a2] = positional;
  const behaltenStandard = () => leseRuntimeKonfig().behalten.wert;
  const behalten = (wert: string | true | undefined): number => {
    if (typeof wert !== 'string') return behaltenStandard();
    const n = Number(wert);
    if (!Number.isInteger(n) || n < 0) throw new Bedienfehler('--behalten bzw. anzahl muss eine ganze Zahl >= 0 sein');
    return n === 1 ? 2 : n;
  };

  if (bereich === 'status') {
    const k = leseRuntimeKonfig();
    const datei = path.join(k.stateDir.wert, RUNTIME_STATUS_DATEI);
    try { return { quelle: 'daemon', datei, ...JSON.parse(fs.readFileSync(datei, 'utf8')) }; }
    catch { return { quelle: 'live', hinweis: `${datei} fehlt – Runtime-Daemon laeuft nicht oder hat noch keinen Status geschrieben`, clis: CLI_NAMEN.map((c) => inventar(layout, c)) }; }
  }
  if (bereich !== 'cli') throw new Bedienfehler('Befehl: status | cli <list|install|use|update|rollback|aufraeumen|verlauf> ...');

  switch (aktion) {
    case 'list':
      return a1 ? inventar(layout, cliArg(a1)) : CLI_NAMEN.map((c) => inventar(layout, c));
    case 'install':
      return installiereVersion(layout, cliArg(a1), pflicht(a2, 'Version oder dist-tag'), akteur);
    case 'use':
      return aktiviereVersion(layout, cliArg(a1), pflicht(a2, 'Version'), akteur);
    case 'update':
      return aktualisiere(layout, cliArg(a1), a2 ?? 'latest', akteur, { erzwingen: optionen.erzwingen === true, behalten: behalten(optionen.behalten) });
    case 'rollback':
      return rollback(layout, cliArg(a1), akteur);
    case 'aufraeumen':
      return raeumeAuf(layout, cliArg(a1), behalten(a2), akteur);
    case 'verlauf':
      return leseVerlauf(layout, cliArg(a1), a2 ? Number(a2) || 50 : 50);
    default:
      throw new Bedienfehler(`unbekannte cli-Aktion "${aktion ?? ''}" (list, install, use, update, rollback, aufraeumen, verlauf)`);
  }
}

fuehreAus(process.argv.slice(2)).then(
  (ergebnis) => { process.stdout.write(JSON.stringify({ success: true, ergebnis }, null, 2) + '\n'); },
  (err) => {
    const code = err instanceof CliVersionFehler ? err.code : err instanceof Bedienfehler ? 'bedienfehler' : 'fehler';
    process.stdout.write(JSON.stringify({ success: false, error: code, message: (err as Error).message }, null, 2) + '\n');
    process.exitCode = err instanceof Bedienfehler ? 2 : 1;
  },
);
