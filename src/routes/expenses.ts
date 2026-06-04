import { Router, Request, Response } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  assertWarehouseAccess,
  buildExpenseEditResponse,
  endOfUtcDay,
  KIND_PAYABLE,
  mapExpenseRow,
  parseDecimal,
  startOfUtcDay,
  utcDayBoundsFromDateString,
  utcMonthRange,
} from '../lib/financial.js';

const router = Router();
router.use(authMiddleware);
const upload = multer({ storage: multer.memoryStorage() });

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function getHrEmployeeDelegate() {
  const hr = (prisma as { hrEmployee?: typeof prisma.hrEmployee }).hrEmployee;
  if (!hr || typeof (hr as { findFirst?: unknown }).findFirst !== 'function') return null;
  return hr;
}

async function resolveHrEmployeeName(warehouseId: string, employeeId: string): Promise<string> {
  const hr = getHrEmployeeDelegate();
  if (!hr) return '';
  const emp = await hr.findFirst({
    where: { id: employeeId, warehouseId, status: 'active' },
    select: { fullName: true },
  });
  return emp?.fullName ?? '';
}

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

router.post(
  '/summary/',
  asyncHandler(async (req: Authed, res) => {
    const warehouseId = assertWarehouseAccess(req.user, (req.body as { warehouse_id?: string })?.warehouse_id);
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const dayEnd = endOfUtcDay(now);
    const { start: monthStart, end: monthEnd } = utcMonthRange(now);

    const base = { warehouseId, kind: KIND_PAYABLE };

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

    const paid = paidRows.reduce((s, r) => s + Number(r.amount), 0);
    const paidToday = paidRows
      .filter((r) => r.paidAt && r.paidAt >= dayStart && r.paidAt < dayEnd)
      .reduce((s, r) => s + Number(r.amount), 0);
    const paidTodayCount = paidRows.filter(
      (r) => r.paidAt && r.paidAt >= dayStart && r.paidAt < dayEnd
    ).length;

    const paidMonth = paidRows
      .filter((r) => r.paidAt && r.paidAt >= monthStart && r.paidAt < monthEnd)
      .reduce((s, r) => s + Number(r.amount), 0);
    const paidMonthCount = paidRows.filter(
      (r) => r.paidAt && r.paidAt >= monthStart && r.paidAt < monthEnd
    ).length;

    const toPay = pendingRows.reduce((s, r) => s + Number(r.amount), 0);
    const toPayMonth = pendingRows
      .filter((r) => r.dueDate >= monthStart && r.dueDate < monthEnd)
      .reduce((s, r) => s + Number(r.amount), 0);
    const toPayMonthCount = pendingRows.filter(
      (r) => r.dueDate >= monthStart && r.dueDate < monthEnd
    ).length;

    const overdueRows = pendingRows.filter((r) => r.dueDate < dayStart);
    const overdue = overdueRows.reduce((s, r) => s + Number(r.amount), 0);
    const overdueCount = overdueRows.length;

    const totalAll = paid + toPay;
    const paidPercent = totalAll > 0 ? Math.round((paid / totalAll) * 1000) / 10 : 0;

    res.json({
      status: true,
      data: {
        paid,
        paid_today: paidToday,
        paid_today_count: paidTodayCount,
        to_pay: toPay,
        to_pay_count: pendingRows.length,
        to_pay_month: toPayMonth,
        to_pay_month_count: toPayMonthCount,
        overdue,
        overdue_count: overdueCount,
        paid_percent: paidPercent,
        paid_month: paidMonth,
        paid_month_count: paidMonthCount,
      },
    });
  })
);

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
      kind: KIND_PAYABLE,
    };
    if (statusFilter && ['pending', 'paid', 'cancelled'].includes(statusFilter)) {
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
      data: rows.map(mapExpenseRow),
    });
  })
);

