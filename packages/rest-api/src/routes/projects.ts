/**
 * Synapse API - Projects Routes
 */

import { FastifyInstance } from 'fastify';
import {
  listCollections,
  ensureProjectCollection,
  startFileWatcher,
  handleFileEvent,
  createPlan,
  getPlan,
  updatePlan,
  addTask,
} from '@synapse/core';
import type { FileWatcherInstance } from '@synapse/core';

/** Aktive FileWatcher */
const activeWatchers = new Map<string, FileWatcherInstance>();

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects
   * Alle Projekte auflisten
   */
  fastify.get('/api/projects', async (request, reply) => {
    const collections = await listCollections();

    // Projekt-Collections filtern (project_*)
    const projects = collections
      .filter(c => c.startsWith('project_'))
      .map(c => c.replace('project_', ''));

    return {
      success: true,
      projects,
      activeWatchers: Array.from(activeWatchers.keys()),
    };
  });

  /**
   * POST /api/projects/init
   * Projekt initialisieren
   */
  fastify.post<{
    Body: { path: string; name?: string };
  }>('/api/projects/init', async (request, reply) => {
    const { path: projectPath, name: projectName } = request.body;

    if (!projectPath) {
      return reply.status(400).send({
        success: false,
        error: { message: 'path ist erforderlich' },
      });
    }

    const name = projectName || projectPath.split(/[/\\]/).pop() || 'unknown';

    // Pruefen ob schon aktiv
    if (activeWatchers.has(name)) {
      return {
        success: true,
        project: name,
        message: `Projekt "${name}" ist bereits aktiv`,
      };
    }

    // Collection erstellen
    await ensureProjectCollection(name);

    // Plan erstellen wenn nicht vorhanden
    const existingPlan = await getPlan(name);
    if (!existingPlan) {
      await createPlan(name, name, `Projekt-Plan fuer ${name}`, []);
    }

    // FileWatcher starten
    const watcher = startFileWatcher({
      projectPath,
      projectName: name,
      onFileChange: handleFileEvent,
      onError: (error) => {
        console.error(`[Synapse API] FileWatcher Fehler:`, error);
      },
    });

    activeWatchers.set(name, watcher);

    return {
      success: true,
      project: name,
      path: projectPath,
      message: `Projekt "${name}" initialisiert`,
    };
  });

  /**
   * GET /api/projects/:name/plan
   * Projekt-Plan abrufen
   */
  fastify.get<{
    Params: { name: string };
  }>('/api/projects/:name/plan', async (request, reply) => {
    const { name } = request.params;

    const plan = await getPlan(name);

    if (!plan) {
      return reply.status(404).send({
        success: false,
        error: { message: `Kein Plan gefunden fuer: ${name}` },
      });
    }

    return {
      success: true,
      plan,
    };
  });

  /**
   * PUT /api/projects/:name/plan
   * Projekt-Plan aktualisieren
   */
  fastify.put<{
    Params: { name: string };
    Body: {
      name?: string;
      description?: string;
      goals?: string[];
      architecture?: string;
    };
  }>('/api/projects/:name/plan', async (request, reply) => {
    const { name } = request.params;
    const updates = request.body;

    const plan = await updatePlan(name, updates);

    if (!plan) {
      return reply.status(404).send({
        success: false,
        error: { message: `Kein Plan gefunden fuer: ${name}` },
      });
    }

    return {
      success: true,
      plan,
    };
  });

  /**
   * POST /api/projects/:name/plan/tasks
   * Task hinzufuegen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      title: string;
      description: string;
      priority?: 'low' | 'medium' | 'high';
    };
  }>('/api/projects/:name/plan/tasks', async (request, reply) => {
    const { name } = request.params;
    const { title, description, priority } = request.body;

    if (!title || !description) {
      return reply.status(400).send({
        success: false,
        error: { message: 'title und description sind erforderlich' },
      });
    }

    const task = await addTask(name, title, description, priority);

    if (!task) {
      return reply.status(404).send({
        success: false,
        error: { message: `Kein Plan gefunden fuer: ${name}` },
      });
    }

    return {
      success: true,
      task,
    };
  });
}
