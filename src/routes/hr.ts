import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function warehouseScope(warehouseId: string | null | undefined): Record<string, unknown> {
  const w = warehouseId?.trim();
  if (!w) return {};
  return { warehouseId: w };
}

/**
 * Prisma Client só inclui `hrEmployee` após `npx prisma generate` (e migration aplicada).
 * Sem isso, `prisma.hrEmployee` é undefined e `.count` quebra.
 */
function getHrEmployeeDelegate(): typeof prisma.hrEmployee {
  const hr = (prisma as { hrEmployee?: typeof prisma.hrEmployee }).hrEmployee;
  if (!hr || typeof (hr as { count?: unknown }).count !== 'function') {
    const err = new Error(
      'Módulo RH indisponível: no servidor sax-backend execute `npx prisma generate`, aplique migrations se necessário e reinicie o API (feche processos que travem o query_engine no Windows).'
    );
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
  return hr;
}

const EMPLOYMENT_TYPES = new Set(['commission_only', 'fixed_plus_commission', 'fixed_only']);
const DEPARTMENTS = new Set([
  'comercial',
  'financeiro',
  'administrativo',
  'marketing',
  'secretaria',
  'rh',
  'outros',
]);

function toRow(e: {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  employmentType: string;
  departmentCode: string;
  isPartnerBroker: boolean;
  baseSalaryMonthly: Prisma.Decimal | null;
  status: string;
  userId: string | null;
  hiredAt: Date | null;
  createdAt: Date;
  user: { email: string; name: string | null } | null;
}) {
  return {
    id: e.id,
    nome: e.fullName,
    full_name: e.fullName,
    email: e.email,
    phone: e.phone,
    document: e.document,
    employment_type: e.employmentType,
    department_code: e.departmentCode,
    is_partner_broker: e.isPartnerBroker,
    base_salary_monthly: e.baseSalaryMonthly != null ? Number(e.baseSalaryMonthly) : null,
    status: e.status,
    user_id: e.userId,
    user_email: e.user?.email ?? null,
    user_name: e.user?.name ?? null,
    hired_at: e.hiredAt?.toISOString() ?? null,
    created_at: e.createdAt.toISOString(),
  };
}

/**
 * POST /api/hr/employees/list/
 */
router.post('/employees/list/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      page?: number;
      pageSize?: number;
      search?: string;
      department_code?: string;
      employment_type?: string;
      status?: string;
      warehouse_id?: string;
    };

    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 25));
    const skip = (page - 1) * pageSize;

    const wh = body.warehouse_id || user.warehouseId || undefined;

    const where: Prisma.HrEmployeeWhereInput = {
      ...warehouseScope(wh),
    };

    if (body.department_code?.trim()) {
      where.departmentCode = body.department_code.trim();
    }
    if (body.employment_type?.trim()) {
      where.employmentType = body.employment_type.trim();
    }
    if (body.status?.trim()) {
      where.status = body.status.trim();
    }

    const search = body.search?.trim();
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { document: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      getHrEmployeeDelegate().count({ where }),
      getHrEmployeeDelegate().findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        include: {
          user: { select: { email: true, name: true } },
        },
      }),
    ]);

    res.json({
      status: true,
      data: rows.map(toRow),
      total,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/hr/employees/get/:id/
 */
router.get('/employees/get/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    const row = await getHrEmployeeDelegate().findFirst({
      where: { id, ...warehouseScope(wh) },
      include: {
        user: { select: { id: true, email: true, name: true, phone: true } },
        warehouse: { select: { id: true, warehouseName: true, warehouseCode: true } },
      },
    });

    if (!row) {
      res.status(404).json({ success: false, message: 'Colaborador não encontrado' });
      return;
    }

    res.json({
      data: {
        ...toRow({ ...row, user: row.user ? { email: row.user.email, name: row.user.name } : null }),
        warehouse_id: row.warehouseId,
        commission_notes: row.commissionNotes,
        notes: row.notes,
        warehouse: row.warehouse,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Lista usuários do sistema sem ficha de RH vinculada (para select no formulário).
 * GET /api/hr/users-without-employee/
 */
router.get('/users-without-employee/', async (req: Request, res: Response, next) => {
  try {
    const linked = await getHrEmployeeDelegate().findMany({
      where: { userId: { not: null } },
      select: { userId: true },
    });
    const usedIds = linked.map((x) => x.userId).filter(Boolean) as string[];

    const users = await prisma.user.findMany({
      where: usedIds.length ? { id: { notIn: usedIds } } : {},
      select: { id: true, email: true, name: true, phone: true, active: true },
      orderBy: { name: 'asc' },
      take: 200,
    });

    res.json({ data: users.filter((u) => u.active) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/hr/employees/create/
 */
router.post('/employees/create/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      full_name?: string;
      nome?: string;
      email?: string;
      phone?: string;
      document?: string;
      employment_type?: string;
      department_code?: string;
      is_partner_broker?: boolean;
      base_salary_monthly?: number | null;
      commission_notes?: string;
      notes?: string;
      status?: string;
      user_id?: string | null;
      warehouse_id?: string;
      hired_at?: string | null;
    };

    const fullName = String(body.full_name || body.nome || '').trim();
    if (!fullName) {
      res.status(400).json({ success: false, message: 'Nome é obrigatório' });
      return;
    }

    const et = String(body.employment_type || 'fixed_only').trim();
    const employmentType = EMPLOYMENT_TYPES.has(et) ? et : 'fixed_only';

    const dc = String(body.department_code || 'comercial').trim();
    const departmentCode = DEPARTMENTS.has(dc) ? dc : 'comercial';

    const warehouseId = body.warehouse_id?.trim() || user.warehouseId || null;

    let userId: string | null = body.user_id?.trim() || null;
    if (userId) {
      const exists = await prisma.user.findUnique({ where: { id: userId } });
      if (!exists) {
        res.status(400).json({ success: false, message: 'Usuário do sistema não encontrado' });
        return;
      }
      const taken = await getHrEmployeeDelegate().findUnique({ where: { userId } });
      if (taken) {
        res.status(409).json({ success: false, message: 'Este usuário já está vinculado a outro colaborador' });
        return;
      }
    }

    const salary =
      body.base_salary_monthly != null && Number.isFinite(Number(body.base_salary_monthly))
        ? new Prisma.Decimal(String(body.base_salary_monthly))
        : null;

    const hiredAt = body.hired_at ? new Date(body.hired_at) : null;
    if (body.hired_at && hiredAt && Number.isNaN(hiredAt.getTime())) {
      res.status(400).json({ success: false, message: 'Data de admissão inválida' });
      return;
    }

    const created = await getHrEmployeeDelegate().create({
      data: {
        warehouseId,
        fullName,
        email: body.email?.trim() || null,
        phone: body.phone?.trim() || null,
        document: body.document?.trim() || null,
        employmentType,
        departmentCode,
        isPartnerBroker: Boolean(body.is_partner_broker),
        baseSalaryMonthly: salary,
        commissionNotes: body.commission_notes?.trim() || null,
        notes: body.notes?.trim() || null,
        status: body.status?.trim() || 'active',
        userId,
        hiredAt: hiredAt && !Number.isNaN(hiredAt.getTime()) ? hiredAt : null,
      },
    });

    res.status(201).json({ success: true, data: { id: created.id } });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/hr/employees/update/:id/
 */
router.put('/employees/update/:id/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    const existing = await getHrEmployeeDelegate().findFirst({
      where: { id, ...warehouseScope(wh) },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Colaborador não encontrado' });
      return;
    }

    const body = req.body as {
      full_name?: string;
      nome?: string;
      email?: string;
      phone?: string;
      document?: string;
      employment_type?: string;
      department_code?: string;
      is_partner_broker?: boolean;
      base_salary_monthly?: number | null;
      commission_notes?: string;
      notes?: string;
      status?: string;
      user_id?: string | null;
      warehouse_id?: string | null;
      hired_at?: string | null;
    };

    let userId: string | null | undefined = body.user_id;
    if (userId === '') userId = null;

    if (userId) {
      const u = await prisma.user.findUnique({ where: { id: userId } });
      if (!u) {
        res.status(400).json({ success: false, message: 'Usuário do sistema não encontrado' });
        return;
      }
      const taken = await getHrEmployeeDelegate().findFirst({
        where: { userId, id: { not: existing.id } },
      });
      if (taken) {
        res.status(409).json({ success: false, message: 'Este usuário já está vinculado a outro colaborador' });
        return;
      }
    }

    const et = body.employment_type?.trim();
    const employmentType = et && EMPLOYMENT_TYPES.has(et) ? et : undefined;

    const dc = body.department_code?.trim();
    const departmentCode = dc && DEPARTMENTS.has(dc) ? dc : undefined;

    const salaryUpd =
      body.base_salary_monthly !== undefined
        ? body.base_salary_monthly != null && Number.isFinite(Number(body.base_salary_monthly))
          ? new Prisma.Decimal(String(body.base_salary_monthly))
          : null
        : undefined;

    const hiredAt =
      body.hired_at !== undefined
        ? body.hired_at
          ? new Date(body.hired_at)
          : null
        : undefined;

    await getHrEmployeeDelegate().update({
      where: { id },
      data: {
        fullName:
          body.full_name !== undefined || body.nome !== undefined
            ? String(body.full_name || body.nome || '').trim() || existing.fullName
            : undefined,
        email: body.email !== undefined ? body.email?.trim() || null : undefined,
        phone: body.phone !== undefined ? body.phone?.trim() || null : undefined,
        document: body.document !== undefined ? body.document?.trim() || null : undefined,
        employmentType,
        departmentCode,
        isPartnerBroker:
          body.is_partner_broker !== undefined ? Boolean(body.is_partner_broker) : undefined,
        baseSalaryMonthly: salaryUpd,
        commissionNotes: body.commission_notes !== undefined ? body.commission_notes?.trim() || null : undefined,
        notes: body.notes !== undefined ? body.notes?.trim() || null : undefined,
        status: body.status !== undefined ? body.status?.trim() || existing.status : undefined,
        userId: userId !== undefined ? userId : undefined,
        warehouseId:
          body.warehouse_id !== undefined ? body.warehouse_id?.trim() || null : undefined,
        hiredAt:
          hiredAt !== undefined
            ? hiredAt && !Number.isNaN(hiredAt.getTime())
              ? hiredAt
              : null
            : undefined,
      },
    });

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/hr/employees/bulk-status/
 * Body: { rows: string[], status: 'active' | 'inactive' }
 */
router.post('/employees/bulk-status/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { rows?: string[]; status?: string; warehouse_id?: string };
    const ids = Array.isArray(body.rows) ? body.rows.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, message: 'Nenhum colaborador informado' });
      return;
    }
    const st = String(body.status || '').trim();
    if (st !== 'active' && st !== 'inactive') {
      res.status(400).json({ success: false, message: 'Status deve ser active ou inactive' });
      return;
    }
    const wh = body.warehouse_id || user.warehouseId || undefined;
    const result = await getHrEmployeeDelegate().updateMany({
      where: {
        id: { in: ids },
        ...warehouseScope(wh),
      },
      data: { status: st },
    });
    res.json({ success: true, count: result.count });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/hr/employees/remove/
 */
router.post('/employees/remove/', async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { rows?: string[]; warehouse_id?: string };
    const ids = Array.isArray(body.rows) ? body.rows.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, message: 'Nenhum id informado' });
      return;
    }

    const wh = body.warehouse_id || user.warehouseId || undefined;
    await getHrEmployeeDelegate().deleteMany({
      where: {
        id: { in: ids },
        ...warehouseScope(wh),
      },
    });
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
