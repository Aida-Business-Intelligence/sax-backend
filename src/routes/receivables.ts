import { Router, Request, Response } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  assertWarehouseAccess,
  endOfUtcDay,
  KIND_RECEIVABLE,
  mapReceivableDetail,
  mapReceivableRow,
  parseDecimal,
  parseFinDateInput,
  startOfUtcDay,
  utcDayBoundsFromDateString,
  utcMonthRange,
} from '../lib/financial.js';

const router = Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage() });

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function asyncHandler(
  fn: (req: Authed, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req as Authed, res).catch((e: Error & { statusCode?: number }) => {
      const code = e.statusCode ?? 500;
      res.status(code).json({ status: false, message: e.message || 'Erro no servidor' });
    });
  };
}

/** Resumo contas a receber (compatível com PDV). */
router.post(
  '/summary/',
  asyncHandler(async (req: Authed, res) => {
    const warehouseId = assertWarehouseAccess(req.user, (req.body as { warehouse_id?: string })?.warehouse_id);
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const dayEnd = endOfUtcDay(now);
    const { start: monthStart, end: monthEnd } = utcMonthRange(now);

    const base = { warehouseId, kind: KIND_RECEIVABLE };

    const [paidRows, pendingRows] = await Promise.all([
      prisma.finTransaction.findMany({
        where: { ...base, status: 'paid' },
        select: { amount: true, paidAt: true },
      }),
      prisma.finTransaction.findMany({
        where: { ...base, status: 'pending' },
        select: { amount: true, dueDate: true },
      }),
    ]);

    const received = paidRows.reduce((s, r) => s + Number(r.amount), 0);
    const receivedToday = paidRows
      .filter((r) => r.paidAt && r.paidAt >= dayStart && r.paidAt < dayEnd)
      .reduce((s, r) => s + Number(r.amount), 0);
    const receivedTodayCount = paidRows.filter(
      (r) => r.paidAt && r.paidAt >= dayStart && r.paidAt < dayEnd
    ).length;

    const toReceive = pendingRows.reduce((s, r) => s + Number(r.amount), 0);
    const toReceiveMonth = pendingRows
      .filter((r) => r.dueDate >= monthStart && r.dueDate < monthEnd)
      .reduce((s, r) => s + Number(r.amount), 0);
    const toReceiveMonthCount = pendingRows.filter(
      (r) => r.dueDate >= monthStart && r.dueDate < monthEnd
    ).length;

    const overdueRows = pendingRows.filter((r) => r.dueDate < dayStart);
    const overdue = overdueRows.reduce((s, r) => s + Number(r.amount), 0);
    const overdueCount = overdueRows.length;

    const totalAll = received + toReceive;
    const receivedPercent = totalAll > 0 ? Math.round((received / totalAll) * 1000) / 10 : 0;

    res.json({
      status: true,
      data: {
        received,
        received_today: receivedToday,
        received_today_count: receivedTodayCount,
        to_receive: toReceive,
        to_receive_month: toReceiveMonth,
        to_receive_month_count: toReceiveMonthCount,
        overdue,
        received_percent: receivedPercent,
        to_receive_count: pendingRows.length,
        overdue_count: overdueCount,
      },
    });
  })
);

/** Lista paginada. */
router.post(
  '/list/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as Record<string, unknown>;
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const page = Math.max(0, parseInt(String(body.page ?? 0), 10) || 0);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(body.pageSize ?? 10), 10) || 10));
    const search = String(body.search ?? '').trim();
    const statusFilter = String(body.status ?? '').trim();

    const where: Prisma.FinTransactionWhereInput = {
      warehouseId,
      kind: KIND_RECEIVABLE,
    };
    if (statusFilter === 'received') {
      where.status = 'paid';
    } else if (statusFilter && ['pending', 'paid', 'cancelled'].includes(statusFilter)) {
      where.status = statusFilter;
    }
    if (search) {
      where.OR = [
        { company: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
        { reference: { contains: search, mode: 'insensitive' } },
      ];
    }

    const sortField = String(body.sortField ?? 'date');
    const sortOrder = String(body.sortOrder ?? 'DESC').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.FinTransactionOrderByWithRelationInput =
      sortField === 'due_date'
        ? { dueDate: sortOrder }
        : sortField === 'amount'
          ? { amount: sortOrder }
          : sortField === 'company'
            ? { company: sortOrder }
            : { date: sortOrder };

    const [total, rows] = await Promise.all([
      prisma.finTransaction.count({ where }),
      prisma.finTransaction.findMany({
        where,
        include: { category: true },
        orderBy,
        skip: page * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      status: true,
      total,
      data: rows.map(mapReceivableRow),
    });
  })
);

