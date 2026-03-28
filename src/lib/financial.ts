import type { FinTransaction, FinCategory } from '@prisma/client';
import { Prisma } from '@prisma/client';

export const KIND_RECEIVABLE = 'RECEIVABLE';
export const KIND_PAYABLE = 'PAYABLE';

type UserLike = { warehouseId: string | null };

export function assertWarehouseAccess(user: UserLike, warehouseId: unknown): string {
  const w = typeof warehouseId === 'string' ? warehouseId.trim() : '';
  if (!w) {
    const err = new Error('warehouse_id é obrigatório');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (user.warehouseId && user.warehouseId !== w) {
    const err = new Error('Sem permissão para esta loja');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return w;
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export function endOfUtcDay(d: Date): Date {
  const s = startOfUtcDay(d);
  s.setUTCDate(s.getUTCDate() + 1);
  return s;
}

export function utcMonthRange(d: Date): { start: Date; end: Date } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)),
  };
}

/** Data civil (ano-mês-dia) em UTC — alinhada a `parseFinDateInput` e ao filtro do calendário. */
function utcCalendarDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function mapReceivableRow(t: FinTransaction & { category: FinCategory | null }) {
  return {
    id: t.id,
    company: t.company,
    amount: Number(t.amount),
    date: utcCalendarDateString(t.date),
    due_date: utcCalendarDateString(t.dueDate),
    category: t.categoryId,
    category_name: t.category?.name ?? null,
    payment_mode_name: 'N/A',
    paymentmode: null,
    note: t.note ?? '',
    status: t.status === 'paid' ? 'received' : t.status === 'cancelled' ? 'cancelled' : 'pending',
    receivable_identifier: t.reference ?? '-',
  };
}

