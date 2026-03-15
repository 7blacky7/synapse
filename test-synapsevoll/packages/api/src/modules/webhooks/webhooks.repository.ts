import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { webhooks, webhookDeliveries, type NewWebhook, type NewWebhookDelivery } from '../../db/schema.js';

export const webhooksRepository = {
  async create(userId: string, data: Omit<NewWebhook, 'userId'>) {
    const [result] = await db
      .insert(webhooks)
      .values({ ...data, userId })
      .returning();
    return result;
  },

  async findByUserId(userId: string) {
    return db.select().from(webhooks).where(eq(webhooks.userId, userId));
  },

  async findById(id: string, userId: string) {
    const [result] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));
    return result || null;
  },

  async update(id: string, userId: string, data: Partial<Omit<NewWebhook, 'userId'>>) {
    const [result] = await db
      .update(webhooks)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
      .returning();
    return result || null;
  },

  async delete(id: string, userId: string) {
    const [result] = await db
      .delete(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
      .returning();
    return result || null;
  },

  async createDelivery(data: NewWebhookDelivery) {
    const [result] = await db.insert(webhookDeliveries).values(data).returning();
    return result;
  },

  async findDeliveries(webhookId: string, limit = 50) {
    return db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);
  },

  async getLastDelivery(webhookId: string) {
    const [result] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(1);
    return result || null;
  },
};
