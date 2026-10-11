/**
 * P16-T9 (11.10.2026): Worker-Zahl des Syntax-Pools. Env SYNTAX_WORKER_THREADS geht vor der Vorgabe des
 * Aufrufers (registriereStandardSyntaxPruefer({threads})), Standard 2, untere Grenze 1, obere Grenze
 * min(8, Kerne). Beim Start des Pools steht eine Logzeile mit der Worker-Zahl auf stderr.
 * Jeder Fall laeuft in einem eigenen Kindprozess (der Pool ist ein Prozess-Singleton). Keine DB.
 * AUFRUF: node packages/core/tests/syntax-pool-workerzahl.test.mjs   (nach pnpm run build in packages/core)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const hier = dirname(fileURLToPath(import.meta.url));
const index = pathToFileURL(join(hier, '..', 'dist', 'services', 'syntax-pruefer', 'index.js')).href;
const ober = Math.max(1, Math.min(8, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length));

let ok = 0;
let fehl = 0;
function pruefe(name, bedingung, info) {
  if (bedingung) { ok++; console.log('  OK  ', name); } else { fehl++; console.log('  FEHL', name, info === undefined ? '' : JSON.stringify(info)); }
}

function lauf(env, threads) {
  const kind = `
    const S = await import(${JSON.stringify(index)});
    const namen = S.registriereStandardSyntaxPruefer(${threads === undefined ? '' : `{ threads: ${threads} }`});
    const z = S.syntaxPoolZustand();
    process.stdout.write(JSON.stringify({ namen: namen.length, groesse: z ? z.groesse : null }));
    await S.beendeSyntaxPool();
    process.exit(0);
  `;
  const umgebung = { ...process.env };
  delete umgebung.SYNTAX_WORKER_THREADS;
  delete umgebung.SYNTAXPRUEFUNG;
  Object.assign(umgebung, env);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', kind], { env: umgebung, encoding: 'utf8', timeout: 60_000 });
  let aus = null;
  try { aus = JSON.parse(r.stdout); } catch { /* bleibt null */ }
  const log = (r.stderr || '').split('\n').filter((z) => z.includes('[syntax-pool]'));
  return { status: r.status, aus, log, stderr: r.stderr };
}

console.log(`Syntax-Pool Worker-Zahl (obere Grenze auf diesem Rechner: ${ober})`);
{
  const r = lauf({});
  pruefe('W1 ohne Env und Vorgabe: Standard 2 (bzw. Grenze)', r.aus?.groesse === Math.min(2, ober), r);
  pruefe('W1 Logzeile mit Worker-Zahl', r.log.length === 1 && r.log[0].includes(`${Math.min(2, ober)} Worker`) && /Standard/.test(r.log[0]), r.log);
}
{
  const r = lauf({}, 1);
  pruefe('W2 Vorgabe des Aufrufers (MCP stdio 1)', r.aus?.groesse === 1 && r.log.length === 1 && r.log[0].includes('1 Worker') && /Vorgabe/.test(r.log[0]), r);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: String(Math.min(3, ober)) }, 1);
  pruefe('W3 Env geht vor Vorgabe', r.aus?.groesse === Math.min(3, ober) && /SYNTAX_WORKER_THREADS/.test(r.log[0] ?? ''), r);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: '100' });
  pruefe('W4 Env 100 -> obere Grenze', r.aus?.groesse === ober, r);
  pruefe('W4 Logzeile nennt die Begrenzung', /begrenzt/.test(r.log[0] ?? ''), r.log);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: 'abc' });
  pruefe('W5 Env unlesbar -> Standard, Hinweis', r.aus?.groesse === Math.min(2, ober) && /ungueltig/.test(r.log[0] ?? ''), r);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: '-1' }, 1);
  pruefe('W6 Env negativ -> Vorgabe, Hinweis', r.aus?.groesse === 1 && /ungueltig/.test(r.log[0] ?? ''), r);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: '1.7' });
  pruefe('W7 Env 1.7 -> 1 (abgerundet)', r.aus?.groesse === 1, r);
}
{
  const r = lauf({ SYNTAX_WORKER_THREADS: '0' });
  pruefe('W8 Env 0 -> kein Pool, Pruefer trotzdem angemeldet', r.aus?.groesse === null && r.aus?.namen > 0, r);
  pruefe('W8 Logzeile: Haupt-Thread', r.log.length === 1 && /Haupt-Thread/.test(r.log[0]), r.log);
}
{
  const r = lauf({ SYNTAXPRUEFUNG: '0' });
  pruefe('W9 Notaus SYNTAXPRUEFUNG=0: nichts angemeldet, kein Pool', r.aus?.namen === 0 && r.aus?.groesse === null, r);
}

console.log(`\n${ok} OK, ${fehl} FEHL`);
process.exit(fehl ? 1 : 0);
