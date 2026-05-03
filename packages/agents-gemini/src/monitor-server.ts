/**
 * Mini-HTTP-Server fuer Live-Monitoring der Gemini-Runtime.
 *
 * Endpoints:
 *   GET /         → public/index.html (Live-Viewer)
 *   GET /events   → SSE-Stream aller Runtime-Events
 *   GET /run.jsonl → komplette JSONL-Logfile des aktuellen Runs
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MonitorEvent {
  type: 'start' | 'user' | 'assistant' | 'function_call' | 'function_response' | 'usage' | 'error' | 'done' | 'respawn_marker';
  timestamp: string;
  payload: Record<string, unknown>;
}

export class MonitorServer {
  private fastify: FastifyInstance;
  private bus = new EventEmitter();
  private buffer: MonitorEvent[] = [];
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.bus.setMaxListeners(0);
    this.fastify = Fastify({ logger: false });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.fastify.get('/', async (_req, reply) => {
      const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf-8');
      reply.type('text/html').send(html);
    });

    this.fastify.get('/run.jsonl', (_req, reply) => {
      reply.type('application/x-ndjson');
      return createReadStream(this.logPath);
    });

    this.fastify.get('/events', (_req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Replay buffered events
      for (const ev of this.buffer) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      const handler = (ev: MonitorEvent) => {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      };
      this.bus.on('event', handler);
      _req.raw.on('close', () => {
        this.bus.off('event', handler);
      });
    });
  }

  emit(type: MonitorEvent['type'], payload: Record<string, unknown>): MonitorEvent {
    const ev: MonitorEvent = {
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.buffer.push(ev);
    this.bus.emit('event', ev);
    return ev;
  }

  /**
   * Versucht startPort, geht bei EADDRINUSE schrittweise hoch.
   * Verhindert Port-Konflikte bei mehreren parallelen Spezialisten.
   */
  async start(startPort: number, host = '127.0.0.1', maxAttempts = 100): Promise<string> {
    let port = startPort;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.fastify.listen({ port, host });
        return `http://${host}:${port}`;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE') {
          port++;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Kein freier Port im Bereich ${startPort}-${startPort + maxAttempts}`);
  }

  async stop(): Promise<void> {
    await this.fastify.close();
  }
}
