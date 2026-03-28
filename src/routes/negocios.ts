import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  CRM_DEAL_PROPERTY_SELECT,
  dealToFrontend,
  ensureDealPipelineKanbanStateIfWon,
} from './leads.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function dealToListRow(deal: {
  id: string;
  title: string;
  value: Prisma.Decimal | null;
  stage: string;
  expectedCloseAt: Date | null;
  createdAt: Date;
  responsible: string | null;
  crmLeadId: string;
  crmLead: {
    id: string;
    name: string | null;
    assignedUser: { name: string | null } | null;
  };
}) {
  const nomeCorretor = deal.crmLead.assignedUser?.name?.trim() || '';
  const respNegocio = deal.responsible?.trim() || '';
  return {
    id: deal.id,
    titulo: deal.title,
    valor: deal.value != null ? Number(deal.value) : 0,
    etapa: deal.stage,
    data: (deal.expectedCloseAt ?? deal.createdAt).toISOString(),
    lead_id: deal.crmLeadId,
    lead_nome: deal.crmLead.name ?? '-',
    responsavel: respNegocio || nomeCorretor || '-',
  };
}

/**
 * POST /api/negocios/list/ — negócios (deals) por imobiliária; com only_own só os do lead atribuído ao usuário (corretor).
 */
router.post('/list/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      page?: number;
      pageSize?: number;
      search?: string;
      warehouse_id?: string;
      only_own?: boolean | string;
    };

    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 25));
    const skip = (page - 1) * pageSize;

    const wh = body.warehouse_id || user.warehouseId || undefined;
    const onlyOwn = body.only_own === true || body.only_own === '1' || body.only_own === 'true';

    const leadWhere: Prisma.CrmLeadWhereInput = {};
    if (wh) leadWhere.warehouseId = wh;
    if (onlyOwn) leadWhere.assignedUserId = user.id;

    const search = body.search?.trim();

    const where: Prisma.CrmLeadDealWhereInput =
      search && search.length > 0
        ? {
            AND: [
              { crmLead: leadWhere },
              {
                OR: [
                  { title: { contains: search, mode: 'insensitive' } },
                  { responsible: { contains: search, mode: 'insensitive' } },
                  { crmLead: { name: { contains: search, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : { crmLead: leadWhere };

    const [total, rows] = await Promise.all([
      prisma.crmLeadDeal.count({ where }),
      prisma.crmLeadDeal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          crmLead: {
            select: {
              id: true,
              name: true,
              assignedUser: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    res.json({
      status: true,
      data: rows.map(dealToListRow),
      total,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/negocios/get/:id/ — detalhe do negócio (deal) por ID + lead resumido (URL única).
 */
router.get('/get/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const dealId = String(req.params.id || '').trim();
    if (!dealId) {
      res.status(400).json({ success: false, message: 'ID obrigatório' });
      return;
    }

    const deal = await prisma.crmLeadDeal.findFirst({
      where: { id: dealId },
      include: {
        crmLead: {
          select: {
            id: true,
            name: true,
            warehouseId: true,
          },
        },
        property: { select: CRM_DEAL_PROPERTY_SELECT },
      },
    });

    if (!deal) {
      res.status(404).json({ success: false, message: 'Negócio não encontrado' });
      return;
    }

    const wh = user.warehouseId?.trim();
    if (wh && deal.crmLead.warehouseId !== wh) {
      res.status(404).json({ success: false, message: 'Negócio não encontrado' });
      return;
    }

    await ensureDealPipelineKanbanStateIfWon(deal);

    res.json({
      status: true,
      data: {
        negocio: dealToFrontend(deal),
        lead: {
          id: deal.crmLead.id,
          nome: deal.crmLead.name ?? '',
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
