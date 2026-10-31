/**
 * P22-T194: Pruefung des Image-Mod-Pakets und Aufbau der managed Policy fuer den VERWALTETEN Start.
 * Der ausfuehrbare policyHelper ist runtime-mod-policy-helper.ts (t223-Nachbesserung, D0 2445a89d): ohne verwalteten Start
 * gibt er eine leere managed Policy aus, ohne diese Datei und ohne @synapse/core zu laden.
 * Kein Schalter: die API liefert pro Wrapper den PG-Startstand.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { baueRuntimeModPolicy } from '@synapse/core';
export function pruefeRuntimeModPaket(pfad: string) {
  const root = realpathSync(pfad);
  const manifest = JSON.parse(readFileSync(join(root, 'synapse-paket.json'), 'utf8')) as {
    revision: string; version: string; dateien: Record<string, string>;
  };
  if (!manifest.revision || !manifest.version || !manifest.dateien || Object.keys(manifest.dateien).length < 4) throw Error('runtime_mod_paket_unvollstaendig');
  for (const [rel, hash] of Object.entries(manifest.dateien)) {
    if (!rel || rel.startsWith('/') || rel.split('/').some(s => s === '..' || !s)) throw Error('runtime_mod_paket_pfad');
    const file = realpathSync(join(root, rel));
    if (!file.startsWith(root + '/')) throw Error('runtime_mod_paket_ausbruch');
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) throw Error('runtime_mod_paket_hash:' + rel);
  }
  const plugin = JSON.parse(readFileSync(join(root, 'synapse-inbox/.claude-plugin/plugin.json'), 'utf8'));
  if (plugin.name !== 'synapse-inbox' || plugin.version !== manifest.version) throw Error('runtime_mod_plugin_falsch');
  return { root, ...manifest };
}
export function runtimeModPolicyAusUmgebung(env: NodeJS.ProcessEnv = process.env) {
  const p = pruefeRuntimeModPaket(env.SYNAPSE_RUNTIME_MOD_MARKETPLACE || '/opt/synapse/current/mods');
  console.error('[runtime-mod-policy] ' + JSON.stringify({ revision: p.revision, version: p.version, pfad: p.root,
    quelle: 'image', read_guard: env.SYNAPSE_TOOL_AUSGABE_AKTIV === '1' }));
  return baueRuntimeModPolicy(env, p.root);
}
