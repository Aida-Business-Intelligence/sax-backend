import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

/**
 * POST /automations/seed — cria automações padrão (visitou 2x, clique WhatsApp) se não existirem.
 */
router.post('/seed', async (req, res, next) => {
  try {
    const existing = await prisma.automation.findFirst({ where: { triggerType: 'VIEW_PROPERTY_2X' } });
    if (existing) return res.json({ success: true, message: 'Automações padrão já existem' });

    await prisma.automation.create({
      data: {
        name: 'Visitou imóvel 2x → enviar mensagem',
        triggerType: 'VIEW_PROPERTY_2X',
        triggerConfig: { withinHours: 24, minViews: 2 },
        actionType: 'SEND_WHATSAPP',
        actionConfig: { message: 'Olá! Vimos que você se interessou por um imóvel. Posso ajudar?' },
        active: true,
      },
    });
    await prisma.automation.create({
      data: {
        name: 'Clicou WhatsApp → follow-up',
        triggerType: 'CLICK_WHATSAPP',
        triggerConfig: {},
        actionType: 'FOLLOW_UP',
        actionConfig: { message: 'Lembrete: lead demonstrou interesse por WhatsApp.' },
        active: true,
      },
    });
    return res.status(201).json({ success: true, message: 'Automações padrão criadas' });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /automations — lista automações (reimpacto).
 */
router.get('/', async (req, res, next) => {
  try {
    const model = prisma.automation;
    if (typeof model?.findMany !== 'function') return res.json([]);
    const list = await model.findMany({
      orderBy: { createdAt: 'desc' },
    });
    const formatted = list.map((a: {
      id: string;
      name: string;
      triggerType: string;
      triggerConfig: unknown;
      actionType: string;
      actionConfig: unknown;
      active: boolean;
      createdAt: Date;
      updatedAt: Date;
    }) => ({
      id: a.id,
      name: a.name,
      triggerType: a.triggerType,
      triggerConfig: a.triggerConfig,
      actionType: a.actionType,
      actionConfig: a.actionConfig,
      active: a.active,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    }));
    return res.json(formatted);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /automations — cria automação.
 */
router.post('/', async (req, res, next) => {
  try {
    const model = prisma.automation;
    if (typeof model?.create !== 'function') {
      return res.status(501).json({ success: false, message: 'Modelo não disponível' });
    }
    const { name, triggerType, triggerConfig, actionType, actionConfig, active } = req.body ?? {};
    if (!name || typeof name !== 'string' || !triggerType || !actionType) {
      return res.status(400).json({ success: false, message: 'name, triggerType e actionType obrigatórios' });
    }
    const created = await model.create({
      data: {
        name: String(name).slice(0, 256),
        triggerType: String(triggerType).slice(0, 64),
        triggerConfig: triggerConfig != null && typeof triggerConfig === 'object' ? triggerConfig : undefined,
        actionType: String(actionType).slice(0, 64),
        actionConfig: actionConfig != null && typeof actionConfig === 'object' ? actionConfig : undefined,
        active: active !== false,
      },
    });
    return res.status(201).json({
      id: created.id,
      name: created.name,
      triggerType: created.triggerType,
      triggerConfig: created.triggerConfig,
      actionType: created.actionType,
      actionConfig: created.actionConfig,
      active: created.active,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /automations/:id — atualiza automação.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const model = prisma.automation;
    if (typeof model?.update !== 'function') {
      return res.status(501).json({ success: false, message: 'Modelo não disponível' });
    }
    const { name, triggerType, triggerConfig, actionType, actionConfig, active } = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = String(name).slice(0, 256);
    if (triggerType !== undefined) data.triggerType = String(triggerType).slice(0, 64);
    if (triggerConfig !== undefined) data.triggerConfig = typeof triggerConfig === 'object' ? triggerConfig : undefined;
    if (actionType !== undefined) data.actionType = String(actionType).slice(0, 64);
    if (actionConfig !== undefined) data.actionConfig = typeof actionConfig === 'object' ? actionConfig : undefined;
    if (typeof active === 'boolean') data.active = active;
    const updated = await model.update({
      where: { id: req.params.id },
      data,
    });
    return res.json({
      id: updated.id,
      name: updated.name,
      triggerType: updated.triggerType,
      triggerConfig: updated.triggerConfig,
      actionType: updated.actionType,
      actionConfig: updated.actionConfig,
      active: updated.active,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /automations/:id — remove automação.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const model = prisma.automation;
    if (typeof model?.delete !== 'function') {
      return res.status(501).json({ success: false, message: 'Modelo não disponível' });
    }
    await model.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (e) {
    next(e);
  }
});

/**
 * GET /automations/queue — lista fila (pendentes primeiro).
 */
router.get('/queue', async (req, res, next) => {
  try {
    const model = prisma.automationQueue;
    const autoModel = prisma.automation;
    if (typeof model?.findMany !== 'function') return res.json([]);
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where: Record<string, unknown> = {};
    if (statusFilter && ['pending', 'sent', 'failed'].includes(statusFilter)) where.status = statusFilter;
    const list = await model.findMany({
      where,
      orderBy: [{ status: 'asc' }, { scheduledFor: 'desc' }],
      take: limit,
    });
    const automationIds = [...new Set(list.map((q: { automationId: string }) => q.automationId))];
    const automations = typeof autoModel?.findMany === 'function'
      ? await autoModel.findMany({ where: { id: { in: automationIds } } })
      : [];
    const autoMap = new Map(automations.map((a: { id: string; name: string }) => [a.id, a.name]));
    const formatted = list.map((q: {
      id: string;
      automationId: string;
      visitorId: string;
      leadId: string | null;
      payload: unknown;
      status: string;
      scheduledFor: Date;
      processedAt: Date | null;
      resultPayload: unknown;
      createdAt: Date;
    }) => ({
      id: q.id,
      automationId: q.automationId,
      automationName: autoMap.get(q.automationId) ?? '—',
      visitorId: q.visitorId,
      leadId: q.leadId,
      payload: q.payload,
      status: q.status,
      scheduledFor: q.scheduledFor.toISOString(),
      processedAt: q.processedAt?.toISOString() ?? null,
      resultPayload: q.resultPayload,
      createdAt: q.createdAt.toISOString(),
    }));
    return res.json(formatted);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /automations/queue/stats — totais para dashboard (pendentes, enviados, falhas).
 */
router.get('/queue/stats', async (req, res, next) => {
  try {
    const model = prisma.automationQueue;
    if (typeof model?.groupBy !== 'function') {
      return res.json({ pending: 0, sent: 0, failed: 0 });
    }
    const groups = await model.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const stats = { pending: 0, sent: 0, failed: 0 };
    for (const g of groups) {
      if (g.status === 'pending') stats.pending = g._count.status;
      if (g.status === 'sent') stats.sent = g._count.status;
      if (g.status === 'failed') stats.failed = g._count.status;
    }
    return res.json(stats);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /automations/queue/:id/process — processa item (stub WhatsApp: marca como enviado).
 * Quando integrar WhatsApp API de verdade, aqui envia a mensagem e grava resultPayload.
 */
router.post('/queue/:id/process', async (req, res, next) => {
  try {
    const model = prisma.automationQueue;
    if (typeof model?.update !== 'function') {
      return res.status(501).json({ success: false, message: 'Modelo não disponível' });
    }
    const id = req.params.id;
    const item = await model.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ success: false, message: 'Item não encontrado' });
    if ((item as { status: string }).status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Item já processado' });
    }
    const now = new Date();
    // Stub: simula envio; quando tiver WhatsApp API, enviar aqui e preencher resultPayload
    await model.update({
      where: { id },
      data: {
        status: 'sent',
        processedAt: now,
        resultPayload: { stub: true, processedAt: now.toISOString(), note: 'Integração WhatsApp em breve' },
      },
    });
    return res.json({ success: true, status: 'sent' });
  } catch (e) {
    next(e);
  }
});

export default router;
