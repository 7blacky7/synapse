#!/usr/bin/env node
/**
 * Synapse MCP Server
 * Entry Point
 */

import 'dotenv/config';
import { startServer } from './server.js';

// Server starten
startServer().catch((error) => {
  console.error('[Synapse MCP] Fataler Fehler:', error);
  process.exit(1);
});
