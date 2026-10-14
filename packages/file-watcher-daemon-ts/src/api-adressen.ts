/** P9-T28: gemeinsame Daemon-Adresskette, Reihenfolge wie Tray/compute-node. */
import { loadConfig } from './config.js';
export const API_TUNNEL_STANDARD = 'https://synapse.moosynapse.org';
export const API_LAN_STANDARD = 'http://192.168.50.65:3456';

export function normalisiereBasis(roh: unknown): string {
  return typeof roh === 'string' ? roh.trim().replace(/\/+$/, '') : '';
}

export function gueltigeBasis(basis: string): boolean {
  try {
    const u = new URL(basis);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** Adresskette in derselben Reihenfolge wie apiBases() (tray/api_client.go), ohne Duplikate. */
export function apiBasenAusConfig(o: {
  env?: NodeJS.ProcessEnv;
  cfg?: { synapse_api_url?: unknown; synapse_api_fallback_url?: unknown };
} = {}): string[] {
  const env = o.env ?? process.env;
  let cfg = o.cfg;
  if (!cfg) {
    try { cfg = loadConfig(); } catch { cfg = {}; }
  }
  const out: string[] = [];
  const add = (roh: unknown) => {
    const u = normalisiereBasis(roh);
    if (u && !out.includes(u) && gueltigeBasis(u)) out.push(u);
  };
  add(env.SYNAPSE_API_URL);
  add(cfg.synapse_api_url);
  add(API_TUNNEL_STANDARD); // Nur Rueckfall, Quelle ist config.json.
  const fbEnv = normalisiereBasis(env.SYNAPSE_API_FALLBACK_URL);
  const fbCfg = normalisiereBasis(cfg.synapse_api_fallback_url);
  add(fbEnv || fbCfg || API_LAN_STANDARD);
  return out;
}

