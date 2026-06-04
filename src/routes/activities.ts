import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function leadWarehouseWhere(warehouseId: string | null | undefined): Prisma.CrmLeadWhereInput {
  const w = warehouseId?.trim();
  if (!w) return {};
  return { warehouseId: w };
}

/** Status esperado pelo PDV (ActivityListTable, Kanban, etc.). */
function deriveActivityStatus(done: boolean, scheduledAt: Date): string {
  if (done) return 'concluido';
  if (scheduledAt.getTime() < Date.now()) return 'atrasado';
  return 'pendente';
}

/**
 * Eventos/tarefas do pipeline (CrmLeadTask) → formato da tela /activities.
 */
function taskToActivityRow(task: {
  id: string;
  title: string;
  kind: string;
  scheduledAt: Date;
  done: boolean;
  description: string | null;
  negocioRef: string | null;
  crmLeadId: string;
  crmLead: {
    id: string;
    name: string | null;
    assignedUser: { name: string | null } | null;
  };
}) {
  const full = task.description ?? '';
  const parts = full.split('\n\n');
  const desc = parts[0]?.trim() || '';
  const obsExtra = parts.slice(1).join('\n\n').trim();
  const observacoes = [task.title, desc, obsExtra].filter(Boolean).join(' — ');

  return {
    id: task.id,
    titulo: task.title,
    tipo: task.kind,
    data: task.scheduledAt.toISOString(),
    lead_id: task.crmLeadId,
    lead_nome: task.crmLead.name ?? '-',
    responsavel: task.crmLead.assignedUser?.name?.trim() || '-',
    status: deriveActivityStatus(task.done, task.scheduledAt),
    resultado: '',
    observacoes,
    negocio_ref: task.negocioRef ?? null,
    negocio_id: null,
    concluido: task.done,
  };
}

/**
 * POST /api/activities/list/ — mesmas entidades da aba Eventos em /leads/pipeline (crm_lead_tasks).
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

    const leadWhere: Prisma.CrmLeadWhereInput = {
      ...leadWarehouseWhere(wh),
    };
    if (onlyOwn) leadWhere.assignedUserId = user.id;

    const search = body.search?.trim();

    const where: Prisma.CrmLeadTaskWhereInput =
      search && search.length > 0
        ? {
            AND: [
              { crmLead: leadWhere },
              {
                OR: [
                  { title: { contains: search, mode: 'insensitive' } },
                  { description: { contains: search, mode: 'insensitive' } },
                  { kind: { contains: search, mode: 'insensitive' } },
                  { crmLead: { name: { contains: search, mode: 'insensitive' } } },
                  { crmLead: { assignedUser: { name: { contains: search, mode: 'insensitive' } } } },
                ],
              },
            ],
          }
        : { crmLead: leadWhere };

    const [total, rows] = await Promise.all([
      prisma.crmLeadTask.count({ where }),
      prisma.crmLeadTask.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
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
      data: rows.map(taskToActivityRow),
      total,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