/** Baixa / recebimento. */
router.post(
  '/payment/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { id?: string; warehouse_id?: string; payment_date?: string };
    const id = String(body.id ?? '').trim();
    if (!id) {
      res.status(400).json({ status: false, message: 'id é obrigatório' });
      return;
    }
    const existing = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_RECEIVABLE },
    });
    if (!existing) {
      res.status(404).json({ status: false, message: 'Título não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, existing.warehouseId);
    const payDay = body.payment_date ? new Date(body.payment_date) : new Date();
    if (Number.isNaN(payDay.getTime())) {
      res.status(400).json({ status: false, message: 'payment_date inválido' });
      return;
    }

    const updated = await prisma.finTransaction.updateMany({
      where: { id, kind: KIND_RECEIVABLE, status: 'pending' },
      data: { status: 'paid', paidAt: payDay },
    });
    if (updated.count === 0) {
      res.status(404).json({ status: false, message: 'Título já baixado ou cancelado' });
      return;
    }
    res.json({ success: true, status: true, message: 'OK' });
  })
);

/** Exclusão. */
router.post(
  '/delete/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { id?: string; rows?: string[]; warehouse_id?: string };
    const ids = Array.isArray(body.rows) && body.rows.length
      ? body.rows.map((x) => String(x))
      : body.id
        ? [String(body.id)]
        : [];
    if (!ids.length) {
      res.status(400).json({ status: false, message: 'Nenhum id informado' });
      return;
    }
    const rows = await prisma.finTransaction.findMany({
      where: { id: { in: ids }, kind: KIND_RECEIVABLE },
      select: { id: true, warehouseId: true },
    });
    for (const r of rows) {
      assertWarehouseAccess(req.user, r.warehouseId);
    }
    const r = await prisma.finTransaction.deleteMany({
      where: { kind: KIND_RECEIVABLE, id: { in: ids } },
    });
    res.json({ status: true, deleted: r.count });
  })
);

/** Criação (JSON ou multipart com `data` JSON). */
router.post(
  '/create/',
  upload.any(),
  asyncHandler(async (req: Authed, res) => {
    let payload: Record<string, unknown>;
    const rawData = (req.body as { data?: string }).data;
    if (typeof rawData === 'string' && rawData.trim()) {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } else {
      payload = req.body as Record<string, unknown>;
    }

    const warehouseId = assertWarehouseAccess(req.user, payload.warehouse_id);
    const amount = parseDecimal(payload.amount);
    if (!amount || amount.lte(0)) {
      res.status(400).json({ status: false, message: 'Valor inválido' });
      return;
    }

    let company = 'Cliente';
    const clientId = payload.clientid != null ? String(payload.clientid).trim() : '';
    if (clientId) {
      const c = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null, warehouseId },
        select: { name: true },
      });
      if (c) company = c.name;
    }

    const dateStr = String(payload.date ?? '');
    const dueStr = String(payload.due_date ?? dateStr);
    const date = dateStr ? parseFinDateInput(dateStr) ?? new Date() : new Date();
    const dueDate = dueStr ? parseFinDateInput(dueStr) ?? date : date;
    if (Number.isNaN(date.getTime()) || Number.isNaN(dueDate.getTime())) {
      res.status(400).json({ status: false, message: 'Datas inválidas' });
      return;
    }

    let categoryId: string | null = null;
    if (payload.category != null && payload.category !== '') {
      const cid = String(payload.category);
      const cat = await prisma.finCategory.findFirst({
        where: { id: cid, warehouseId, kind: 'receivable' },
      });
      if (cat) categoryId = cat.id;
    }

    const reference =
      payload.receivable_identifier != null && String(payload.receivable_identifier).trim()
        ? String(payload.receivable_identifier).trim()
        : null;

    const metadata: Prisma.InputJsonValue = {
      clientId: clientId || null,
      is_client: payload.is_client != null ? Number(payload.is_client) : 1,
    };

    const created = await prisma.finTransaction.create({
      data: {
        warehouseId,
        kind: KIND_RECEIVABLE,
        categoryId,
        company,
        amount,
        currency: String(payload.currency ?? 'BRL'),
        date,
        dueDate,
        status: 'pending',
        note: payload.note != null ? String(payload.note) : null,
        reference,
        bankAccountId:
          payload.bank_account_id != null && String(payload.bank_account_id).trim()
            ? String(payload.bank_account_id).trim()
            : null,
        metadata,
      },
    });

    res.status(201).json({
      status: true,
      data: { id: created.id },
      message: 'Criado',
    });
  })
);

