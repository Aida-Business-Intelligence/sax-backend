import { prisma } from './prisma.js';

const VIEW_PROPERTY_2X_HOURS = 24;
const CLICK_WHATSAPP_DEBOUNCE_HOURS = 2;

/**
 * Após criar um evento de tracking, verifica automações ativas e enfileira ações.
 * - VIEW_PROPERTY: se visitante viu o mesmo imóvel >= 2x no período → enfileira VIEW_PROPERTY_2X
 * - CLICK_WHATSAPP: enfileira FOLLOW_UP (com debounce para não repetir em 2h)
 */
export async function enqueueFromEvent(
  visitorId: string,
  eventType: string,
  eventData: Record<string, unknown>
): Promise<void> {
  const automationModel = (prisma as any).automation;
  const queueModel = (prisma as any).automationQueue;
  const eventModel = (prisma as any).trackingEvent;

  if (
    typeof automationModel?.findMany !== 'function' ||
    typeof queueModel?.create !== 'function' ||
    typeof eventModel?.findMany !== 'function'
  ) {
    return;
  }

  const now = new Date();

  if (eventType === 'CLICK_WHATSAPP') {
    const automations = await automationModel.findMany({
      where: { active: true, triggerType: 'CLICK_WHATSAPP' },
    });
    const since = new Date(now.getTime() - CLICK_WHATSAPP_DEBOUNCE_HOURS * 60 * 60 * 1000);
    for (const auto of automations) {
      const existing = await queueModel.findFirst({
        where: {
          automationId: auto.id,
          visitorId,
          createdAt: { gte: since },
        },
      });
      if (existing) continue;
      await queueModel.create({
        data: {
          automationId: auto.id,
          visitorId,
          payload: { type: 'CLICK_WHATSAPP', ...eventData },
          status: 'pending',
          scheduledFor: now,
        },
      });
    }
    return;
  }

  if (eventType === 'VIEW_PROPERTY') {
    const slug = typeof eventData.slug === 'string' ? eventData.slug.trim() : '';
    if (!slug) return;

    const since = new Date(now.getTime() - VIEW_PROPERTY_2X_HOURS * 60 * 60 * 1000);
    const views = await eventModel.findMany({
      where: { visitorId, type: 'VIEW_PROPERTY', createdAt: { gte: since } },
    });
    const sameSlug = views.filter((e: { data?: unknown }) => (e.data as Record<string, unknown>)?.slug === slug);
    if (sameSlug.length < 2) return;

    const automations = await automationModel.findMany({
      where: { active: true, triggerType: 'VIEW_PROPERTY_2X' },
    });
    for (const auto of automations) {
      const existing = await queueModel.findMany({
        where: { automationId: auto.id, visitorId, createdAt: { gte: since } },
      });
      const alreadyQueued = existing.some(
        (q: { payload?: unknown }) => (q.payload as Record<string, unknown>)?.slug === slug
      );
      if (alreadyQueued) continue;
      if (existing) continue;
      await queueModel.create({
        data: {
          automationId: auto.id,
          visitorId,
          payload: { type: 'VIEW_PROPERTY_2X', slug, viewCount: sameSlug.length },
          status: 'pending',
          scheduledFor: now,
        },
      });
    }
  }
}
