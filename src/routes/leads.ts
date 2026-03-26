import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { resolveDefaultWarehouseId } from '../lib/crm-lead-sync.js';
import { calculateVisitorIntentScore, getLeadTemperature } from '../lib/tracking-score.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

type CrmWhere = Record<string, unknown>;

function warehouseScope(warehouseId: string | null | undefined): CrmWhere {
  const w = warehouseId?.trim();
  if (!w) return {};
  return { warehouseId: w };
}

const crm = prisma as unknown as {
  crmLead: {
    count: (args: unknown) => Promise<number>;
    findMany: (args: unknown) => Promise<unknown[]>;
    findFirst: (args: unknown) => Promise<unknown>;
    create: (args: unknown) => Promise<{ id: string }>;
    update: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
};

const DEAL_STAGES = new Set(['prospeccao', 'proposta', 'negociacao', 'fechado_ganho', 'fechado_perdido']);
const INTERACTION_TYPES = new Set(['ligacao', 'email', 'reuniao', 'nota', 'whatsapp']);
const TASK_KINDS = new Set(['reuniao', 'ligacao', 'tarefa', 'visita', 'email']);

function dealToFrontend(d: {
  id: string;
  title: string;
  value: Prisma.Decimal | null;
  currency: string;
  stage: string;
  expectedCloseAt: Date | null;
  createdAt: Date;
  description: string | null;
  internalNotes: string | null;
  probability: number | null;
  transactionType: string | null;
  propertyRef: string | null;
  responsible: string | null;
  commissionPct: Prisma.Decimal | null;
  paymentMethod: string | null;
}) {
  return {
    id: d.id,
    titulo: d.title,
    valor: d.value != null ? Number(d.value) : 0,
    etapa: d.stage,
    data: (d.expectedCloseAt ?? d.createdAt).toISOString(),
    moeda: d.currency,
    probabilidade: d.probability ?? undefined,
    tipo_transacao: d.transactionType ?? undefined,
    propriedade_ref: d.propertyRef ?? undefined,
    responsavel: d.responsible ?? undefined,
    descricao: d.description ?? undefined,
    observacoes_internas: d.internalNotes ?? undefined,
    comissao_percentual:
      d.commissionPct != null && !Number.isNaN(Number(d.commissionPct)) ? String(d.commissionPct) : '',
    forma_pagamento: d.paymentMethod ?? '',
    data_prevista_fechamento: d.expectedCloseAt?.toISOString() ?? null,
  };
}

function interactionToFrontend(i: {
  id: string;
  type: string;
  title: string;
  description: string | null;
  authorName: string | null;
  createdAt: Date;
  createdBy: { name: string | null } | null;
}) {
  return {
    id: i.id,
    tipo: i.type,
    titulo: i.title,
    data: i.createdAt.toISOString(),
    autor: i.authorName || i.createdBy?.name || '-',
    descricao: i.description ?? '',
  };
}

function taskToFrontend(t: {
  id: string;
  title: string;
  kind: string;
  scheduledAt: Date;
  done: boolean;
  description: string | null;
  local: string | null;
  reminderMinutes: number | null;
  negocioRef: string | null;
}) {
  const full = t.description ?? '';
  const parts = full.split('\n\n');
  return {
    id: t.id,
    titulo: t.title,
    tipo: t.kind,
    data: t.scheduledAt.toISOString(),
    concluido: t.done,
    descricao: parts[0] ?? '',
    observacoes: parts.slice(1).join('\n\n') || '',
    lembrete_minutos: t.reminderMinutes,
    local: t.local ?? '',
    negocio_ref: t.negocioRef ?? '',
  };
}

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function toListRow(
  lead: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    cpf: string | null;
    pipelineStage: string;
    source: string;
    adTitle: string | null;
    adImageUrl: string | null;
    adLocation: string | null;
    score: number;
    lastInteractionAt: Date | null;
    assignedUser: { name: string | null } | null;
  }
) {
  return {
    id: lead.id,
    nome: lead.name ?? '-',
    name: lead.name,
    email: lead.email,
    status: lead.pipelineStage,
    origem: lead.source,
    cpf: lead.cpf,
    telefone: lead.phone,
    phone: lead.phone,
    anuncio: lead.adTitle ?? '-',
    anuncio_imagem: lead.adImageUrl,
    anuncio_local: lead.adLocation,
    score: lead.score,
    ultima_interacao: lead.lastInteractionAt?.toISOString() ?? null,
    responsavel: lead.assignedUser?.name ?? '-',
  };
}