const payHandler = asyncHandler(async (req: Authed, res) => {
  const body = req.body as {
    id?: string;
    expense_id?: string;
    warehouse_id?: string;
    status?: string;
    payment_date?: string;
    date?: string;
    bank_account_id?: string;
    note?: string;
    amount?: string;
  };
  const id = String(body.expense_id ?? body.id ?? '').trim();
  if (!id) {
    res.status(400).json({ status: false, message: 'id é obrigatório' });
    return;
  }
  const existing = await prisma.finTransaction.findFirst({
    where: { id, kind: KIND_PAYABLE },
  });
  if (!existing) {
    res.status(404).json({ status: false, message: 'Despesa não encontrada' });
    return;
  }
  assertWarehouseAccess(req.user, existing.warehouseId);
  if (existing.status !== 'pending') {
    res.status(404).json({ status: false, message: 'Já pago ou cancelado' });
    return;
  }

  const dateRaw = body.payment_date ?? body.date;
  const payDay = dateRaw ? new Date(String(dateRaw)) : new Date();
  if (Number.isNaN(payDay.getTime())) {
    res.status(400).json({ status: false, message: 'payment_date inválido' });
    return;
  }

  const amt = body.amount != null ? parseDecimal(body.amount) : null;
  const prevMeta =
    existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const mergedMeta: Prisma.InputJsonValue = {
    ...prevMeta,
    ...(body.note != null ? { payment_note: String(body.note) } : {}),
  };

  await prisma.finTransaction.update({
    where: { id },
    data: {
      status: 'paid',
      paidAt: payDay,
      ...(amt && !amt.equals(0) ? { amount: amt } : {}),
      bankAccountId:
        body.bank_account_id != null && String(body.bank_account_id).trim()
          ? String(body.bank_account_id).trim()
          : existing.bankAccountId,
      metadata: mergedMeta,
    },
  });

  res.json({ status: true, message: 'OK' });
});

router.post('/pay/', upload.any(), payHandler);
router.post('/payment/', upload.any(), payHandler);

router.post('/remove/', asyncHandler(async (req: Authed, res) => {
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
    where: { id: { in: ids }, kind: KIND_PAYABLE },
    select: { warehouseId: true },
  });
  for (const r of rows) {
    assertWarehouseAccess(req.user, r.warehouseId);
  }
  const r = await prisma.finTransaction.deleteMany({
    where: { kind: KIND_PAYABLE, id: { in: ids } },
  });
  res.json({ status: true, deleted: r.count });
}));

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
      where: { id: { in: ids }, kind: KIND_PAYABLE },
      select: { warehouseId: true },
    });
    for (const r of rows) {
      assertWarehouseAccess(req.user, r.warehouseId);
    }
    const r = await prisma.finTransaction.deleteMany({
      where: { kind: KIND_PAYABLE, id: { in: ids } },
    });
    res.json({ status: true, deleted: r.count });
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
    ],
  });
});

/** Lançamentos do dia (vencimento) para o calendário de contas a pagar. */
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
      kind: KIND_PAYABLE,
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

    const data = rows.map((t) => ({
      id: t.id,
      reference_no: t.reference ?? t.id,
      supplier: t.company,
      expense_name: t.company,
      amount: Number(t.amount),
      due_date: t.dueDate.toISOString(),
      status: t.status === 'paid' ? 'paid' : 'pending',
      payment_mode_name: 'N/A',
      numero_parcela: null,
    }));

    res.json({ status: true, total, data });
  })
);

router.get('/currencies/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [{ id: 'BRL', name: 'Real (BRL)', symbol: 'R$' }] });
});

router.get('/taxes/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [] });
});

router.get('/projects/', (_req: Request, res: Response) => {
  res.json({ status: true, data: [] });
});

router.get('/clients/', asyncHandler(async (req: Authed, res) => {
  const q = req.query as { warehouse_id?: string; pageSize?: string };
  const warehouseId = assertWarehouseAccess(req.user, q.warehouse_id);
  const clients = await prisma.client.findMany({
    where: { warehouseId, deletedAt: null, active: true },
    select: { id: true, name: true },
    take: Math.min(500, parseInt(String(q.pageSize ?? '500'), 10) || 500),
    orderBy: { name: 'asc' },
  });
  res.json({
    status: true,
    data: clients.map((c) => ({ id: c.id, company: c.name, name: c.name })),
  });
}));

async function resolveClientName(warehouseId: string, clientId: string | null): Promise<string> {
  if (!clientId) return '';
  const c = await prisma.client.findFirst({
    where: { id: clientId, warehouseId, deletedAt: null },
    select: { name: true },
  });
  return c?.name ?? '';
}

async function resolveSupplierName(warehouseId: string, supplierId: string | null): Promise<string> {
  if (!supplierId) return '';
  const s = await prisma.supplier.findFirst({
    where: { id: supplierId, warehouseId, active: true },
    select: { name: true },
  });
  return s?.name ?? '';
}

