import { createHash, randomBytes } from 'crypto';
import { webhooksRepository } from './webhooks.repository.js';
import { type Webhook, type NewWebhookDelivery } from '../../db/schema.js';

interface GeneratedSecret {
  secret: string;
  secretPrefix: string;
}

function generateSecret(): GeneratedSecret {
  const raw = randomBytes(32).toString('hex');
  const secret = `whk-vel-${raw}`;
  const secretPrefix = `whk-vel-${raw.slice(0, 4)}...${raw.slice(-4)}`;
  return { secret, secretPrefix };
}

export const webhooksService = {
  generateSecret() {
    return generateSecret();
  },

  async createWebhook(userId: string, url: string, events: string[]) {
    const { secret } = generateSecret();
    const webhook = await webhooksRepository.create(userId, {
      url,
      secret,
      events,
      active: true,
    });
    return webhook;
  },

  async listWebhooks(userId: string) {
    return webhooksRepository.findByUserId(userId);
  },

  async getWebhook(id: string, userId: string) {
    return webhooksRepository.findById(id, userId);
  },

  async updateWebhook(
    id: string,
    userId: string,
    data: {
      url?: string;
      events?: string[];
      active?: boolean;
    }
  ) {
    const webhook = await webhooksRepository.findById(id, userId);
    if (!webhook) return null;

    return webhooksRepository.update(id, userId, {
      url: data.url ?? webhook.url,
      events: data.events ?? webhook.events,
      active: data.active !== undefined ? data.active : webhook.active,
    });
  },

  async deleteWebhook(id: string, userId: string) {
    return webhooksRepository.delete(id, userId);
  },

  async toggleWebhook(id: string, userId: string, active: boolean) {
    return webhooksRepository.update(id, userId, { active });
  },

  async recordDelivery(
    webhookId: string,
    event: string,
    statusCode: number | null,
    success: boolean,
    requestBody: string,
    responseBody: string | null,
    duration: number
  ) {
    return webhooksRepository.createDelivery({
      webhookId,
      event,
      statusCode,
      success,
      requestBody,
      responseBody,
      duration,
    });
  },

  async getDeliveries(webhookId: string, userId: string, limit = 50) {
    const webhook = await webhooksRepository.findById(webhookId, userId);
    if (!webhook) return null;

    return webhooksRepository.findDeliveries(webhookId, limit);
  },

  async testWebhook(webhookId: string, userId: string) {
    const webhook = await webhooksRepository.findById(webhookId, userId);
    if (!webhook) throw new Error('Webhook not found');

    const testPayload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'Test delivery from Velocity' },
    };

    const requestBody = JSON.stringify(testPayload);
    const startTime = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let success = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': this.signPayload(requestBody, webhook.secret),
        },
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      statusCode = response.status;
      responseBody = await response.text();
      success = response.ok;
    } catch (error) {
      responseBody = error instanceof Error ? error.message : 'Unknown error';
    }

    const duration = Date.now() - startTime;

    await webhooksRepository.createDelivery({
      webhookId,
      event: 'test',
      statusCode,
      success,
      requestBody,
      responseBody,
      duration,
    });

    return { statusCode, success, duration };
  },

  signPayload(payload: string, secret: string): string {
    return createHash('sha256')
      .update(payload + secret)
      .digest('hex');
  },

  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expectedSignature = this.signPayload(payload, secret);
    return signature === expectedSignature;
  },
};
