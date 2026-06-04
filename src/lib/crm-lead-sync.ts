import { prisma } from './prisma.js';
import { maybeAssignLeadFromRules } from './lead-distribution.js';

/**
 * Loja padrão para leads vindos do site/tracking.
 * Ordem: env → loja com mais imóveis no catálogo (alinha com o que o PDV filtra) → primeira Warehouse.
 */
export async function resolveDefaultWarehouseId(): Promise<string | null> {
  const env = process.env.CRM_DEFAULT_WAREHOUSE_ID?.trim();
  if (env) return env;

  try {
    const byCatalog = await prisma.property.groupBy({
      by: ['warehouseId'],
      _count: { _all: true },
    });
    if (byCatalog.length) {
      const sorted = [...byCatalog].sort(
        (a, b) => (b._count?._all ?? 0) - (a._count?._all ?? 0),
      );
      const top = sorted[0]?.warehouseId;
      if (top) return top;
    }
  } catch {
    // tabela Property indisponível ou migration pendente
  }

  const w = await prisma.warehouse.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return w?.id ?? null;
}

async function resolveWarehouseIdForSync(
  requestedId: string | null | undefined,
): Promise<string | null> {
  const raw = requestedId?.trim();
  if (raw) {
    const found = await prisma.warehouse.findUnique({
      where: { id: raw },
      select: { id: true },
    });
    if (found?.id) return found.id;
  }
  return resolveDefaultWarehouseId();
}

function normalizeMeta(o: unknown): Record<string, unknown> | null {
  if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<string, unknown>;
  if (typeof o === 'string') {
    try {
      const p = JSON.parse(o) as unknown;
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Cria/atualiza linha em crm_leads ligada ao visitante de tracking (site / Modo Caça).
 * Só grava se houver telefone ou e-mail no Lead de tracking.
 *
 * `warehouseId` opcional (ex.: enviado pelo sax-site via `warehouse_id`) deve existir em `Warehouse`;
 * caso contrário usa `resolveDefaultWarehouseId()` (catálogo / env).
 */
export async function syncCrmLeadFromTracking(
  visitorId: string,
  input?: { source?: string; crmMetadata?: unknown; warehouseId?: string | null },
): Promise<void> {
  const crm = prisma as unknown as { crmLead: { upsert: (args: unknown) => Promise<unknown> } };
  if (typeof crm.crmLead?.upsert !== 'function') return;

  const visitor = await prisma.visitor.findUnique({
    where: { id: visitorId },
    include: { lead: true },
  });
  if (!visitor?.lead) return;

  const l = visitor.lead;
  const phone = l.phone?.trim() || '';
  const email = l.email?.trim() || '';
  if (!phone && !email) return;

  const warehouseId = await resolveWarehouseIdForSync(input?.warehouseId ?? undefined);
  const sourceRaw = (input?.source || 'site').trim().slice(0, 64) || 'site';
  const meta = normalizeMeta(input?.crmMetadata);
  const detailStr = meta ? JSON.stringify(meta) : null;
  const kind = typeof meta?.kind === 'string' ? meta.kind.slice(0, 64) : null;
  const mode = typeof meta?.mode === 'string' ? meta.mode.slice(0, 64) : null;

  const adTitle =
    sourceRaw === 'modo_caca' ? 'Modo Caça · Site' : sourceRaw === 'meta_ads' ? 'Meta Lead Ads' : null;

  const row = await crm.crmLead.upsert({
    where: { trackingVisitorId: visitorId },
    create: {
      trackingVisitorId: visitorId,
      warehouseId,
      name: l.name,
      email: l.email,
      phone: l.phone,
      pipelineStage: 'novo',
      source: sourceRaw,
      sourceDetail: detailStr,
      adTitle,
      score: l.score ?? 0,
      lastInteractionAt: l.lastActivityAt ?? new Date(),
      interestPropertyType: kind,
      interestTransactionType: mode,
    },
    update: {
      name: l.name,
      email: l.email,
      phone: l.phone,
      score: l.score ?? 0,
      lastInteractionAt: l.lastActivityAt ?? new Date(),
      ...(warehouseId ? { warehouseId } : {}),
      ...(input?.source ? { source: sourceRaw } : {}),
      ...(detailStr != null ? { sourceDetail: detailStr } : {}),
      ...(kind ? { interestPropertyType: kind } : {}),
      ...(mode ? { interestTransactionType: mode } : {}),
      ...(adTitle != null ? { adTitle } : {}),
    },
  });
  const created = row as { id: string; assignedUserId?: string | null };
  if (created?.id && !created.assignedUserId) {
    await maybeAssignLeadFromRules(created.id);
  }
}