router.get('/payment_modes/', (_req: Request, res: Response) => {
  res.json({
    status: true,
    data: [
      { id: 1, name: 'Dinheiro' },
      { id: 2, name: 'PIX' },
      { id: 3, name: 'Transferência' },
      { id: 4, name: 'Boleto' },
      { id: 5, name: 'Cartão' },
    ],
  });
});

router.get('/clients/', asyncHandler(async (req: Authed, res) => {
  const q = req.query as { warehouse_id?: string; type?: string; pageSize?: string };
  const warehouseId = assertWarehouseAccess(req.user, q.warehouse_id);
  const clients = await prisma.client.findMany({
    where: { warehouseId, deletedAt: null, active: true },
    select: { id: true, name: true },
    take: Math.min(500, parseInt(String(q.pageSize ?? '500'), 10) || 500),
    orderBy: { name: 'asc' },
  });
  // PDV usa type=suppliers nos mesmos clientes até existir cadastro de fornecedores.
  res.json({
    status: true,
    data: clients.map((c) => ({ id: c.id, company: c.name, name: c.name })),
  });
}));

router.get('/projects/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [] });
});

router.get('/currencies/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [{ id: 'BRL', name: 'Real (BRL)', symbol: 'R$' }] });
});

router.get('/taxes/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [] });
});

router.get(
  '/get/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_RECEIVABLE },
      include: { category: true },
    });
    if (!t) {
      res.status(404).json({ status: false, message: 'Título não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, t.warehouseId);
    res.json({ status: true, data: mapReceivableDetail(t) });
  })
);