async function resolveFavorecidoDisplayName(
  warehouseId: string,
  meta: Record<string, unknown> | null
): Promise<string> {
  if (!meta) return '';
  const sid = typeof meta.supplier_id === 'string' ? meta.supplier_id : null;
  const cid = typeof meta.clientid === 'string' ? meta.clientid : null;
  const heid = typeof meta.hr_employee_id === 'string' ? meta.hr_employee_id : null;
  if (sid) return resolveSupplierName(warehouseId, sid);
  if (cid) return resolveClientName(warehouseId, cid);
  if (heid) return resolveHrEmployeeName(warehouseId, heid);
  return '';
}

router.get(
  '/get/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
      include: { category: true },
    });
    if (!t) {
      res.status(404).json({ status: false, message: 'Despesa não encontrada' });
      return;
    }
    assertWarehouseAccess(req.user, t.warehouseId);
    const meta = t.metadata as Record<string, unknown> | null;
    const favorecidoName = await resolveFavorecidoDisplayName(t.warehouseId, meta);
    const edit = buildExpenseEditResponse(t, favorecidoName);
    res.json({
      status: true,
      data: {
        ...edit.expense,
        id: t.id,
        warehouse_id: t.warehouseId,
      },
    });
  })
);

router.get(
  '/edit/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
      include: { category: true },
    });
    if (!t) {
      res.status(404).json({ status: false, message: 'Despesa não encontrada' });
      return;
    }
    assertWarehouseAccess(req.user, t.warehouseId);
    const meta = t.metadata as Record<string, unknown> | null;
    const favorecidoName = await resolveFavorecidoDisplayName(t.warehouseId, meta);
    res.json({ status: true, data: buildExpenseEditResponse(t, favorecidoName) });
  })
);

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

    const expenseName = String(payload.expense_name ?? '').trim();
    const supplierIdRaw = payload.supplier_id != null ? String(payload.supplier_id).trim() : '';
    const clientIdRaw = payload.clientid != null ? String(payload.clientid).trim() : '';
    const hrEmployeeIdRaw =
      payload.hr_employee_id != null ? String(payload.hr_employee_id).trim() : '';

    let company = expenseName || 'Despesa';
    let resolvedClientId = '';
    let resolvedHrEmployeeId = '';
    let resolvedSupplierId = '';

    if (supplierIdRaw) {
      const s = await prisma.supplier.findFirst({
        where: { id: supplierIdRaw, warehouseId, active: true },
        select: { name: true },
      });
      if (s) {
        company = s.name;
        resolvedSupplierId = supplierIdRaw;
      }
    } else if (clientIdRaw) {
      const c = await prisma.client.findFirst({
        where: { id: clientIdRaw, deletedAt: null, warehouseId },
        select: { name: true },
      });
      if (c) {
        company = c.name;
        resolvedClientId = clientIdRaw;
      }
    } else if (hrEmployeeIdRaw) {
      const name = await resolveHrEmployeeName(warehouseId, hrEmployeeIdRaw);
      if (name) {
        company = name;
        resolvedHrEmployeeId = hrEmployeeIdRaw;
      }
    }

    const parcelas = Array.isArray(payload.parcelas_fiscais) ? payload.parcelas_fiscais : [];
    const firstDue = parcelas[0] && typeof parcelas[0] === 'object'
      ? String((parcelas[0] as Record<string, unknown>).data_vencimento ?? '')
      : '';
    const dateStr = String(payload.date ?? '');
    const dueStr = firstDue || String(payload.data_vencimento_fiscal ?? dateStr);
    const date = dateStr ? new Date(dateStr) : new Date();
    const dueDate = dueStr ? new Date(dueStr) : date;
    if (Number.isNaN(date.getTime()) || Number.isNaN(dueDate.getTime())) {
      res.status(400).json({ status: false, message: 'Datas inválidas' });
      return;
    }

    let categoryId: string | null = null;
    if (payload.category != null && payload.category !== '') {
      const cid = String(payload.category);
      const cat = await prisma.finCategory.findFirst({
        where: { id: cid, warehouseId, kind: 'payable' },
      });
      if (cat) categoryId = cat.id;
    }

    const reference =
      payload.expense_identifier != null && String(payload.expense_identifier).trim()
        ? String(payload.expense_identifier).trim()
        : null;

    const totalParcelas = parcelas.length > 0 ? parcelas.length : 1;
    const metadata = {
      expense_name: expenseName || company,
      clientid: resolvedClientId || null,
      hr_employee_id: resolvedHrEmployeeId || null,
      supplier_id: resolvedSupplierId || null,
      favorecido_kind: resolvedSupplierId
        ? 'supplier'
        : resolvedClientId
          ? 'client'
          : resolvedHrEmployeeId
            ? 'employee'
            : null,
      parcelas_fiscais: parcelas,
      total_parcelas: totalParcelas,
      valor_ac: payload.valor_ac != null ? Number(payload.valor_ac) : 0,
      paymentmode: payload.paymentmode ?? null,
      forma_pagamento_padrao_fiscal: payload.forma_pagamento_padrao_fiscal ?? null,
      juros: payload.juros ?? null,
      tipo_juros: payload.tipo_juros ?? null,
      juros_apartir: payload.juros_apartir ?? null,
      reference_date: payload.reference_date ?? null,
      registration_date: payload.registration_date ?? null,
    } as Prisma.InputJsonValue;

    const created = await prisma.finTransaction.create({
      data: {
        warehouseId,
        kind: KIND_PAYABLE,
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

router.post(
  '/update/:id',
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
      where: { id, kind: KIND_PAYABLE },
    });
    if (!existing) {
      res.status(404).json({ status: false, message: 'Despesa não encontrada' });
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

    const prevMeta =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>)
        : {};

    let company = existing.company;
    const supplierIdRaw = payload.supplier_id != null ? String(payload.supplier_id).trim() : '';
    const clientIdRaw = payload.clientid != null ? String(payload.clientid).trim() : '';
    const hrEmployeeIdRaw =
      payload.hr_employee_id != null ? String(payload.hr_employee_id).trim() : '';

    let resolvedClientId = '';
    let resolvedHrEmployeeId = '';
    let resolvedSupplierId = '';

    if (supplierIdRaw) {
      const s = await prisma.supplier.findFirst({
        where: { id: supplierIdRaw, warehouseId, active: true },
        select: { name: true },
      });
      if (s) {
        company = s.name;
        resolvedSupplierId = supplierIdRaw;
      }
    } else if (clientIdRaw) {
      const c = await prisma.client.findFirst({
        where: { id: clientIdRaw, deletedAt: null, warehouseId },
        select: { name: true },
      });
      if (c) {
        company = c.name;
        resolvedClientId = clientIdRaw;
      }
    } else if (hrEmployeeIdRaw) {
      const name = await resolveHrEmployeeName(warehouseId, hrEmployeeIdRaw);
      if (name) {
        company = name;
        resolvedHrEmployeeId = hrEmployeeIdRaw;
      }
    } else {
      const prevSid = typeof prevMeta.supplier_id === 'string' ? prevMeta.supplier_id.trim() : '';
      const prevCid = typeof prevMeta.clientid === 'string' ? prevMeta.clientid.trim() : '';
      const prevHe =
        typeof prevMeta.hr_employee_id === 'string' ? prevMeta.hr_employee_id.trim() : '';
      if (prevSid) {
        resolvedSupplierId = prevSid;
        const s = await prisma.supplier.findFirst({
          where: { id: prevSid, warehouseId, active: true },
          select: { name: true },
        });
        if (s) company = s.name;
      } else if (prevCid) {
        resolvedClientId = prevCid;
        const c = await prisma.client.findFirst({
          where: { id: prevCid, deletedAt: null, warehouseId },
          select: { name: true },
        });
        if (c) company = c.name;
      } else if (prevHe) {
        resolvedHrEmployeeId = prevHe;
        const name = await resolveHrEmployeeName(warehouseId, prevHe);
        if (name) company = name;
      }
    }

    const parcelas = Array.isArray(payload.parcelas_fiscais) ? payload.parcelas_fiscais : [];
    const firstDue = parcelas[0] && typeof parcelas[0] === 'object'
      ? String((parcelas[0] as Record<string, unknown>).data_vencimento ?? '')
      : '';
    const dateStr = String(payload.date ?? '');
    const dueStr = firstDue || String(payload.data_vencimento_fiscal ?? dateStr);
    const date = dateStr ? new Date(dateStr) : existing.date;
    const dueDate = dueStr ? new Date(dueStr) : existing.dueDate;
    if (Number.isNaN(date.getTime()) || Number.isNaN(dueDate.getTime())) {
      res.status(400).json({ status: false, message: 'Datas inválidas' });
      return;
    }

    let categoryId: string | null = existing.categoryId;
    if (payload.category != null && payload.category !== '') {
      const cid = String(payload.category);
      const cat = await prisma.finCategory.findFirst({
        where: { id: cid, warehouseId, kind: 'payable' },
      });
      categoryId = cat ? cat.id : null;
    }

    const reference =
      payload.expense_identifier != null && String(payload.expense_identifier).trim()
        ? String(payload.expense_identifier).trim()
        : null;

    const totalParcelas = parcelas.length > 0 ? parcelas.length : 1;
    const metadata = {
      ...prevMeta,
      expense_name: String(payload.expense_name ?? prevMeta.expense_name ?? existing.company),
      clientid: resolvedClientId || null,
      hr_employee_id: resolvedHrEmployeeId || null,
      supplier_id: resolvedSupplierId || null,
      favorecido_kind: resolvedSupplierId
        ? 'supplier'
        : resolvedClientId
          ? 'client'
          : resolvedHrEmployeeId
            ? 'employee'
            : null,
      parcelas_fiscais: parcelas.length ? parcelas : prevMeta.parcelas_fiscais ?? [],
      total_parcelas: totalParcelas,
      valor_ac:
        payload.valor_ac != null
          ? Number(payload.valor_ac)
          : prevMeta.valor_ac != null
            ? Number(prevMeta.valor_ac)
            : 0,
      paymentmode: payload.paymentmode ?? prevMeta.paymentmode,
      forma_pagamento_padrao_fiscal:
        payload.forma_pagamento_padrao_fiscal ?? prevMeta.forma_pagamento_padrao_fiscal,
      juros: payload.juros ?? prevMeta.juros,
      tipo_juros: payload.tipo_juros ?? prevMeta.tipo_juros,
      juros_apartir: payload.juros_apartir ?? prevMeta.juros_apartir,
      reference_date: payload.reference_date ?? prevMeta.reference_date,
      registration_date: payload.registration_date ?? prevMeta.registration_date,
    } as Prisma.InputJsonValue;

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

router.post(
  '/installments/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { expense_id?: string; warehouse_id?: string };
    const id = String(body.expense_id ?? '').trim();
    if (!id) {
      res.status(400).json({ status: false, message: 'expense_id é obrigatório' });
      return;
    }
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
      include: { category: true },
    });
    if (!t) {
      res.status(404).json({ status: false, message: 'Não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, body.warehouse_id ?? t.warehouseId);
    const meta = t.metadata as Record<string, unknown> | null;
    const clientName = await resolveFavorecidoDisplayName(t.warehouseId, meta);
    const edit = buildExpenseEditResponse(t, clientName);
    res.json({ status: true, installments: edit.expense.installments ?? [] });
  })
);

router.post(
  '/update_installment_note',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { warehouse_id?: string; installment_id?: string; note?: string };
    const id = String(body.installment_id ?? '').trim();
    if (!id) {
      res.status(400).json({ status: false, message: 'installment_id é obrigatório' });
      return;
    }
    const t = await prisma.finTransaction.findFirst({ where: { id, kind: KIND_PAYABLE } });
    if (!t) {
      res.status(404).json({ status: false, message: 'Não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, body.warehouse_id ?? t.warehouseId);
    res.json({ status: true, message: 'OK' });
  })
);

router.post(
  '/payments_history',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as {
      warehouse_id?: string;
      page?: number;
      pageSize?: number;
      search?: string;
      startDate?: string | null;
      endDate?: string | null;
    };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const page = Math.max(0, parseInt(String(body.page ?? 0), 10) || 0);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(body.pageSize ?? 10), 10) || 10));
    const search = String(body.search ?? '').trim();

    const where: Prisma.FinTransactionWhereInput = {
      warehouseId,
      kind: KIND_PAYABLE,
      status: 'paid',
      paidAt: { not: null },
    };
    const startD = body.startDate ? new Date(body.startDate) : null;
    const endD = body.endDate ? new Date(body.endDate) : null;
    if (startD && !Number.isNaN(startD.getTime()) && endD && !Number.isNaN(endD.getTime())) {
      const endExclusive = new Date(endD);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      where.paidAt = { gte: startD, lt: endExclusive };
    } else if (startD && !Number.isNaN(startD.getTime())) {
      where.paidAt = { gte: startD };
    } else if (endD && !Number.isNaN(endD.getTime())) {
      const endExclusive = new Date(endD);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      where.paidAt = { lt: endExclusive };
    }
    if (search) {
      where.OR = [
        { company: { contains: search, mode: 'insensitive' } },
        { note: { contains: search, mode: 'insensitive' } },
        { reference: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.finTransaction.count({ where }),
      prisma.finTransaction.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        skip: page * pageSize,
        take: pageSize,
      }),
    ]);

    const data = rows.map((t) => {
      const meta = t.metadata as Record<string, unknown> | null;
      const expenseName =
        (meta?.expense_name as string) || t.company;
      return {
        id: t.id,
        date: t.paidAt ? t.paidAt.toISOString() : t.date.toISOString(),
        supplier_name: t.company,
        expense_name: expenseName,
        expense_identifier: t.reference ?? '',
        file: typeof meta?.comprovante_url === 'string' ? meta.comprovante_url : null,
        amount: Number(t.amount),
        valor_atual_parcelas: Number(t.amount),
      };
    });

    res.json({ status: true, total, data });
  })
);

