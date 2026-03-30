import { randomUUID } from "node:crypto";
import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveDefaultWarehouseId } from "../lib/crm-lead-sync.js";
import {
  calculateVisitorIntentScore,
  getLeadTemperature,
} from "../lib/tracking-score.js";
import { formatPropriedade } from "./propriedades.js";
import { resolvePropertyMediaPublicUrl } from "../lib/storage.js";
import { maybeAssignLeadFromRules } from "../lib/lead-distribution.js";

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

type CrmWhere = Record<string, unknown>;

function warehouseScope(warehouseId: string | null | undefined): CrmWhere {
  const w = warehouseId?.trim();
  if (!w) return {};
  return { warehouseId: w };
}

/** Normaliza string numérica BR (ex.: "1.500,50") para ponto decimal. */
function normalizeBrDecimalString(raw: string): string {
  let t = raw.trim().replace(/\s/g, "");
  if (!t) return "";
  if (t.includes(",") && t.includes(".")) {
    if (t.lastIndexOf(",") > t.lastIndexOf(".")) {
      t = t.replace(/\./g, "").replace(",", ".");
    }
  } else if (t.includes(",") && !t.includes(".")) {
    t = t.replace(",", ".");
  }
  return t;
}

/** Aceita número ou string (inclui formato BR) — evita Prisma.Decimal inválido no create/update. */
function parseOptionalDecimalOrNull(value: unknown): Prisma.Decimal | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    try {
      return new Prisma.Decimal(String(value));
    } catch {
      return null;
    }
  }
  const s = normalizeBrDecimalString(String(value));
  if (s === "" || s === "NaN") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  try {
    return new Prisma.Decimal(s);
  } catch {
    return null;
  }
}

function parseOptionalProbability(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** DECIMAL(14,2) — máx. 999.999.999.999,99 (PostgreSQL: < 10^12 em magnitude). */
const MAX_DEAL_VALUE = new Prisma.Decimal("999999999999.99");
/** DECIMAL(5,2) — commission_pct */
const MAX_COMMISSION_PCT = new Prisma.Decimal("999.99");

function assertWithinDecimalColumn(
  d: Prisma.Decimal | null,
  maxAbs: Prisma.Decimal,
  messagePt: string
): void {
  if (d === null) return;
  if (d.abs().gt(maxAbs)) {
    const err = new Error(messagePt);
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }
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

const DEAL_STAGES = new Set([
  "prospeccao",
  "proposta",
  "negociacao",
  "fechado_ganho",
  "fechado_perdido",
  "transferido",
]);
const INTERACTION_TYPES = new Set([
  "ligacao",
  "email",
  "reuniao",
  "nota",
  "whatsapp",
]);
/** Colunas do Kanban de interações (CRM). */
const INTERACTION_KANBAN_STATUSES = new Set([
  "registrada",
  "em_andamento",
  "aguardando_retorno",
  "concluida",
]);
const TASK_KINDS = new Set(["reuniao", "ligacao", "tarefa", "visita", "email"]);
const TASK_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

/** Campos do imóvel para card CRM (negócio / visão geral). */
export const CRM_DEAL_PROPERTY_SELECT = {
  id: true,
  ref: true,
  slug: true,
  title: true,
  description: true,
  type: true,
  transactionTypes: true,
  status: true,
  propertyType: true,
  price: true,
  priceVenda: true,
  priceAluguel: true,
  priceCrowdfunding: true,
  area: true,
  bedrooms: true,
  suites: true,
  demiSuites: true,
  bathrooms: true,
  garage: true,
  address: true,
  numero: true,
  neighborhood: true,
  city: true,
  state: true,
  zip: true,
  builder: true,
  warehouseId: true,
  proprietarioId: true,
  comodidades: true,
  mobiliado: true,
  aceita_pets: true,
  aceita_permuta: true,
  em_construcao: true,
  parceria: true,
  dataPrevistaEntrega: true,
  tagImovel: true,
  latitude: true,
  longitude: true,
  ownerSubmissionStatus: true,
  media: {
    orderBy: { sortOrder: "asc" as const },
    take: 3,
    select: { url: true },
  },
} as const;

function imovelSnapshotFromProperty(
  p: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!p || typeof p !== "object" || !p.id) return undefined;
  const row = formatPropriedade(p as Parameters<typeof formatPropriedade>[0]);
  const media = p.media as { url: string }[] | undefined;
  const foto =
    Array.isArray(media) && media[0]?.url
      ? resolvePropertyMediaPublicUrl(String(media[0].url))
      : null;
  return { ...(row as Record<string, unknown>), foto_url: foto };
}

function buildDefaultFinanceiroV2(deal: {
  value: Prisma.Decimal | null;
  commissionPct: Prisma.Decimal | null | undefined;
}): Record<string, unknown> {
  const total =
    deal.value != null && !Number.isNaN(Number(deal.value))
      ? Number(deal.value)
      : 0;
  const pct =
    deal.commissionPct != null && !Number.isNaN(Number(deal.commissionPct))
      ? Number(deal.commissionPct)
      : 0;
  const comissao = Math.round((total * pct) / 100 * 100) / 100;
  return {
    v: 2,
    resumo: {
      total_negocio: total,
      recebido: 0,
      aberto: total,
      comissao,
    },
    parcelas: [],
    comissao_dividida: [],
    historico: [],
  };
}

function buildDefaultDocumentosV2(): Record<string, unknown> {
  const cid = () => randomUUID();
  const mk = (titulo: string) => ({
    id: cid(),
    titulo,
    status: "pendente",
    arquivo_url: null as string | null,
    nome_arquivo: null as string | null,
  });
  return {
    v: 2,
    itens: [
      mk("RG / CPF comprador"),
      mk("RG / CPF vendedor"),
      mk("Matrícula do imóvel"),
      mk("IPTU"),
      mk("Contrato assinado"),
    ],
  };
}

function buildDefaultPipelineKanbanState(deal: {
  title: string;
  value: Prisma.Decimal | null;
  currency: string;
  transactionType: string | null;
  commissionPct?: Prisma.Decimal | null;
}): Record<string, unknown> {
  const cid = () => randomUUID();
  const valor =
    deal.value != null
      ? Number(deal.value).toLocaleString("pt-BR", {
          style: "currency",
          currency: deal.currency?.trim() || "BRL",
        })
      : "—";
  const tipo = deal.transactionType?.trim() || "negócio";
  return {
    contrato: [
      {
        id: "rascunho",
        label: "Rascunho",
        cards: [
          {
            id: cid(),
            titulo: `Contrato — ${deal.title}`,
            subtitulo: `Gerado após fechamento (${tipo})`,
          },
        ],
      },
      { id: "revisao", label: "Em revisão", cards: [] },
      { id: "assinatura", label: "Aguardando assinatura", cards: [] },
      { id: "assinado", label: "Assinado", cards: [] },
    ],
    financeiro: buildDefaultFinanceiroV2({
      value: deal.value,
      commissionPct: deal.commissionPct,
    }),
    documentos: buildDefaultDocumentosV2(),
  };
}

function isValidFinanceiroSection(f: unknown): boolean {
  if (Array.isArray(f)) return true;
  if (f && typeof f === "object" && !Array.isArray(f)) {
    const o = f as Record<string, unknown>;
    return Array.isArray(o.parcelas);
  }
  return false;
}

function isValidDocumentosSection(d: unknown): boolean {
  if (Array.isArray(d)) return true;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const o = d as Record<string, unknown>;
    return Array.isArray(o.itens);
  }
  return false;
}

