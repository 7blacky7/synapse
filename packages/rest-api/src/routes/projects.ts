/**
 * Synapse API - Projects Routes
 */

import { FastifyInstance } from 'fastify';
import {
  getPool,
  ensureProjectCollection,
  startFileWatcher,
  handleFileEvent,
  verifyProjectAgainstFilesystem,
  createPlan,
  getPlan,
  updatePlan,
  addTask,
  updateTask,
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
    // Saubere, deduplizierte Projektnamen aus der projects-Tabelle
    // (NICHT Qdrant-Collection-Namen mit _code/_memories/_thoughts-Suffix)
    const pool = getPool();
    const { rows } = await pool.query<{ name: string }>(
      'SELECT DISTINCT name FROM projects ORDER BY name'
    );
    const projects = rows.map(r => r.name);

    return {
      success: true,
      projects,
      activeWatchers: Array.from(activeWatchers.keys()),
    };
  });

  /**
   * GET /api/projects/:name/tool-calls
   * Audit-Log aller verwendeten Synapse-Tools (projektspezifisch)
   */
  fastify.get<{ Params: { name: string }; Querystring: { limit?: string } }>(
    '/api/projects/:name/tool-calls',
    async (request) => {
      const { name } = request.params;
      const limit = Math.min(parseInt(request.query.limit ?? '100', 10) || 100, 500);
      const pool = getPool();
      const { rows } = await pool.query(
        'SELECT id, project, tool_name, action, source, args_preview, ok, ts FROM tool_calls WHERE project = $1 ORDER BY ts DESC LIMIT $2',
        [name, limit]
      );
      return { success: true, toolCalls: rows };
    }
  );

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
      onFileChange: (event) => handleFileEvent(event, projectPath),
      onError: (error) => {
        console.error(`[Synapse API] FileWatcher Fehler:`, error);
      },
      onReady: async () => {
        try {
          await verifyProjectAgainstFilesystem(name, projectPath);
        } catch (err) {
          console.error(`[Synapse API] Reconcile fehlgeschlagen:`, err);
        }
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

  /**
   * PATCH /api/projects/:name/plan/tasks/:taskId
   * Task aktualisieren (z.B. Status pflegen)
   */
  fastify.patch<{
    Params: { name: string; taskId: string };
    Body: {
      title?: string;
      description?: string;
      status?: 'todo' | 'in_progress' | 'done';
      priority?: 'low' | 'medium' | 'high';
    };
  }>('/api/projects/:name/plan/tasks/:taskId', async (request, reply) => {
    const { name, taskId } = request.params;
    const updates = request.body;

    const task = await updateTask(name, taskId, updates);

    if (!task) {
      return reply.status(404).send({
        success: false,
        error: { message: `Task nicht gefunden oder kein Plan fuer Projekt: ${name}` },
      });
    }

    return {
      success: true,
      task,
    };
  });
}