router.get(
  '/payment_details/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
    });
    if (!t || t.status !== 'paid') {
      res.status(404).json({ status: false, message: 'Pagamento não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, t.warehouseId);
    const meta = t.metadata as Record<string, unknown> | null;
    res.json({
      status: true,
      data: {
        header: {
          expense_id: t.id,
          bank_account_id: t.bankAccountId ?? '',
          date: t.paidAt ? t.paidAt.toISOString().split('T')[0] : '',
          amount: String(Number(t.amount)),
          note: t.note ?? '',
          juros: 0,
          multa: 0,
          desconto: 0,
          transaction_id: typeof meta?.transaction_id === 'string' ? meta.transaction_id : '',
          paymentmode_id: null,
        },
        entries: [
          {
            installment_id: t.id,
            amount: Number(t.amount),
            valores_formas: null,
            paymentmode_id: null,
          },
        ],
      },
    });
  })
);

router.post(
  '/payment_delete',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { id?: string; warehouse_id?: string };
    const id = String(body.id ?? '').trim();
    if (!id) {
      res.status(400).json({ status: false, message: 'id é obrigatório' });
      return;
    }
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
    });
    if (!t) {
      res.status(404).json({ status: false, message: 'Não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, body.warehouse_id ?? t.warehouseId);
    await prisma.finTransaction.update({
      where: { id },
      data: { status: 'pending', paidAt: null },
    });
    res.json({ status: true, message: 'Estornado' });
  })
);