function dealNeedsDefaultPipelineKanbanState(stage: string, pk: unknown): boolean {
  if (stage !== "fechado_ganho") return false;
  if (pk == null) return true;
  if (typeof pk !== "object" || Array.isArray(pk)) return true;
  const o = pk as Record<string, unknown>;
  if (!Array.isArray(o.contrato)) {
    return true;
  }
  if (!isValidDocumentosSection(o.documentos)) {
    return true;
  }
  if (!isValidFinanceiroSection(o.financeiro)) {
    return true;
  }
  return false;
}

export type DealForPipelineBackfill = {
  id: string;
  stage: string;
  pipelineKanbanState?: unknown | null;
  title: string;
  value: Prisma.Decimal | null;
  currency: string;
  transactionType: string | null;
  commissionPct?: Prisma.Decimal | null;
};

/**
 * Persiste o JSON padrão de Contrato/Financeiro/Documentos quando o negócio está ganho e ainda não tem estado válido.
 * Usado no GET do lead e no GET do negócio para corrigir deals antigos ou criados sem o hook de fechamento.
 */
export async function ensureDealPipelineKanbanStateIfWon(
  deal: DealForPipelineBackfill
): Promise<void> {
  if (!dealNeedsDefaultPipelineKanbanState(deal.stage, deal.pipelineKanbanState)) return;
  const defaultState = buildDefaultPipelineKanbanState({
    title: deal.title,
    value: deal.value,
    currency: deal.currency,
    transactionType: deal.transactionType,
    commissionPct: deal.commissionPct,
  }) as Prisma.InputJsonValue;
  await (prisma.crmLeadDeal as any).update({
    where: { id: deal.id },
    data: { pipelineKanbanState: defaultState },
  });
  (deal as { pipelineKanbanState?: unknown }).pipelineKanbanState = defaultState;
}

export async function ensureWonDealsPipelineKanbanInPlace(
  deals: DealForPipelineBackfill[]
): Promise<void> {
  await Promise.all(deals.map((d) => ensureDealPipelineKanbanStateIfWon(d)));
}

export function dealToFrontend(d: {
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
  propertyId?: string | null;
  property?: Record<string, unknown> | null;
  responsible: string | null;
  commissionPct: Prisma.Decimal | null;
  paymentMethod: string | null;
  pipelineKanbanState?: unknown;
}) {
  const prop = d.property as
    | { ref?: string | null; title?: string; id?: string }
    | null
    | undefined;
  const refFromLink = prop?.ref?.trim() || null;
  const tituloImovel = prop?.title ?? undefined;
  const imovel = imovelSnapshotFromProperty(
    d.property as Record<string, unknown> | null | undefined
  );
  return {
    id: d.id,
    titulo: d.title,
    valor: d.value != null ? Number(d.value) : 0,
    etapa: d.stage,
    data: (d.expectedCloseAt ?? d.createdAt).toISOString(),
    moeda: d.currency,
    probabilidade: d.probability ?? undefined,
    tipo_transacao: d.transactionType ?? undefined,
    property_id: (d.propertyId ?? prop?.id) || undefined,
    propriedade_ref: refFromLink ?? d.propertyRef ?? undefined,
    propriedade_titulo: tituloImovel,
    imovel,
    responsavel: d.responsible ?? undefined,
    descricao: d.description ?? undefined,
    observacoes_internas: d.internalNotes ?? undefined,
    comissao_percentual:
      d.commissionPct != null && !Number.isNaN(Number(d.commissionPct))
        ? String(d.commissionPct)
        : "",
    forma_pagamento: d.paymentMethod ?? "",
    data_prevista_fechamento: d.expectedCloseAt?.toISOString() ?? null,
    pipeline_kanban:
      d.pipelineKanbanState != null &&
      typeof d.pipelineKanbanState === "object" &&
      !Array.isArray(d.pipelineKanbanState)
        ? (d.pipelineKanbanState as Record<string, unknown>)
        : null,
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
  crmLeadDealId?: string | null;
  status?: string | null;
  crmLeadDeal?: { id: string; title: string } | null;
}) {
  const stRaw = i.status;
  const st =
    stRaw && INTERACTION_KANBAN_STATUSES.has(String(stRaw))
      ? String(stRaw)
      : "registrada";
  return {
    id: i.id,
    tipo: i.type,
    titulo: i.title,
    data: i.createdAt.toISOString(),
    autor: i.authorName || i.createdBy?.name || "-",
    descricao: i.description ?? "",
    negocio_id: i.crmLeadDealId ?? null,
    negocio_titulo: i.crmLeadDeal?.title ?? null,
    status: st,
  };
}

function taskToFrontend(t: {
  id: string;
  crmLeadId?: string;
  title: string;
  kind: string;
  scheduledAt: Date;
  done: boolean;
  description: string | null;
  local: string | null;
  reminderMinutes: number | null;
  negocioRef: string | null;
  checkedInAt?: Date | null;
  reminderSentAt?: Date | null;
  whatsappConfirmationSentAt?: Date | null;
  priority?: string;
  participantUserIds?: unknown;
}) {
  const full = t.description ?? "";
  const parts = full.split("\n\n");
  const rawP = (t as { priority?: string }).priority;
  const priority = TASK_PRIORITIES.has(String(rawP || ""))
    ? String(rawP)
    : "normal";
  const pids = (t as { participantUserIds?: unknown }).participantUserIds;
  const participantes = Array.isArray(pids)
    ? (pids as unknown[]).map((x) => String(x))
    : [];
  return {
    id: t.id,
    lead_id: t.crmLeadId,
    titulo: t.title,
    tipo: t.kind,
    data: t.scheduledAt.toISOString(),
    concluido: t.done,
    descricao: parts[0] ?? "",
    observacoes: parts.slice(1).join("\n\n") || "",
    lembrete_minutos: t.reminderMinutes,
    local: t.local ?? "",
    negocio_ref: t.negocioRef ?? "",
    prioridade: priority,
    participantes,
    check_in_em: t.checkedInAt?.toISOString() ?? null,
    lembrete_enviado_em: t.reminderSentAt?.toISOString() ?? null,
    whatsapp_confirmacao_em:
      t.whatsappConfirmationSentAt?.toISOString() ?? null,
  };
}

const TASK_KIND_CALENDAR_COLOR: Record<string, string> = {
  visita: "#ed6c02",
  reuniao: "#1565c0",
  ligacao: "#2e7d32",
  tarefa: "#7b1fa2",
  email: "#00838f",
};

