/** P22-T194: reine, pro CLI-Start berechnete managed Policy; kein PG-/Netz-/Prozesszugriff. */
import { claudeToolAusgabe } from './runtime-tool-ausgabe-regeln.js';
import type { RuntimeModStand } from './runtime-synapse-mods.js';
export const RUNTIME_MOD_PLUGIN = 'synapse-inbox@synapse-runtime';
export function runtimeModStartStand(env: NodeJS.ProcessEnv, jetzt = Date.now()): RuntimeModStand {
  const aus: RuntimeModStand = { aktiv: false, quelle: 'standard', bis: null, letzter_fehler: null,
    produkt: { aktiv: false, quelle: 'standard', letzter_fehler: null } };
  if (!env.SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND) return aus;
  try {
    const s = JSON.parse(env.SYNAPSE_RUNTIME_SYNAPSE_MODS_STAND) as RuntimeModStand;
    if (typeof s.aktiv !== 'boolean' || typeof s.quelle !== 'string' || !s.produkt
      || typeof s.produkt.aktiv !== 'boolean' || typeof s.produkt.quelle !== 'string') throw Error('Stand');
    if (s.letzter_fehler) return { ...aus, letzter_fehler: s.letzter_fehler };
    if (s.quelle === 'intern' && (!s.bis || !Number.isFinite(Date.parse(s.bis)) || Date.parse(s.bis) <= jetzt)) {
      return { ...s, ...s.produkt, bis: null, aktiv: s.produkt.aktiv && !s.produkt.letzter_fehler };
    }
    return s;
  } catch { return { ...aus, letzter_fehler: 'runtime_mod_startstand_ungueltig' }; }
}
export function baueRuntimeModPolicy(env: NodeJS.ProcessEnv, marketplace: string, jetzt = Date.now()) {
  if (!marketplace.startsWith('/') || marketplace.split('/').includes('..') || marketplace.includes('\0')) throw Error('runtime_mod_marketplace_ungueltig');
  const mods = runtimeModStartStand(env, jetzt);
  // t223-Nachbesserung: nur im verwalteten Start aufgerufen; der Guard gehoert dann in die managed Policy.
  const read = claudeToolAusgabe({ ...env, SYNAPSE_RUNTIME_MOD_VERWALTET: '1' }, true);
  return { managedSettings: {
    allowManagedHooksOnly: true,
    disableAllHooks: !mods.aktiv && !read.aktiv,
    extraKnownMarketplaces: { 'synapse-runtime': { source: { source: 'directory', path: marketplace } } },
    enabledPlugins: { [RUNTIME_MOD_PLUGIN]: mods.aktiv },
    prependPlugins: [...(mods.aktiv ? [RUNTIME_MOD_PLUGIN] : []), 'sec-default@builtin'],
    pluginConfigs: { 'cc-plugin-sec-default@builtin': { options: { allowManagedModsOnly: true } } },
    ...(read.einstellungen ? { hooks: read.einstellungen.hooks } : {}),
  } };
}