router.post(
  '/payment_update',
  upload.any(),
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as {
      id?: string;
      expense_id?: string;
      date?: string;
      amount?: string;
      bank_account_id?: string;
      note?: string;
      transaction_id?: string;
    };
    const id = String(body.id ?? '').trim();
    if (!id) {
      res.status(400).json({ status: false, message: 'id é obrigatório' });
      return;
    }
    const t = await prisma.finTransaction.findFirst({
      where: { id, kind: KIND_PAYABLE },
    });
    if (!t || t.status !== 'paid') {
      res.status(404).json({ status: false, message: 'Pagamento não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, t.warehouseId);

    const payDay = body.date ? new Date(body.date) : t.paidAt ?? new Date();
    if (Number.isNaN(payDay.getTime())) {
      res.status(400).json({ status: false, message: 'Data inválida' });
      return;
    }

    const prevMeta =
      t.metadata && typeof t.metadata === 'object' && !Array.isArray(t.metadata)
        ? (t.metadata as Record<string, unknown>)
        : {};
    const metadata = {
      ...prevMeta,
      transaction_id:
        body.transaction_id != null
          ? String(body.transaction_id)
          : typeof prevMeta.transaction_id === 'string'
            ? prevMeta.transaction_id
            : undefined,
    } as Prisma.InputJsonValue;

    const amt = body.amount != null ? parseDecimal(body.amount) : t.amount;
    await prisma.finTransaction.update({
      where: { id },
      data: {
        paidAt: payDay,
        amount: amt ?? t.amount,
        note: body.note != null ? String(body.note) : t.note,
        bankAccountId:
          body.bank_account_id != null && String(body.bank_account_id).trim()
            ? String(body.bank_account_id).trim()
            : t.bankAccountId,
        metadata,
      },
    });

    res.json({ status: true, message: 'OK' });
  })
);

export default router;
