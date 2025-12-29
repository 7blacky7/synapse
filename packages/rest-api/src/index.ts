#!/usr/bin/env node
/**
 * Synapse REST API Server
 * Entry Point
 */

import 'dotenv/config';
import { startServer } from './server.js';

// Server starten
startServer().catch((error) => {
  console.error('[Synapse API] Fataler Fehler:', error);
  process.exit(1);
});