router.post(
  '/update/:id/',
  upload.any(),
  asyncHandler(async (req: Authed, res) => {
    let payload: Record<string, unknown>;
    const rawData = (req.body as { data?: string }).data;
    if (typeof rawData === 'string' && rawData.trim()) {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } else {
      payload = req.body as Record<string, unknown>;
    }

    const id = String(req.params.id ?? '').trim();
    const existing = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_RECEIVABLE },
    });
    if (!existing) {
      res.status(404).json({ status: false, message: 'Título não encontrado' });
      return;
    }
    const warehouseId = assertWarehouseAccess(req.user, payload.warehouse_id ?? existing.warehouseId);
    if (existing.warehouseId !== warehouseId) {
      res.status(403).json({ status: false, message: 'Sem permissão' });
      return;
    }

    const amount = parseDecimal(payload.amount);
    if (!amount || amount.lte(0)) {
      res.status(400).json({ status: false, message: 'Valor inválido' });
      return;
    }

    let company = existing.company;
    const clientId = payload.clientid != null ? String(payload.clientid).trim() : '';
    if (clientId) {
      const c = await prisma.client.findFirst({
        where: { id: clientId, deletedAt: null, warehouseId },
        select: { name: true },
      });
      if (c) company = c.name;
    }

    const dateStr = String(payload.date ?? '');
    const dueStr = String(payload.due_date ?? dateStr);
    const date = dateStr ? parseFinDateInput(dateStr) ?? existing.date : existing.date;
    const dueDate = dueStr ? parseFinDateInput(dueStr) ?? existing.dueDate : existing.dueDate;
    if (Number.isNaN(date.getTime()) || Number.isNaN(dueDate.getTime())) {
      res.status(400).json({ status: false, message: 'Datas inválidas' });
      return;
    }

    let categoryId: string | null = existing.categoryId;
    if (payload.category != null && payload.category !== '') {
      const cid = String(payload.category);
      const cat = await prisma.finCategory.findFirst({
        where: { id: cid, warehouseId, kind: 'receivable' },
      });
      categoryId = cat ? cat.id : null;
    }

    const reference =
      payload.receivable_identifier != null && String(payload.receivable_identifier).trim()
        ? String(payload.receivable_identifier).trim()
        : null;

    const prevMeta =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};
    const metadata: Prisma.InputJsonValue = {
      ...prevMeta,
      clientId: clientId || null,
      is_client: payload.is_client != null ? Number(payload.is_client) : prevMeta.is_client ?? 1,
    };

    await prisma.finTransaction.update({
      where: { id },
      data: {
        company,
        amount,
        currency: String(payload.currency ?? existing.currency),
        date,
        dueDate,
        note: payload.note != null ? String(payload.note) : null,
        reference,
        categoryId,
        bankAccountId:
          payload.bank_account_id != null && String(payload.bank_account_id).trim()
            ? String(payload.bank_account_id).trim()
            : null,
        metadata,
      },
    });

    res.json({ status: true, message: 'Atualizado' });
  })
);

/** Alias do painel para baixa (mesmo corpo de /payment/). */
router.post('/pay/', asyncHandler(async (req: Authed, res) => {
  const body = req.body as { id?: string; warehouse_id?: string; payment_date?: string };
  const id = String(body.id ?? '').trim();
  if (!id) {
    res.status(400).json({ status: false, message: 'id é obrigatório' });
    return;
  }
  const existing = await prisma.finTransaction.findFirst({
    where: { id, kind: KIND_RECEIVABLE },
  });
  if (!existing) {
    res.status(404).json({ status: false, message: 'Título não encontrado' });
    return;
  }
  assertWarehouseAccess(req.user, existing.warehouseId);
  const payDay = body.payment_date ? new Date(body.payment_date) : new Date();
  if (Number.isNaN(payDay.getTime())) {
    res.status(400).json({ status: false, message: 'payment_date inválido' });
    return;
  }

  const updated = await prisma.finTransaction.updateMany({
    where: { id, kind: KIND_RECEIVABLE, status: 'pending' },
    data: { status: 'paid', paidAt: payDay },
  });
  if (updated.count === 0) {
    res.status(404).json({ status: false, message: 'Título já baixado ou cancelado' });
    return;
  }
  res.json({ success: true, status: true, message: 'OK' });
}));

router.post(
  '/list_by_day/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as {
      warehouse_id?: string;
      date?: string;
      page?: number;
      pageSize?: number;
    };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const bounds = utcDayBoundsFromDateString(String(body.date ?? ''));
    if (!bounds) {
      res.status(400).json({ status: false, message: 'date inválida (use YYYY-MM-DD)' });
      return;
    }
    const pageRaw = parseInt(String(body.page ?? 1), 10) || 1;
    const page0 = Math.max(0, pageRaw - 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(body.pageSize ?? 5), 10) || 5));

    const where: Prisma.FinTransactionWhereInput = {
      warehouseId,
      kind: KIND_RECEIVABLE,
      dueDate: { gte: bounds.start, lt: bounds.end },
    };

    const [total, rows] = await Promise.all([
      prisma.finTransaction.count({ where }),
      prisma.finTransaction.findMany({
        where,
        include: { category: true },
        orderBy: { dueDate: 'asc' },
        skip: page0 * pageSize,
        take: pageSize,
      }),
    ]);

    const data = rows.map((t) => {
      const m = mapReceivableRow(t);
      return {
        ...m,
        client: m.company,
      };
    });

    res.json({ status: true, total, data });
  })
);

export default router;