function readMeta(t: FinTransaction): Record<string, unknown> {
  const m = t.metadata;
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** Detalhe completo para edição de contas a receber (PDV). */
export function mapReceivableDetail(t: FinTransaction & { category: FinCategory | null }) {
  const meta = readMeta(t);
  const clientid = typeof meta.clientId === 'string' ? meta.clientId : '';
  const isRaw = meta.is_client;
  const is_client = isRaw === 0 || isRaw === '0' || isRaw === false ? 0 : 1;

  return {
    id: t.id,
    category: t.categoryId ?? '',
    amount: Number(t.amount),
    amount_base: Number(t.amount),
    reference_no: t.reference ?? '',
    note: t.note ?? '',
    receivable_identifier: t.reference ?? '',
    company: t.company,
    clientid,
    is_client,
    billable: 0,
    invoiceid: '',
    paymentmode: null,
    date: utcCalendarDateString(t.date),
    due_date: utcCalendarDateString(t.dueDate),
    reference_date: utcCalendarDateString(t.date),
    recurring_type: '',
    recurring: false,
    cycles: 0,
    custom_recurring: false,
    last_recurring_date: null,
    create_invoice_billable: false,
    send_invoice_to_customer: false,
    recurring_from: '',
    warehouse_id: t.warehouseId,
    due_day: 1,
    installments: '',
    consider_business_days: false,
    week_day: '',
    end_date: null,
    due_day_2: 1,
    bank_account_id: t.bankAccountId ?? '',
    receivables_document: typeof meta.receivables_document === 'string' ? meta.receivables_document : '',
    origin_id: '',
    registration_date: null,
    nfe_key: '',
    nfe_number: '',
    order_number: '',
    boleto_number: '',
    installment_number: '',
    barcode: '',
    currency: t.currency ?? 'BRL',
  };
}

/** Parcelas fiscais + cabeçalho para edição de contas a pagar. */
export function buildExpenseEditResponse(
  t: FinTransaction & { category: FinCategory | null },
  clientName: string
): {
  expense: Record<string, unknown>;
  fiscal_installments: Record<string, unknown>[];
  ac_installments: unknown[];
  client_name: string;
} {
  const meta = readMeta(t);
  const parcelasRaw = meta.parcelas_fiscais;
  const parcelas = Array.isArray(parcelasRaw) ? parcelasRaw : [];

  const fiscal_installments =
    parcelas.length > 0
      ? parcelas.map((p, i) => {
          const row = p as Record<string, unknown>;
          const num = Number(row.numero ?? i + 1);
          const valor = parseDecimal(row.valor_total ?? row.valor);
          return {
            id: String(row.id ?? `${t.id}-p-${i}`),
            numero_parcela: String(num),
            valor: valor ? Number(valor) : Number(t.amount),
            data_vencimento: String(row.data_vencimento ?? t.dueDate.toISOString().split('T')[0]),
            status: t.status === 'paid' ? 'Pago' : 'Pendente',
            formas_pagamento: Array.isArray(row.formas_pagamento) ? row.formas_pagamento : [],
            valores_formas: Array.isArray(row.valores_formas) ? row.valores_formas : [],
          };
        })
      : [
          {
            id: t.id,
            numero_parcela: '1',
            valor: Number(t.amount),
            data_vencimento: t.dueDate.toISOString().split('T')[0],
            status: t.status === 'paid' ? 'Pago' : 'Pendente',
            formas_pagamento: [] as unknown[],
            valores_formas: [] as unknown[],
          },
        ];

  const expense = {
    expense_name: typeof meta.expense_name === 'string' ? meta.expense_name : t.company,
    expense_identifier: t.reference ?? '',
    category: t.categoryId ?? '',
    reference_no: t.reference ?? '',
    note: t.note ?? '',
    amount: Number(t.amount),
    valor_ac: Number(meta.valor_ac ?? 0),
    date: t.date.toISOString().split('T')[0],
    reference_date:
      typeof meta.reference_date === 'string'
        ? meta.reference_date
        : t.date.toISOString().split('T')[0],
    bank_account_id: t.bankAccountId ?? '',
    paymentmode: Array.isArray(meta.paymentmode) ? meta.paymentmode : [],
    forma_pagamento_padrao_fiscal: Array.isArray(meta.forma_pagamento_padrao_fiscal)
      ? meta.forma_pagamento_padrao_fiscal
      : [],
    juros: Number(meta.juros ?? 0),
    tipo_juros: typeof meta.tipo_juros === 'string' ? meta.tipo_juros : 'simples',
    juros_apartir: Number(meta.juros_apartir ?? 1),
    clientid: typeof meta.clientid === 'string' ? meta.clientid : null,
    expense_document: typeof meta.expense_document === 'string' ? meta.expense_document : null,
    nfe_key: typeof meta.nfe_key === 'string' ? meta.nfe_key : '',
    nfe_number: typeof meta.nfe_number === 'string' ? meta.nfe_number : '',
    order_number: typeof meta.order_number === 'string' ? meta.order_number : '',
    boleto_number: typeof meta.boleto_number === 'string' ? meta.boleto_number : '',
    installment_number: typeof meta.installment_number === 'string' ? meta.installment_number : '',
    barcode: typeof meta.barcode === 'string' ? meta.barcode : '',
    registration_date:
      typeof meta.registration_date === 'string' ? meta.registration_date : null,
    billable: 0,
    create_invoice_billable: 0,
    send_invoice_to_customer: 0,
    num_parcelas: fiscal_installments.length,
    installments: fiscal_installments.map((fi, idx) => ({
      id: fi.id,
      numero_parcela: fi.numero_parcela,
      valor_parcela: fi.valor,
      status: fi.status,
      data_vencimento: fi.data_vencimento,
      valor_pago: t.status === 'paid' && idx === 0 ? fi.valor : 0,
      data_pagamento: t.status === 'paid' && idx === 0 && t.paidAt ? t.paidAt.toISOString() : null,
    })),
  };

  return {
    expense,
    fiscal_installments,
    ac_installments: [],
    client_name: clientName,
  };
}

export function mapExpenseRow(t: FinTransaction & { category: FinCategory | null }) {
  const meta = readMeta(t);
  const totalInst =
    typeof meta.total_parcelas === 'number'
      ? meta.total_parcelas
      : Array.isArray(meta.parcelas_fiscais)
        ? (meta.parcelas_fiscais as unknown[]).length
        : 1;
  const paidInst = t.status === 'paid' ? totalInst : 0;

  return {
    id: t.id,
    type: 'despesa',
    adjusted_status: t.status,
    paid_installments: paidInst,
    total_installments: totalInst,
    company: t.company,
    amount: Number(t.amount),
    date: t.date.toISOString(),
    due_date: t.dueDate.toISOString(),
    category: t.categoryId,
    category_name: t.category?.name ?? null,
    note: t.note ?? '',
    payment_mode_name: 'N/A',
    payment_mode_name_dup: 'N/A',
    paymentmode: null,
    status: t.status === 'paid' ? 'paid' : t.status === 'cancelled' ? 'cancelled' : 'pending',
    file: null,
    expense_identifier: t.reference ?? '-',
    recurring: '0',
    recurring_type: null,
    repeat_every: null,
    cycles: null,
    total_cycles: null,
    custom_recurring: '0',
    last_recurring_date: null,
  };
}

/** Limites UTC do dia a partir de `YYYY-MM-DD` (compatível com filtros do calendário). */
export function utcDayBoundsFromDateString(dateStr: string): { start: Date; end: Date } | null {
  const s = String(dateStr ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const start = new Date(`${s}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * Converte entrada de data financeira: `YYYY-MM-DD` → meia-noite UTC (igual ao filtro do calendário).
 * Evita deslocar o dia ao gravar vencimentos vindos do CRM/PDV.
 */
export function parseFinDateInput(raw: string | undefined | null): Date | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00.000Z`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDecimal(v: unknown): Prisma.Decimal | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return new Prisma.Decimal(n);
}