function maxDate(dates: (Date | null | undefined)[]): Date | null {
  const valid = dates.filter(
    (d): d is Date => d instanceof Date && !Number.isNaN(d.getTime())
  );
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function toListRow(lead: {
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
}) {
  return {
    id: lead.id,
    nome: lead.name ?? "-",
    name: lead.name,
    email: lead.email,
    status: lead.pipelineStage,
    origem: lead.source,
    cpf: lead.cpf,
    telefone: lead.phone,
    phone: lead.phone,
    anuncio: lead.adTitle ?? "-",
    anuncio_imagem: lead.adImageUrl,
    anuncio_local: lead.adLocation,
    score: lead.score,
    ultima_interacao: lead.lastInteractionAt?.toISOString() ?? null,
    responsavel: lead.assignedUser?.name ?? "-",
  };
}

/**
 * POST /api/leads/list/ — lista paginada (contrato do PDV).
 */
router.post("/list/", async (req: Request, res: Response, next) => {
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

    const onlyOwn =
      body.only_own === true ||
      body.only_own === "1" ||
      body.only_own === "true";
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
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
      ];
    }

    const sortField = body.sortField || "createdAt";
    const sortDir = body.sortOrder?.toUpperCase() === "ASC" ? "asc" : "desc";
    const orderBy: Record<string, string> =
      sortField === "nome" || sortField === "name"
        ? { name: sortDir }
        : sortField === "score"
          ? { score: sortDir }
          : sortField === "ultima_interacao"
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
router.get("/get/:id/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    /* Inclui property nos deals — tipos completos após `npx prisma generate` */
    const lead = await (prisma.crmLead as any).findFirst({
      where: { id, ...warehouseScope(wh) },
      include: {
        assignedUser: { select: { id: true, name: true, email: true } },
        deals: {
          orderBy: { createdAt: "desc" },
          include: { property: { select: CRM_DEAL_PROPERTY_SELECT } },
        },
        interactions: {
          orderBy: { createdAt: "desc" },
          include: {
            createdBy: { select: { name: true } },
            crmLeadDeal: { select: { id: true, title: true } },
          },
        },
        tasks: { orderBy: { scheduledAt: "desc" } },
      },
    });

    if (!lead) {
      res.status(404).json({ success: false, message: "Lead não encontrado" });
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
    let scoreSource: "tracking" | "crm" = "crm";

    if (lead.trackingVisitorId) {
      scoreIntent = await calculateVisitorIntentScore(lead.trackingVisitorId);
      temperature = getLeadTemperature(scoreIntent);
      scoreSource = "tracking";
      if (scoreIntent !== lead.score) {
        await prisma.crmLead
          .update({ where: { id: lead.id }, data: { score: scoreIntent } })
          .catch(() => {});
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
          orderBy: { createdAt: "desc" },
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

    await ensureWonDealsPipelineKanbanInPlace(
      lead.deals as DealForPipelineBackfill[]
    );

    res.json({
      data: {
        id: lead.id,
        nome: lead.name ?? "",
        name: lead.name,
        email: lead.email ?? "",
        telefone: lead.phone ?? "",
        cpf: lead.cpf ?? "",
        status: lead.pipelineStage,
        origem: lead.source,
        anuncio: lead.adTitle ?? "",
        anuncio_imagem: lead.adImageUrl,
        anuncio_local: lead.adLocation,
        score: scoreIntent,
        score_source: scoreSource,
        temperature,
        ultima_interacao:
          ultima?.toISOString() ??
          lead.lastInteractionAt?.toISOString() ??
          null,
        responsavel: lead.assignedUser?.name ?? "",
        observacoes: lead.notes ?? "",
        sourceDetail,
        metaLeadId: lead.metaLeadId,
        metaFormId: lead.metaFormId,
        proxima_acao_obrigatoria: Boolean(
          (lead as { nextActionRequired?: boolean }).nextActionRequired
        ),
        proxima_acao_nota:
          (lead as { nextActionNote?: string | null }).nextActionNote ?? "",
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
router.post("/create/", async (req: Request, res: Response, next) => {
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
      assigned_user_id?: string | null;
    };

    const warehouseId =
      body.warehouse_id ||
      user.warehouseId ||
      (await resolveDefaultWarehouseId());

    const assignedManual =
      body.assigned_user_id != null && String(body.assigned_user_id).trim() !== ""
        ? String(body.assigned_user_id).trim()
        : null;

    const lead = await crm.crmLead.create({
      data: {
        warehouseId,
        name: (body.nome || body.name || "").trim() || null,
        email: body.email?.trim() || null,
        phone: body.telefone?.trim() || null,
        cpf: body.cpf?.trim() || null,
        pipelineStage: body.status?.trim() || "novo",
        source: body.origem?.trim() || "manual",
        adTitle: body.anuncio?.trim() || null,
        score:
          typeof body.score === "number" && Number.isFinite(body.score)
            ? Math.round(body.score)
            : 0,
        notes: body.observacoes?.trim() || null,
        lastInteractionAt: new Date(),
        ...(assignedManual ? { assignedUserId: assignedManual } : {}),
      },
    });

    if (!assignedManual) {
      await maybeAssignLeadFromRules(lead.id);
    }

    res.status(201).json({ success: true, data: { id: lead.id } });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/update/:id/
 */
router.put("/update/:id/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const id = req.params.id;
    const wh = user.warehouseId || undefined;

    const existing = (await crm.crmLead.findFirst({
      where: { id, ...warehouseScope(wh) },
      select: {
        id: true,
        pipelineStage: true,
        source: true,
        warehouseId: true,
      },
    })) as {
      id: string;
      pipelineStage: string;
      source: string;
      warehouseId: string | null;
    } | null;
    if (!existing) {
      res.status(404).json({ success: false, message: "Lead não encontrado" });
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
      /** ID do usuário colaborador (mesma loja do lead quando ambos têm warehouse). */
      assigned_user_id?: string | null;
      proxima_acao_obrigatoria?: boolean;
      proxima_acao_nota?: string | null;
    };

    let assignedUserId: string | null | undefined = undefined;
    if (body.assigned_user_id !== undefined) {
      const raw = body.assigned_user_id;
      if (raw === null || raw === "") {
        assignedUserId = null;
      } else {
        const uid = String(raw).trim();
        const assignee = await prisma.user.findFirst({
          where: { id: uid, active: true },
          select: { id: true, warehouseId: true },
        });
        if (!assignee) {
          res
            .status(400)
            .json({
              success: false,
              message: "Colaborador não encontrado ou inativo",
            });
          return;
        }
        const lw = existing.warehouseId;
        const uw = assignee.warehouseId;
        if (lw && uw && lw !== uw) {
          res
            .status(400)
            .json({
              success: false,
              message: "Colaborador é de outra imobiliária",
            });
          return;
        }
        assignedUserId = assignee.id;
      }
    }

    await crm.crmLead.update({
      where: { id },
      data: {
        name:
          body.nome !== undefined || body.name !== undefined
            ? (body.nome || body.name || "").trim() || null
            : undefined,
        email:
          body.email !== undefined ? body.email?.trim() || null : undefined,
        phone:
          body.telefone !== undefined
            ? body.telefone?.trim() || null
            : undefined,
        cpf: body.cpf !== undefined ? body.cpf?.trim() || null : undefined,
        pipelineStage:
          body.status !== undefined
            ? body.status?.trim() || existing.pipelineStage
            : undefined,
        source:
          body.origem !== undefined
            ? body.origem?.trim() || existing.source
            : undefined,
        adTitle:
          body.anuncio !== undefined ? body.anuncio?.trim() || null : undefined,
        score:
          body.score !== undefined &&
          body.score !== null &&
          String(body.score).trim() !== "" &&
          Number.isFinite(Number(body.score))
            ? Math.round(Number(body.score))
            : undefined,
        notes:
          body.observacoes !== undefined
            ? body.observacoes?.trim() || null
            : undefined,
        ...(assignedUserId !== undefined ? { assignedUserId } : {}),
        ...(body.proxima_acao_obrigatoria !== undefined
          ? { nextActionRequired: Boolean(body.proxima_acao_obrigatoria) }
          : {}),
        ...(body.proxima_acao_nota !== undefined
          ? { nextActionNote: body.proxima_acao_nota?.trim() || null }
          : {}),
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
router.post("/remove/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { rows?: string[]; warehouse_id?: string };
    const ids = Array.isArray(body.rows)
      ? body.rows.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, message: "Nenhum id informado" });
      return;
    }

    const wh = (body.warehouse_id || user.warehouseId || "").trim() || undefined;
    /** Leads do site/sync podem ter `warehouse_id` null; o filtro só por loja impedia apagar (0 linhas) com 200 OK. */
    const where: Prisma.CrmLeadWhereInput = {
      id: { in: ids },
      ...(wh
        ? {
            OR: [{ warehouseId: wh }, { warehouseId: null }],
          }
        : {}),
    };

    /**
     * O PDV lista `crm_leads`; o tracking fica em `Lead` + `Visitor`.
     * Só apagar `CrmLead` deixava a linha em `public.Lead` (pgAdmin).
     * Após remover o CRM, removemos o `Visitor` vinculado (`trackingVisitorId`) — cascade apaga `Lead`, eventos e sessões.
     */
    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.crmLead.findMany({
        where,
        select: { trackingVisitorId: true },
      });
      const visitorIds = [
        ...new Set(
          rows
            .map((r) => r.trackingVisitorId)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        ),
      ];
      const del = await tx.crmLead.deleteMany({ where });
      if (visitorIds.length > 0) {
        await tx.visitor.deleteMany({ where: { id: { in: visitorIds } } });
      }
      return del;
    });

    if (result.count === 0) {
      res.status(400).json({
        success: false,
        message:
          "Nenhum lead foi excluído: IDs inexistentes, sem permissão de loja ou base diferente da API. Confira o pgAdmin na mesma DATABASE_URL do backend.",
        deleted: 0,
      });
      return;
    }
    res.json({ success: true, deleted: result.count });
  } catch (e) {
    next(e);
  }
});

async function assertCrmLeadAccess(
  leadId: string,
  warehouseId: string | null | undefined
) {
  return prisma.crmLead.findFirst({
    where: { id: leadId, ...warehouseScope(warehouseId || undefined) },
  });
}

/** Imóvel existente e, se o lead tiver warehouse, da mesma base. */
async function resolvePropertyForCrmDeal(
  leadWarehouseId: string | null | undefined,
  propertyId: string
): Promise<{ id: string; ref: string | null } | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const prop = await prisma.property.findFirst({
    where: { id },
    select: { id: true, ref: true, warehouseId: true },
  });
  if (!prop) return null;
  const wh = leadWarehouseId?.trim();
  if (wh && prop.warehouseId !== wh) return null;
  return { id: prop.id, ref: prop.ref };
}

/**
 * POST /api/leads/deal/create/
 */
router.post("/deal/create/", async (req: Request, res: Response, next) => {
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
      property_id?: string | null;
      propriedade_ref?: string;
      responsavel?: string;
      descricao?: string;
      observacoes_internas?: string;
      comissao_percentual?: number | string;
      forma_pagamento?: string;
      probabilidade?: number;
    };

    const leadId = String(body.lead_id || "").trim();
    if (!leadId) {
      res.status(400).json({ success: false, message: "lead_id obrigatório" });
      return;
    }

    const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
    if (!lead) {
      res.status(404).json({ success: false, message: "Lead não encontrado" });
      return;
    }

    const titulo = String(body.titulo || "").trim();
    if (!titulo) {
      res.status(400).json({ success: false, message: "Título obrigatório" });
      return;
    }

    const etapa = DEAL_STAGES.has(String(body.etapa))
      ? String(body.etapa)
      : "prospeccao";
    const valor = parseOptionalDecimalOrNull(body.valor);
    const expectedClose = body.data_prevista_fechamento
      ? new Date(body.data_prevista_fechamento)
      : null;
    const commission = parseOptionalDecimalOrNull(body.comissao_percentual);

    let propertyId: string | null = null;
    let propertyRef: string | null = body.propriedade_ref?.trim() || null;
    const pidRaw = body.property_id;
    if (
      pidRaw !== undefined &&
      pidRaw !== null &&
      String(pidRaw).trim() !== ""
    ) {
      const resolved = await resolvePropertyForCrmDeal(
        lead.warehouseId,
        String(pidRaw)
      );
      if (!resolved) {
        res.status(400).json({
          success: false,
          message: "Imóvel não encontrado ou não pertence à mesma base do lead",
        });
        return;
      }
      propertyId = resolved.id;
      propertyRef = resolved.ref?.trim() || propertyRef;
    }

    try {
      assertWithinDecimalColumn(
        valor,
        MAX_DEAL_VALUE,
        "O valor do negócio excede o limite permitido (máximo 999.999.999.999,99)."
      );
      assertWithinDecimalColumn(
        commission,
        MAX_COMMISSION_PCT,
        "A comissão (%) excede o limite permitido (máximo 999,99)."
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Dados inválidos";
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 400) {
        res.status(400).json({ success: false, message: msg });
        return;
      }
      throw e;
    }

    const deal = await prisma.crmLeadDeal.create({
      data: {
        crmLeadId: leadId,
        title: titulo,
        value: valor,
        currency: (body.moeda || "BRL").trim() || "BRL",
        stage: etapa,
        expectedCloseAt:
          expectedClose && !Number.isNaN(expectedClose.getTime())
            ? expectedClose
            : null,
        transactionType: body.tipo_transacao?.trim() || null,
        propertyId,
        propertyRef,
        responsible: body.responsavel?.trim() || null,
        description: body.descricao?.trim() || null,
        internalNotes: body.observacoes_internas?.trim() || null,
        probability: parseOptionalProbability(body.probabilidade),
        commissionPct: commission,
        paymentMethod: body.forma_pagamento?.trim() || null,
      } as any,
    });

    await prisma.crmLead.update({
      where: { id: leadId },
      data: { lastInteractionAt: new Date() },
    });

    const createdFull = await (prisma.crmLeadDeal as any).findUnique({
      where: { id: deal.id },
      include: { property: { select: CRM_DEAL_PROPERTY_SELECT } },
    });

    res.status(201).json({ success: true, data: dealToFrontend(createdFull) });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/deal/update/:id/
 */
router.put("/deal/update/:id/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const dealId = req.params.id;

    const existing = await prisma.crmLeadDeal.findFirst({
      where: { id: dealId },
      include: { crmLead: { select: { id: true, warehouseId: true } } },
    });
    if (!existing) {
      res
        .status(404)
        .json({ success: false, message: "Negócio não encontrado" });
      return;
    }

    const ok = await assertCrmLeadAccess(existing.crmLead.id, user.warehouseId);
    if (!ok) {
      res
        .status(404)
        .json({ success: false, message: "Negócio não encontrado" });
      return;
    }

    const body = req.body as {
      titulo?: string;
      valor?: number | string;
      moeda?: string;
      etapa?: string;
      data_prevista_fechamento?: string | null;
      tipo_transacao?: string;
      property_id?: string | null;
      propriedade_ref?: string;
      responsavel?: string;
      descricao?: string;
      observacoes_internas?: string;
      comissao_percentual?: number | string;
      forma_pagamento?: string;
      probabilidade?: number;
      pipeline_kanban?: unknown;
    };

    const data: Prisma.CrmLeadDealUpdateInput & Record<string, unknown> =
      {} as any;

    if (body.titulo !== undefined)
      data.title = String(body.titulo || "").trim() || existing.title;
    if (body.etapa !== undefined) {
      data.stage = DEAL_STAGES.has(String(body.etapa))
        ? String(body.etapa)
        : existing.stage;
    }
    if (body.valor !== undefined) {
      data.value = parseOptionalDecimalOrNull(body.valor);
    }
    if (body.moeda !== undefined)
      data.currency = String(body.moeda || "BRL").trim() || "BRL";
    if (body.data_prevista_fechamento !== undefined) {
      const d = body.data_prevista_fechamento
        ? new Date(body.data_prevista_fechamento)
        : null;
      data.expectedCloseAt = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    if (body.tipo_transacao !== undefined)
      data.transactionType = body.tipo_transacao?.trim() || null;

    if (body.property_id !== undefined) {
      const raw = body.property_id;
      if (raw === null || String(raw).trim() === "") {
        data.propertyId = null;
        if (body.propriedade_ref !== undefined) {
          data.propertyRef = body.propriedade_ref?.trim() || null;
        }
      } else {
        const resolved = await resolvePropertyForCrmDeal(
          existing.crmLead.warehouseId,
          String(raw)
        );
        if (!resolved) {
          res.status(400).json({
            success: false,
            message:
              "Imóvel não encontrado ou não pertence à mesma base do lead",
          });
          return;
        }
        data.propertyId = resolved.id;
        data.propertyRef = resolved.ref?.trim() || null;
      }
    } else if (body.propriedade_ref !== undefined) {
      data.propertyRef = body.propriedade_ref?.trim() || null;
      data.propertyId = null;
    }

    if (body.responsavel !== undefined)
      data.responsible = body.responsavel?.trim() || null;
    if (body.descricao !== undefined)
      data.description = body.descricao?.trim() || null;
    if (body.observacoes_internas !== undefined)
      data.internalNotes = body.observacoes_internas?.trim() || null;
    if (body.forma_pagamento !== undefined)
      data.paymentMethod = body.forma_pagamento?.trim() || null;
    if (body.probabilidade !== undefined) {
      data.probability = parseOptionalProbability(body.probabilidade);
    }
    if (body.comissao_percentual !== undefined) {
      data.commissionPct = parseOptionalDecimalOrNull(body.comissao_percentual);
    }

    if (body.pipeline_kanban !== undefined) {
      if (body.pipeline_kanban === null) {
        data.pipelineKanbanState = Prisma.JsonNull;
      } else if (
        typeof body.pipeline_kanban === "object" &&
        !Array.isArray(body.pipeline_kanban)
      ) {
        data.pipelineKanbanState = body.pipeline_kanban as Prisma.InputJsonValue;
      } else {
        res.status(400).json({
          success: false,
          message: "pipeline_kanban deve ser um objeto JSON",
        });
        return;
      }
    } else {
      const ex = existing as typeof existing & {
        pipelineKanbanState?: unknown | null;
      };
      const effectiveStage =
        data.stage !== undefined ? String(data.stage) : existing.stage;
      const becameWon =
        effectiveStage === "fechado_ganho" && existing.stage !== "fechado_ganho";
      if (
        becameWon &&
        dealNeedsDefaultPipelineKanbanState(
          effectiveStage,
          ex.pipelineKanbanState
        )
      ) {
        const mergedTitle =
          data.title !== undefined
            ? String(data.title)
            : String(existing.title);
        const mergedValue =
          data.value !== undefined
            ? (data.value as Prisma.Decimal | null)
            : existing.value;
        const mergedCurrency =
          data.currency !== undefined
            ? String(data.currency)
            : existing.currency;
        const mergedTx =
          data.transactionType !== undefined
            ? (data.transactionType as string | null)
            : existing.transactionType;
        const mergedCommissionPct =
          body.comissao_percentual !== undefined
            ? parseOptionalDecimalOrNull(body.comissao_percentual)
            : existing.commissionPct;
        data.pipelineKanbanState = buildDefaultPipelineKanbanState({
          title: mergedTitle,
          value: mergedValue,
          currency: mergedCurrency,
          transactionType: mergedTx,
          commissionPct: mergedCommissionPct,
        }) as Prisma.InputJsonValue;
      }
    }

    try {
      if (data.value !== undefined) {
        assertWithinDecimalColumn(
          data.value as Prisma.Decimal | null,
          MAX_DEAL_VALUE,
          "O valor do negócio excede o limite permitido (máximo 999.999.999.999,99)."
        );
      }
      if (data.commissionPct !== undefined) {
        assertWithinDecimalColumn(
          data.commissionPct as Prisma.Decimal | null,
          MAX_COMMISSION_PCT,
          "A comissão (%) excede o limite permitido (máximo 999,99)."
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Dados inválidos";
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 400) {
        res.status(400).json({ success: false, message: msg });
        return;
      }
      throw e;
    }

    await prisma.crmLeadDeal.update({
      where: { id: dealId },
      data: data as any,
    });

    await prisma.crmLead.update({
      where: { id: existing.crmLead.id },
      data: { lastInteractionAt: new Date() },
    });

    const updatedFull = await (prisma.crmLeadDeal as any).findUnique({
      where: { id: dealId },
      include: { property: { select: CRM_DEAL_PROPERTY_SELECT } },
    });

    res.json({ success: true, data: dealToFrontend(updatedFull) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/deal/ensure-pipeline-kanban/:id/
 * Idempotente: se o negócio está em fechado_ganho e ainda não tem pipeline_kanban_state, cria o padrão.
 */
router.post(
  "/deal/ensure-pipeline-kanban/:id/",
  async (req: Request, res: Response, next) => {
    try {
      const user = (req as Authed).user;
      const dealId = req.params.id;
      const existing = await prisma.crmLeadDeal.findFirst({
        where: { id: dealId },
        include: { crmLead: { select: { id: true, warehouseId: true } } },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, message: "Negócio não encontrado" });
        return;
      }
      const ok = await assertCrmLeadAccess(
        existing.crmLead.id,
        user.warehouseId
      );
      if (!ok) {
        res
          .status(404)
          .json({ success: false, message: "Negócio não encontrado" });
        return;
      }
      const ex = existing as typeof existing & {
        pipelineKanbanState?: unknown | null;
      };
      if (existing.stage !== "fechado_ganho") {
        res.json({ success: true, data: { skipped: true } });
        return;
      }
      if (
        !dealNeedsDefaultPipelineKanbanState(
          existing.stage,
          ex.pipelineKanbanState
        )
      ) {
        const full = await (prisma.crmLeadDeal as any).findUnique({
          where: { id: dealId },
          include: { property: { select: CRM_DEAL_PROPERTY_SELECT } },
        });
        res.json({ success: true, data: dealToFrontend(full) });
        return;
      }
      const defaultState = buildDefaultPipelineKanbanState({
        title: existing.title,
        value: existing.value,
        currency: existing.currency,
        transactionType: existing.transactionType,
        commissionPct: existing.commissionPct,
      }) as Prisma.InputJsonValue;
      await (prisma.crmLeadDeal as any).update({
        where: { id: dealId },
        data: { pipelineKanbanState: defaultState },
      });
      await prisma.crmLead.update({
        where: { id: existing.crmLead.id },
        data: { lastInteractionAt: new Date() },
      });
      const updatedFull = await (prisma.crmLeadDeal as any).findUnique({
        where: { id: dealId },
        include: { property: { select: CRM_DEAL_PROPERTY_SELECT } },
      });
      res.json({ success: true, data: dealToFrontend(updatedFull) });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * POST /api/leads/deal/remove/
 * Body: { ids: string[] }
 */
router.post("/deal/remove/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { ids?: unknown };
    const raw = body.ids;
    const ids = [
      ...new Set(
        Array.isArray(raw)
          ? raw.map((x) => String(x).trim()).filter(Boolean)
          : []
      ),
    ];
    if (!ids.length) {
      res.status(400).json({ success: false, message: "ids obrigatório" });
      return;
    }

    const deals = await prisma.crmLeadDeal.findMany({
      where: { id: { in: ids } },
      include: { crmLead: { select: { id: true, warehouseId: true } } },
    });
    if (deals.length !== ids.length) {
      res.status(404).json({
        success: false,
        message: "Um ou mais negócios não foram encontrados",
      });
      return;
    }

    const leadIds = new Set<string>();
    for (const d of deals) {
      const ok = await assertCrmLeadAccess(d.crmLead.id, user.warehouseId);
      if (!ok) {
        res.status(404).json({
          success: false,
          message: "Um ou mais negócios não foram encontrados",
        });
        return;
      }
      leadIds.add(d.crmLead.id);
    }

    await prisma.crmLeadDeal.deleteMany({ where: { id: { in: ids } } });

    for (const lid of leadIds) {
      await prisma.crmLead.update({
        where: { id: lid },
        data: { lastInteractionAt: new Date() },
      });
    }

    res.json({ success: true, data: { removed: ids.length } });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/deal/transfer/
 * Body: { ids: string[], responsavel: string } — responsável = nome exibido (colaborador destino)
 */
router.post("/deal/transfer/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { ids?: unknown; responsavel?: string };
    const raw = body.ids;
    const ids = [
      ...new Set(
        Array.isArray(raw)
          ? raw.map((x) => String(x).trim()).filter(Boolean)
          : []
      ),
    ];
    const responsavel = String(body.responsavel || "").trim();
    if (!ids.length || !responsavel) {
      res.status(400).json({
        success: false,
        message: "ids e responsavel obrigatórios",
      });
      return;
    }

    const deals = await prisma.crmLeadDeal.findMany({
      where: { id: { in: ids } },
      include: { crmLead: { select: { id: true, warehouseId: true } } },
    });
    if (deals.length !== ids.length) {
      res.status(404).json({
        success: false,
        message: "Um ou mais negócios não foram encontrados",
      });
      return;
    }

    const leadIds = new Set<string>();
    for (const d of deals) {
      const ok = await assertCrmLeadAccess(d.crmLead.id, user.warehouseId);
      if (!ok) {
        res.status(404).json({
          success: false,
          message: "Um ou mais negócios não foram encontrados",
        });
        return;
      }
      leadIds.add(d.crmLead.id);
    }

    await prisma.crmLeadDeal.updateMany({
      where: { id: { in: ids } },
      data: {
        stage: "transferido",
        responsible: responsavel,
      },
    });

    for (const lid of leadIds) {
      await prisma.crmLead.update({
        where: { id: lid },
        data: { lastInteractionAt: new Date() },
      });
    }

    res.json({ success: true, data: { transferred: ids.length } });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/interaction/create/
 */
router.post(
  "/interaction/create/",
  async (req: Request, res: Response, next) => {
    try {
      const user = (req as Authed).user;
      const body = req.body as {
        lead_id?: string;
        tipo?: string;
        titulo?: string;
        descricao?: string;
        negocio_id?: string | null;
        status?: string;
      };

      const leadId = String(body.lead_id || "").trim();
      if (!leadId) {
        res
          .status(400)
          .json({ success: false, message: "lead_id obrigatório" });
        return;
      }

      const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
      if (!lead) {
        res
          .status(404)
          .json({ success: false, message: "Lead não encontrado" });
        return;
      }

      const titulo = String(body.titulo || "").trim();
      if (!titulo) {
        res.status(400).json({ success: false, message: "Título obrigatório" });
        return;
      }

      const tipo = INTERACTION_TYPES.has(String(body.tipo))
        ? String(body.tipo)
        : "nota";
      const author = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true },
      });

      let dealId: string | null = null;
      const rawNeg = body.negocio_id;
      if (rawNeg != null && String(rawNeg).trim() !== "") {
        const did = String(rawNeg).trim();
        const deal = await prisma.crmLeadDeal.findFirst({
          where: { id: did, crmLeadId: leadId },
          select: { id: true },
        });
        if (!deal) {
          res.status(400).json({
            success: false,
            message: "Negócio não pertence a este lead",
          });
          return;
        }
        dealId = deal.id;
      }

      const st =
        body.status && INTERACTION_KANBAN_STATUSES.has(String(body.status))
          ? String(body.status)
          : "registrada";

      const row = await prisma.crmLeadInteraction.create({
        data: {
          crmLeadId: leadId,
          crmLeadDealId: dealId,
          status: st,
          type: tipo,
          title: titulo,
          description: body.descricao?.trim() || null,
          authorName: author?.name ?? null,
          createdByUserId: user.id,
        },
        include: {
          createdBy: { select: { name: true } },
          crmLeadDeal: { select: { id: true, title: true } },
        },
      });

      await prisma.crmLead.update({
        where: { id: leadId },
        data: { lastInteractionAt: new Date() },
      });

      res.status(201).json({ success: true, data: interactionToFrontend(row) });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * PUT /api/leads/interaction/update/:id/
 * Atualiza status (Kanban), título, descrição e vínculo com negócio.
 */
router.put(
  "/interaction/update/:id/",
  async (req: Request, res: Response, next) => {
    try {
      const user = (req as Authed).user;
      const interactionId = String(req.params.id || "").trim();
      if (!interactionId) {
        res.status(400).json({ success: false, message: "id obrigatório" });
        return;
      }

      const existing = await prisma.crmLeadInteraction.findFirst({
        where: { id: interactionId },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, message: "Interação não encontrada" });
        return;
      }

      const leadOk = await assertCrmLeadAccess(
        existing.crmLeadId,
        user.warehouseId
      );
      if (!leadOk) {
        res
          .status(404)
          .json({ success: false, message: "Interação não encontrada" });
        return;
      }

      const body = req.body as {
        status?: string;
        titulo?: string;
        descricao?: string | null;
        negocio_id?: string | null;
      };

      const data: {
        status?: string;
        title?: string;
        description?: string | null;
        crmLeadDealId?: string | null;
      } = {};

      if (body.status !== undefined) {
        const s = String(body.status);
        if (!INTERACTION_KANBAN_STATUSES.has(s)) {
          res.status(400).json({ success: false, message: "status inválido" });
          return;
        }
        data.status = s;
      }
      if (body.titulo !== undefined) {
        const ti = String(body.titulo || "").trim();
        if (!ti) {
          res
            .status(400)
            .json({ success: false, message: "Título não pode ser vazio" });
          return;
        }
        data.title = ti;
      }
      if (body.descricao !== undefined) {
        data.description =
          body.descricao === null || body.descricao === ""
            ? null
            : String(body.descricao).trim() || null;
      }
      if (body.negocio_id !== undefined) {
        if (body.negocio_id === null || body.negocio_id === "") {
          data.crmLeadDealId = null;
        } else {
          const did = String(body.negocio_id).trim();
          const deal = await prisma.crmLeadDeal.findFirst({
            where: { id: did, crmLeadId: existing.crmLeadId },
            select: { id: true },
          });
          if (!deal) {
            res.status(400).json({
              success: false,
              message: "Negócio não pertence a este lead",
            });
            return;
          }
          data.crmLeadDealId = deal.id;
        }
      }

      if (Object.keys(data).length === 0) {
        res.status(400).json({
          success: false,
          message: "Nenhum campo para atualizar",
        });
        return;
      }

      const row = await prisma.crmLeadInteraction.update({
        where: { id: interactionId },
        data,
        include: {
          createdBy: { select: { name: true } },
          crmLeadDeal: { select: { id: true, title: true } },
        },
      });

      await prisma.crmLead.update({
        where: { id: existing.crmLeadId },
        data: { lastInteractionAt: new Date() },
      });

      res.json({ success: true, data: interactionToFrontend(row) });
    } catch (e) {
      next(e);
    }
  }
);

/**
 * POST /api/leads/task/create/
 */
router.post("/task/create/", async (req: Request, res: Response, next) => {
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
      prioridade?: string;
      participantes?: string[] | null;
    };

    const leadId = String(body.lead_id || "").trim();
    if (!leadId) {
      res.status(400).json({ success: false, message: "lead_id obrigatório" });
      return;
    }

    const lead = await assertCrmLeadAccess(leadId, user.warehouseId);
    if (!lead) {
      res.status(404).json({ success: false, message: "Lead não encontrado" });
      return;
    }

    const titulo = String(body.titulo || "").trim();
    if (!titulo) {
      res.status(400).json({ success: false, message: "Título obrigatório" });
      return;
    }

    const kind = TASK_KINDS.has(String(body.tipo))
      ? String(body.tipo)
      : "reuniao";
    const scheduledAt = body.data_hora ? new Date(body.data_hora) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) {
      res.status(400).json({ success: false, message: "Data/hora inválida" });
      return;
    }

    const reminder =
      body.lembrete_minutos != null && String(body.lembrete_minutos) !== ""
        ? Math.max(0, Math.round(Number(body.lembrete_minutos)))
        : null;

    const descParts = [body.descricao?.trim(), body.observacoes?.trim()].filter(
      Boolean
    );
    const description = descParts.length ? descParts.join("\n\n") : null;

    const prio =
      body.prioridade && TASK_PRIORITIES.has(String(body.prioridade))
        ? String(body.prioridade)
        : "normal";
    const parts =
      Array.isArray(body.participantes) && body.participantes.length > 0
        ? body.participantes.map((x) => String(x).trim()).filter(Boolean)
        : null;

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
        priority: prio,
        ...(parts ? { participantUserIds: parts } : {}),
      },
    });

    await prisma.crmLead.update({
      where: { id: leadId },
      data: { lastInteractionAt: new Date() },
    });

    res.status(201).json({
      success: true,
      data: taskToFrontend({ ...task, crmLeadId: leadId }),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/leads/task/update/:id/
 */
router.put("/task/update/:id/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const taskId = req.params.id;

    const existing = await prisma.crmLeadTask.findFirst({
      where: { id: taskId },
      include: { crmLead: { select: { id: true } } },
    });
    if (!existing) {
      res
        .status(404)
        .json({ success: false, message: "Evento não encontrado" });
      return;
    }

    const ok = await assertCrmLeadAccess(existing.crmLead.id, user.warehouseId);
    if (!ok) {
      res
        .status(404)
        .json({ success: false, message: "Evento não encontrado" });
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
      marcar_check_in?: boolean;
      registrar_whatsapp_confirmacao?: boolean;
      registrar_lembrete_enviado?: boolean;
      prioridade?: string;
      participantes?: string[] | null;
    };

    const data: Prisma.CrmLeadTaskUpdateInput & Record<string, unknown> =
      {} as any;

    if (body.titulo !== undefined)
      data.title = String(body.titulo || "").trim() || existing.title;
    if (body.tipo !== undefined) {
      data.kind = TASK_KINDS.has(String(body.tipo))
        ? String(body.tipo)
        : existing.kind;
    }
    if (body.data_hora !== undefined) {
      const d = new Date(body.data_hora);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ success: false, message: "Data/hora inválida" });
        return;
      }
      data.scheduledAt = d;
    }
    if (body.local !== undefined) data.local = body.local?.trim() || null;
    if (body.negocio_ref !== undefined)
      data.negocioRef = body.negocio_ref?.trim() || null;
    if (body.concluido !== undefined) data.done = Boolean(body.concluido);
    if (body.marcar_check_in === true) {
      (data as Record<string, unknown>).checkedInAt = new Date();
    }
    if (body.registrar_whatsapp_confirmacao === true) {
      (data as Record<string, unknown>).whatsappConfirmationSentAt = new Date();
    }
    if (body.registrar_lembrete_enviado === true) {
      (data as Record<string, unknown>).reminderSentAt = new Date();
    }
    if (body.lembrete_minutos !== undefined) {
      data.reminderMinutes =
        body.lembrete_minutos != null && String(body.lembrete_minutos) !== ""
          ? Math.max(0, Math.round(Number(body.lembrete_minutos)))
          : null;
    }
    if (body.descricao !== undefined || body.observacoes !== undefined) {
      const prev = (existing.description || "").split("\n\n");
      const d =
        body.descricao !== undefined
          ? String(body.descricao || "").trim()
          : (prev[0] ?? "");
      const o =
        body.observacoes !== undefined
          ? String(body.observacoes || "").trim()
          : prev.slice(1).join("\n\n");
      data.description = [d, o].filter(Boolean).join("\n\n") || null;
    }
    if (body.prioridade !== undefined) {
      const p = String(body.prioridade || "");
      (data as { priority?: string }).priority = TASK_PRIORITIES.has(p)
        ? p
        : (existing as { priority?: string }).priority ?? "normal";
    }
    if (body.participantes !== undefined) {
      if (Array.isArray(body.participantes) && body.participantes.length > 0) {
        (data as { participantUserIds?: string[] }).participantUserIds =
          body.participantes.map((x) => String(x).trim()).filter(Boolean);
      } else {
        (data as { participantUserIds?: null }).participantUserIds = null;
      }
    }

    const updated = await prisma.crmLeadTask.update({
      where: { id: taskId },
      data,
    });

    await prisma.crmLead.update({
      where: { id: existing.crmLead.id },
      data: { lastInteractionAt: new Date() },
    });

    res.json({
      success: true,
      data: taskToFrontend({ ...updated, crmLeadId: existing.crmLead.id }),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/tasks/calendar/ — tarefas/eventos do CRM no intervalo (para agenda FullCalendar).
 */
router.post("/tasks/calendar/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as {
      warehouse_id?: string;
      start?: string;
      end?: string;
    };
    const start = body.start ? new Date(body.start) : null;
    const end = body.end ? new Date(body.end) : null;
    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      res
        .status(400)
        .json({
          success: false,
          message: "start e end (ISO) são obrigatórios",
        });
      return;
    }

    const wh =
      (body.warehouse_id || user.warehouseId || "").trim() || undefined;
    const leadWhere: Prisma.CrmLeadWhereInput = wh ? { warehouseId: wh } : {};

    /* `end` do FullCalendar é exclusivo; usar lt evita buraco no último instante do intervalo */
    const tasks = await prisma.crmLeadTask.findMany({
      where: {
        scheduledAt: { gte: start, lt: end },
        crmLead: leadWhere,
      },
      include: {
        crmLead: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { scheduledAt: "asc" },
    });

    const tipoLabel: Record<string, string> = {
      visita: "Visita",
      reuniao: "Reunião",
      ligacao: "Ligação",
      tarefa: "Tarefa",
      email: "E-mail",
    };

    const events = tasks.map((t) => {
      const color = TASK_KIND_CALENDAR_COLOR[t.kind] || "#1565c0";
      const startAt = t.scheduledAt;
      const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
      const leadNome = t.crmLead?.name?.trim() || "Lead";
      const tipo = tipoLabel[t.kind] || t.kind;
      const fullDesc = t.description ?? "";
      const descParts = fullDesc.split("\n\n");
      const pUserIds = (t as { participantUserIds?: unknown }).participantUserIds;
      const participantes = Array.isArray(pUserIds)
        ? (pUserIds as unknown[]).map((x) => String(x))
        : [];
      return {
        id: `crm-task-${t.id}`,
        title: `${tipo} · ${leadNome} — ${t.title}`,
        start: startAt.toISOString(),
        end: endAt.toISOString(),
        allDay: false,
        backgroundColor: color,
        borderColor: color,
        textColor: "#ffffff",
        extendedProps: {
          source: "crm_task",
          taskId: t.id,
          leadId: t.crmLeadId,
          leadName: t.crmLead?.name ?? "",
          leadPhone: t.crmLead?.phone ?? "",
          tipo: t.kind,
          titulo: t.title,
          local: t.local ?? "",
          negocio_ref: t.negocioRef ?? "",
          descricao: descParts[0] ?? "",
          observacoes: descParts.slice(1).join("\n\n") || "",
          prioridade: (t as { priority?: string }).priority ?? "normal",
          participantes,
          concluido: t.done,
          reminderMinutes: t.reminderMinutes,
          checkedInAt:
            (t as { checkedInAt?: Date | null }).checkedInAt?.toISOString() ??
            null,
          whatsappConfirmationSentAt:
            (
              t as { whatsappConfirmationSentAt?: Date | null }
            ).whatsappConfirmationSentAt?.toISOString() ?? null,
          reminderSentAt:
            (
              t as { reminderSentAt?: Date | null }
            ).reminderSentAt?.toISOString() ?? null,
        },
      };
    });

    res.json({ success: true, data: { events } });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/leads/agenda/insights/ — leads parados e próxima ação obrigatória.
 */
router.post("/agenda/insights/", async (req: Request, res: Response, next) => {
  try {
    const user = (req as Authed).user;
    const body = req.body as { warehouse_id?: string; stale_days?: number };
    const wh =
      (body.warehouse_id || user.warehouseId || "").trim() || undefined;
    if (!wh) {
      res
        .status(400)
        .json({ success: false, message: "warehouse_id é obrigatório" });
      return;
    }
    const staleDays = Math.min(90, Math.max(1, Number(body.stale_days) || 7));
    const cutoff = new Date(Date.now() - staleDays * 86400000);
    const now = new Date();

    const [staleCandidates, mandatoryNext] = await Promise.all([
      prisma.crmLead.findMany({
        where: {
          warehouseId: wh,
          pipelineStage: { notIn: ["ganho", "perdido"] },
          OR: [
            { lastInteractionAt: null },
            { lastInteractionAt: { lt: cutoff } },
          ],
        },
        select: {
          id: true,
          name: true,
          phone: true,
          pipelineStage: true,
          lastInteractionAt: true,
          tasks: {
            where: { done: false, scheduledAt: { gte: now } },
            take: 1,
            select: { id: true, scheduledAt: true, title: true },
          },
        },
        take: 80,
      }),
      // SQL direto: colunas existem na migration; evita erro se o Prisma Client local estiver desatualizado.
      prisma.$queryRaw<
        Array<{
          id: string;
          name: string | null;
          phone: string | null;
          next_action_note: string | null;
          pipeline_stage: string;
        }>
      >(
        Prisma.sql`
          SELECT id, name, phone, next_action_note, pipeline_stage
          FROM crm_leads
          WHERE warehouse_id = ${wh}
            AND COALESCE(next_action_required, false) = true
          LIMIT 40
        `
      ),
    ]);

    const stale_leads = staleCandidates
      .filter((l) => (l.tasks?.length ?? 0) === 0)
      .map((l) => ({
        id: l.id,
        nome: l.name ?? "",
        telefone: l.phone ?? "",
        status: l.pipelineStage,
        ultima_interacao: l.lastInteractionAt?.toISOString() ?? null,
      }));

    const mandatory_next = mandatoryNext.map((l) => ({
      id: l.id,
      nome: l.name ?? "",
      telefone: l.phone ?? "",
      nota: l.next_action_note ?? "",
      status: l.pipeline_stage,
    }));

    res.json({
      success: true,
      data: { stale_leads, mandatory_next, stale_days: staleDays },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
