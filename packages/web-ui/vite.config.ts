import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface LocalSynapseConfig {
  synapse_api_url?: unknown;
  port?: unknown;
}

function readLocalConfig(): LocalSynapseConfig {
  const configPath = path.join(os.homedir(), '.synapse', 'file-watcher', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as LocalSynapseConfig;
  } catch {
    return {};
  }
}

/**
 * Ermittelt dieselbe Synapse-API, die auch der lokale FileWatcher verwendet.
 * Reihenfolge: Umgebungsvariable -> FileWatcher-Konfiguration -> lokaler Fallback.
 */
function resolveApiTarget(config: LocalSynapseConfig): string {
  const environmentUrl = process.env.SYNAPSE_API_URL?.trim();
  if (environmentUrl) return environmentUrl.replace(/\/$/, '');
  if (typeof config.synapse_api_url === 'string' && config.synapse_api_url.trim()) {
    return config.synapse_api_url.trim().replace(/\/$/, '');
  }
  return 'http://127.0.0.1:3456';
}

/** GoTray-Projektquelle: lokaler FileWatcher-Endpunkt GET /projects. */
function resolveWatcherTarget(config: LocalSynapseConfig): string {
  const environmentUrl = process.env.SYNAPSE_WATCHER_URL?.trim();
  if (environmentUrl) return environmentUrl.replace(/\/$/, '');
  const port = typeof config.port === 'number' ? config.port : Number(config.port) || 3457;
  return 'http://127.0.0.1:' + port;
}

const localConfig = readLocalConfig();
const apiTarget = resolveApiTarget(localConfig);
const watcherTarget = resolveWatcherTarget(localConfig);
console.info('[web-ui] API-Proxy -> ' + apiTarget);
console.info('[web-ui] GoTray-Projektquelle -> ' + watcherTarget);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/watcher-api': {
        target: watcherTarget,
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/watcher-api/, ''),
      },
    },
  },
});