/**
 * POST /api/leads/list/ — lista paginada (contrato do PDV).
 */
router.post('/list/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      page?: number;
      pageSize?: number;
      sortField?: string;
      sortOrder?: string;
      search?: string;
      origem?: string;
      status?: string;
      tipo_imovel?: string;
      tipo_transacao?: string;
      warehouse_id?: string;
      /** Quando true, só leads atribuídos ao usuário logado (permissão “apenas os meus”). */
      only_own?: boolean | string;
    };

    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 25));
    const skip = (page - 1) * pageSize;

    const wh = body.warehouse_id || user.warehouseId || undefined;
    const where: CrmWhere = {
      ...warehouseScope(wh),
    };

    const onlyOwn = body.only_own === true || body.only_own === '1' || body.only_own === 'true';
    if (onlyOwn) {
      where.assignedUserId = user.id;
    }

    if (body.origem?.trim()) {
      where.source = body.origem.trim();
    }
    if (body.status?.trim()) {
      where.pipelineStage = body.status.trim();
    }
    if (body.tipo_imovel?.trim()) {
      where.interestPropertyType = body.tipo_imovel.trim();
    }
    if (body.tipo_transacao?.trim()) {
      where.interestTransactionType = body.tipo_transacao.trim();
    }

    const search = body.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const sortField = body.sortField || 'createdAt';
    const sortDir = body.sortOrder?.toUpperCase() === 'ASC' ? 'asc' : 'desc';
    const orderBy: Record<string, string> =
      sortField === 'nome' || sortField === 'name'
        ? { name: sortDir }
        : sortField === 'score'
          ? { score: sortDir }
          : sortField === 'ultima_interacao'
            ? { lastInteractionAt: sortDir }
            : { createdAt: sortDir };

    const [total, rows] = await Promise.all([
      crm.crmLead.count({ where }),
      crm.crmLead.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
        include: { assignedUser: { select: { name: true } } },
      }),
    ]);

    res.json({
      status: true,
      data: rows.map((r) => toListRow(r as Parameters<typeof toListRow>[0])),
      total,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/leads/get/:id/ — ficha + pipeline (negócios, interações, eventos/tarefas) + score de intenção do tracking.
 */
router.get('/get/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    const lead = await prisma.crmLead.findFirst({
      where: { id, ...warehouseScope(wh) },
      include: {
        assignedUser: { select: { id: true, name: true, email: true } },
        deals: { orderBy: { createdAt: 'desc' } },
        interactions: {
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { name: true } } },
        },
        tasks: { orderBy: { scheduledAt: 'desc' } },
      },
    });

    if (!lead) {
      res.status(404).json({ success: false, message: 'Lead não encontrado' });
      return;
    }

    let sourceDetail: Record<string, unknown> | null = null;
    if (lead.sourceDetail) {
      try {
        sourceDetail = JSON.parse(lead.sourceDetail) as Record<string, unknown>;
      } catch {
        sourceDetail = null;
      }
    }

    let scoreIntent = lead.score;
    let temperature = getLeadTemperature(scoreIntent);
    let scoreSource: 'tracking' | 'crm' = 'crm';

    if (lead.trackingVisitorId) {
      scoreIntent = await calculateVisitorIntentScore(lead.trackingVisitorId);
      temperature = getLeadTemperature(scoreIntent);
      scoreSource = 'tracking';
      if (scoreIntent !== lead.score) {
        await prisma.crmLead.update({ where: { id: lead.id }, data: { score: scoreIntent } }).catch(() => {});
      }
    }

    const trackLead = lead.trackingVisitorId
      ? await prisma.lead.findUnique({
          where: { visitorId: lead.trackingVisitorId },
          select: { lastActivityAt: true },
        })
      : null;

    const lastTrackingEventAt = lead.trackingVisitorId
      ? await prisma.trackingEvent.findFirst({
          where: { visitorId: lead.trackingVisitorId },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
      : null;

    const ultima = maxDate([
      lead.lastInteractionAt,
      trackLead?.lastActivityAt,
      lead.interactions[0]?.createdAt,
      lead.tasks[0]?.updatedAt,
      lastTrackingEventAt?.createdAt,
    ]);

    res.json({
      data: {
        id: lead.id,
        nome: lead.name ?? '',
        name: lead.name,
        email: lead.email ?? '',
        telefone: lead.phone ?? '',
        cpf: lead.cpf ?? '',
        status: lead.pipelineStage,
        origem: lead.source,
        anuncio: lead.adTitle ?? '',
        anuncio_imagem: lead.adImageUrl,
        anuncio_local: lead.adLocation,
        score: scoreIntent,
        score_source: scoreSource,
        temperature,
        ultima_interacao: ultima?.toISOString() ?? lead.lastInteractionAt?.toISOString() ?? null,
        responsavel: lead.assignedUser?.name ?? '',
        observacoes: lead.notes ?? '',
        sourceDetail,
        metaLeadId: lead.metaLeadId,
        metaFormId: lead.metaFormId,
        negocios: lead.deals.map(dealToFrontend),
        interacoes: lead.interactions.map(interactionToFrontend),
        eventos: lead.tasks.map(taskToFrontend),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/create/
 */
router.post('/create/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      nome?: string;
      name?: string;
      email?: string;
      telefone?: string;
      cpf?: string;
      status?: string;
      origem?: string;
      anuncio?: string;
      score?: number | null;
      observacoes?: string;
      warehouse_id?: string;
    };

    const warehouseId = body.warehouse_id || user.warehouseId || (await resolveDefaultWarehouseId());

    const lead = await crm.crmLead.create({
      data: {
        warehouseId,
        name: (body.nome || body.name || '').trim() || null,
        email: body.email?.trim() || null,
        phone: body.telefone?.trim() || null,
        cpf: body.cpf?.trim() || null,
        pipelineStage: body.status?.trim() || 'novo',
        source: body.origem?.trim() || 'manual',
        adTitle: body.anuncio?.trim() || null,
        score: typeof body.score === 'number' && Number.isFinite(body.score) ? Math.round(body.score) : 0,
        notes: body.observacoes?.trim() || null,
        lastInteractionAt: new Date(),
      },
    });

    res.status(201).json({ success: true, data: { id: lead.id } });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/update/:id/
 */
router.put('/update/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    const existing = (await crm.crmLead.findFirst({
      where: { id, ...warehouseScope(wh) },
    })) as { id: string; pipelineStage: string; source: string } | null;
    if (!existing) {
      res.status(404).json({ success: false, message: 'Lead não encontrado' });
      return;
    }

    const body = req.body as {
      nome?: string;
      name?: string;
      email?: string;
      telefone?: string;
      cpf?: string;
      status?: string;
      origem?: string;
      anuncio?: string;
      score?: number | null;
      observacoes?: string;
    };

    await crm.crmLead.update({
      where: { id },
      data: {
        name: body.nome !== undefined || body.name !== undefined ? (body.nome || body.name || '').trim() || null : undefined,
        email: body.email !== undefined ? body.email?.trim() || null : undefined,
        phone: body.telefone !== undefined ? body.telefone?.trim() || null : undefined,
        cpf: body.cpf !== undefined ? body.cpf?.trim() || null : undefined,
        pipelineStage: body.status !== undefined ? body.status?.trim() || existing.pipelineStage : undefined,
        source: body.origem !== undefined ? body.origem?.trim() || existing.source : undefined,
        adTitle: body.anuncio !== undefined ? body.anuncio?.trim() || null : undefined,
        score:
          body.score !== undefined &&
          body.score !== null &&
          String(body.score).trim() !== '' &&
          Number.isFinite(Number(body.score))
            ? Math.round(Number(body.score))
            : undefined,
        notes: body.observacoes !== undefined ? body.observacoes?.trim() || null : undefined,
        lastInteractionAt: new Date(),
      },
    });

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/remove/
 */
router.post('/remove/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { rows?: string[]; warehouse_id?: string };
    const ids = Array.isArray(body.rows) ? body.rows.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, message: 'Nenhum id informado' });
      return;
    }

    const wh = body.warehouse_id || user.warehouseId || undefined;
    const where: CrmWhere = {
      id: { in: ids },
      ...warehouseScope(wh),
    };

    await crm.crmLead.deleteMany({ where });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

async function assertCrmLeadAccess(leadId: string, warehouseId: string | null | undefined) {
  return prisma.crmLead.findFirst({
    where: { id: leadId, ...warehouseScope(warehouseId || undefined) },
  });
}

/**
 * POST /api/leads/deal/create/
 */
router.post('/deal/create/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      lead_id?: string;
      titulo?: string;
      valor?: number | string;
      moeda?: string;
      etapa?: string;
      data_prevista_fechamento?: string | null;
      tipo_transacao?: string;
      propriedade_ref?: string;
      responsavel?: string;
      descricao?: string;
      observacoes_internas?: string;
      comissao_percentual?: number | string;
      forma_pagamento?: string;
      probabilidade?: number;
    };

    const leadId = String(body.lead_id || '').trim();
    if (!leadId) {
      res.status(400).json({ success: false, message: 'lead_id obrigatório' });
      return;
    }

    const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
    if (!lead) {
      res.status(404).json({ success: false, message: 'Lead não encontrado' });
      return;
    }

    const titulo = String(body.titulo || '').trim();
    if (!titulo) {
      res.status(400).json({ success: false, message: 'Título obrigatório' });
      return;
    }

    const etapa = DEAL_STAGES.has(String(body.etapa)) ? String(body.etapa) : 'prospeccao';
    const valorRaw = body.valor != null && String(body.valor) !== '';
    const valor = valorRaw ? new Prisma.Decimal(String(body.valor)) : null;
    const expectedClose = body.data_prevista_fechamento
      ? new Date(body.data_prevista_fechamento)
      : null;
    const commission =
      body.comissao_percentual != null && String(body.comissao_percentual).trim() !== ''
        ? new Prisma.Decimal(String(body.comissao_percentual))
        : null;

    const deal = await prisma.crmLeadDeal.create({
      data: {
        crmLeadId: leadId,
        title: titulo,
        value: valor,
        currency: (body.moeda || 'BRL').trim() || 'BRL',
        stage: etapa,
        expectedCloseAt:
          expectedClose && !Number.isNaN(expectedClose.getTime()) ? expectedClose : null,
        transactionType: body.tipo_transacao?.trim() || null,
        propertyRef: body.propriedade_ref?.trim() || null,
        responsible: body.responsavel?.trim() || null,
        description: body.descricao?.trim() || null,
        internalNotes: body.observacoes_internas?.trim() || null,
        probability:
          typeof body.probabilidade === 'number'
            ? Math.min(100, Math.max(0, Math.round(body.probabilidade)))
            : null,
        commissionPct: commission,
        paymentMethod: body.forma_pagamento?.trim() || null,
      },
    });

    await prisma.crmLead.update({
      where: { id: leadId },
      data: { lastInteractionAt: new Date() },
    });

    res.status(201).json({ success: true, data: dealToFrontend(deal) });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/deal/update/:id/
 */
router.put('/deal/update/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const dealId = req.params.id;

    const existing = await prisma.crmLeadDeal.findFirst({
      where: { id: dealId },
      include: { crmLead: { select: { id: true, warehouseId: true } } },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Negócio não encontrado' });
      return;
    }

    const ok = await assertCrmLeadAccess(existing.crmLead.id, user.warehouseId);
    if (!ok) {
      res.status(404).json({ success: false, message: 'Negócio não encontrado' });
      return;
    }

    const body = req.body as {
      titulo?: string;
      valor?: number | string;
      moeda?: string;
      etapa?: string;
      data_prevista_fechamento?: string | null;
      tipo_transacao?: string;
      propriedade_ref?: string;
      responsavel?: string;
      descricao?: string;
      observacoes_internas?: string;
      comissao_percentual?: number | string;
      forma_pagamento?: string;
      probabilidade?: number;
    };

    const data: Prisma.CrmLeadDealUpdateInput = {};

    if (body.titulo !== undefined) data.title = String(body.titulo || '').trim() || existing.title;
    if (body.etapa !== undefined) {
      data.stage = DEAL_STAGES.has(String(body.etapa)) ? String(body.etapa) : existing.stage;
    }
    if (body.valor !== undefined) {
      data.value =
        body.valor != null && String(body.valor) !== ''
          ? new Prisma.Decimal(String(body.valor))
          : null;
    }
    if (body.moeda !== undefined) data.currency = String(body.moeda || 'BRL').trim() || 'BRL';
    if (body.data_prevista_fechamento !== undefined) {
      const d = body.data_prevista_fechamento ? new Date(body.data_prevista_fechamento) : null;
      data.expectedCloseAt = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (body.tipo_transacao !== undefined) data.transactionType = body.tipo_transacao?.trim() || null;
    if (body.propriedade_ref !== undefined) data.propertyRef = body.propriedade_ref?.trim() || null;
    if (body.responsavel !== undefined) data.responsible = body.responsavel?.trim() || null;
    if (body.descricao !== undefined) data.description = body.descricao?.trim() || null;
    if (body.observacoes_internas !== undefined)
      data.internalNotes = body.observacoes_internas?.trim() || null;
    if (body.forma_pagamento !== undefined)
      data.paymentMethod = body.forma_pagamento?.trim() || null;
    if (body.probabilidade !== undefined) {
      data.probability =
        typeof body.probabilidade === 'number'
          ? Math.min(100, Math.max(0, Math.round(body.probabilidade)))
          : null;
    }
    if (body.comissao_percentual !== undefined) {
      data.commissionPct =
        body.comissao_percentual != null && String(body.comissao_percentual).trim() !== ''
          ? new Prisma.Decimal(String(body.comissao_percentual))
          : null;
    }

    const updated = await prisma.crmLeadDeal.update({
      where: { id: dealId },
      data,
    });

    await prisma.crmLead.update({
      where: { id: existing.crmLead.id },
      data: { lastInteractionAt: new Date() },
    });

    res.json({ success: true, data: dealToFrontend(updated) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/interaction/create/
 */
router.post('/interaction/create/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { lead_id?: string; tipo?: string; titulo?: string; descricao?: string };

    const leadId = String(body.lead_id || '').trim();
    if (!leadId) {
      res.status(400).json({ success: false, message: 'lead_id obrigatório' });
      return;
    }

    const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
    if (!lead) {
      res.status(404).json({ success: false, message: 'Lead não encontrado' });
      return;
    }

    const titulo = String(body.titulo || '').trim();
    if (!titulo) {
      res.status(400).json({ success: false, message: 'Título obrigatório' });
      return;
    }

    const tipo = INTERACTION_TYPES.has(String(body.tipo)) ? String(body.tipo) : 'nota';
    const author = await prisma.user.findUnique({
      where: { id: user.id },
      select: { name: true },
    });

    const row = await prisma.crmLeadInteraction.create({
      data: {
        crmLeadId: leadId,
        type: tipo,
        title: titulo,
        description: body.descricao?.trim() || null,
        authorName: author?.name ?? null,
        createdByUserId: user.id,
      },
      include: { createdBy: { select: { name: true } } },
    });

    await prisma.crmLead.update({
      where: { id: leadId },
      data: { lastInteractionAt: new Date() },
    });

    res.status(201).json({ success: true, data: interactionToFrontend(row) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/task/create/
 */
router.post('/task/create/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      lead_id?: string;
      titulo?: string;
      tipo?: string;
      data_hora?: string;
      descricao?: string;
      observacoes?: string;
      lembrete_minutos?: number | string | null;
      local?: string;
      negocio_ref?: string;
    };

    const leadId = String(body.lead_id || '').trim();
    if (!leadId) {
      res.status(400).json({ success: false, message: 'lead_id obrigatório' });
      return;
    }

    const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
    if (!lead) {
      res.status(404).json({ success: false, message: 'Lead não encontrado' });
      return;
    }

    const titulo = String(body.titulo || '').trim();
    if (!titulo) {
      res.status(400).json({ success: false, message: 'Título obrigatório' });
      return;
    }

    const kind = TASK_KINDS.has(String(body.tipo)) ? String(body.tipo) : 'reuniao';
    const scheduledAt = body.data_hora ? new Date(body.data_hora) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) {
      res.status(400).json({ success: false, message: 'Data/hora inválida' });
      return;
    }

    const reminder =
      body.lembrete_minutos != null && String(body.lembrete_minutos) !== ''
        ? Math.max(0, Math.round(Number(body.lembrete_minutos)))
        : null;

    const descParts = [body.descricao?.trim(), body.observacoes?.trim()].filter(Boolean);
    const description = descParts.length ? descParts.join('\n\n') : null;

    const task = await prisma.crmLeadTask.create({
      data: {
        crmLeadId: leadId,
        title: titulo,
        kind,
        scheduledAt,
        description,
        local: body.local?.trim() || null,
        reminderMinutes: reminder,
        negocioRef: body.negocio_ref?.trim() || null,
      },
    });

    await prisma.crmLead.update({
      where: { id: leadId },
      data: { lastInteractionAt: new Date() },
    });

    res.status(201).json({ success: true, data: taskToFrontend(task) });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/task/update/:id/
 */
router.put('/task/update/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const taskId = req.params.id;

    const existing = await prisma.crmLeadTask.findFirst({
      where: { id: taskId },
      include: { crmLead: { select: { id: true } } },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Evento não encontrado' });
      return;
    }

    const ok = await assertCrmLeadAccess(existing.crmLead.id, user.warehouseId);
    if (!ok) {
      res.status(404).json({ success: false, message: 'Evento não encontrado' });
      return;
    }

    const body = req.body as {
      titulo?: string;
      tipo?: string;
      data_hora?: string;
      descricao?: string;
      observacoes?: string;
      lembrete_minutos?: number | string | null;
      local?: string;
      negocio_ref?: string;
      concluido?: boolean;
    };

    const data: Prisma.CrmLeadTaskUpdateInput = {};

    if (body.titulo !== undefined) data.title = String(body.titulo || '').trim() || existing.title;
    if (body.tipo !== undefined) {
      data.kind = TASK_KINDS.has(String(body.tipo)) ? String(body.tipo) : existing.kind;
    }
    if (body.data_hora !== undefined) {
      const d = new Date(body.data_hora);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ success: false, message: 'Data/hora inválida' });
        return;
      }
      data.scheduledAt = d;
    }
    if (body.local !== undefined) data.local = body.local?.trim() || null;
    if (body.negocio_ref !== undefined) data.negocioRef = body.negocio_ref?.trim() || null;
    if (body.concluido !== undefined) data.done = Boolean(body.concluido);
    if (body.lembrete_minutos !== undefined) {
      data.reminderMinutes =
        body.lembrete_minutos != null && String(body.lembrete_minutos) !== ''
          ? Math.max(0, Math.round(Number(body.lembrete_minutos)))
          : null;
    }
    if (body.descricao !== undefined || body.observacoes !== undefined) {
      const prev = (existing.description || '').split('\n\n');
      const d =
        body.descricao !== undefined ? String(body.descricao || '').trim() : prev[0] ?? '';
      const o =
        body.observacoes !== undefined
          ? String(body.observacoes || '').trim()
          : prev.slice(1).join('\n\n');
      data.description = [d, o].filter(Boolean).join('\n\n') || null;
    }

    const updated = await prisma.crmLeadTask.update({
      where: { id: taskId },
      data,
    });

    await prisma.crmLead.update({
      where: { id: existing.crmLead.id },
      data: { lastInteractionAt: new Date() },
    });

    res.json({ success: true, data: taskToFrontend(updated) });
  } catch (e) {
    next(e);
  }
});

export default router;
