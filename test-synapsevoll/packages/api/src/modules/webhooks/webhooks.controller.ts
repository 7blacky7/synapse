import type { FastifyInstance } from 'fastify';
import { webhooksService } from './webhooks.service.js';
import { authGuard } from '../../middleware/auth.js';

export async function webhooksRoutes(app: FastifyInstance) {
  // Alle Routes brauchen Auth
  app.addHook('preHandler', authGuard);

  // POST /api/webhooks — Neuen Webhook erstellen
  app.post('/api/webhooks', async (request, reply) => {
    const { url, events } = request.body as { url?: string; events?: string[] };

    if (!url || typeof url !== 'string' || url.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_URL', message: 'Webhook URL is required' },
      });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_EVENTS', message: 'At least one event is required' },
      });
    }

    const validEvents = ['project.created', 'project.updated', 'deployment.started', 'deployment.completed', 'team.member_added', 'api_key.created'];
    const invalidEvents = events.filter((e) => !validEvents.includes(e));
    if (invalidEvents.length > 0) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_EVENTS', message: `Invalid events: ${invalidEvents.join(', ')}` },
      });
    }

    const webhook = await webhooksService.createWebhook(request.userId!, url.trim(), events);
    const { secret, secretPrefix } = webhooksService.generateSecret();

    return {
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        secret: webhook.secret, // Zeige das Secret nur einmal beim Erstellen
        createdAt: webhook.createdAt,
      },
    };
  });

  // GET /api/webhooks — Alle Webhooks listen
  app.get('/api/webhooks', async (request) => {
    const webhooksData = await webhooksService.listWebhooks(request.userId!);
    return {
      success: true,
      data: webhooksData.map((w: any) => ({
        id: w.id,
        url: w.url,
        events: w.events,
        active: w.active,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
    };
  });

  // GET /api/webhooks/:id — Ein Webhook abrufen
  app.get('/api/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const webhook = await webhooksService.getWebhook(id, request.userId!);
    if (!webhook) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
      });
    }

    return {
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
      },
    };
  });

  // PATCH /api/webhooks/:id — Webhook updaten
  app.patch('/api/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { url, events, active } = request.body as { url?: string; events?: string[]; active?: boolean };

    const webhook = await webhooksService.updateWebhook(id, request.userId!, {
      url,
      events,
      active,
    });

    if (!webhook) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
      });
    }

    return {
      success: true,
      data: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        active: webhook.active,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
      },
    };
  });

  // DELETE /api/webhooks/:id — Webhook löschen
  app.delete('/api/webhooks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await webhooksService.deleteWebhook(id, request.userId!);
    if (!deleted) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
      });
    }

    return { success: true, data: deleted };
  });

  // POST /api/webhooks/:id/test — Test-Delivery senden
  app.post('/api/webhooks/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = await webhooksService.testWebhook(id, request.userId!);
      return {
        success: true,
        data: {
          statusCode: result.statusCode,
          success: result.success,
          duration: result.duration,
        },
      };
    } catch (error) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
      });
    }
  });

  // GET /api/webhooks/:id/deliveries — Delivery-Log
  app.get('/api/webhooks/:id/deliveries', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { limit = '50' } = request.query as { limit?: string };

    const deliveries = await webhooksService.getDeliveries(id, request.userId!, parseInt(limit));
    if (deliveries === null) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Webhook not found' },
      });
    }

    return {
      success: true,
      data: deliveries,
    };
  });
}
