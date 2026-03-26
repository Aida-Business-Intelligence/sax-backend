import { prisma } from './prisma.js';

export async function resolveDefaultWarehouseId(): Promise<string | null> {
  const env = process.env.CRM_DEFAULT_WAREHOUSE_ID?.trim();
  if (env) return env;
  const w = await prisma.warehouse.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return w?.id ?? null;
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
 */
export async function syncCrmLeadFromTracking(
  visitorId: string,
  input?: { source?: string; crmMetadata?: unknown }
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

  const warehouseId = await resolveDefaultWarehouseId();
  const sourceRaw = (input?.source || 'site').trim().slice(0, 64) || 'site';
  const meta = normalizeMeta(input?.crmMetadata);
  const detailStr = meta ? JSON.stringify(meta) : null;
  const kind = typeof meta?.kind === 'string' ? meta.kind.slice(0, 64) : null;
  const mode = typeof meta?.mode === 'string' ? meta.mode.slice(0, 64) : null;

  const adTitle =
    sourceRaw === 'modo_caca' ? 'Modo Caça · Site' : sourceRaw === 'meta_ads' ? 'Meta Lead Ads' : null;

  await crm.crmLead.upsert({
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
      ...(input?.source ? { source: sourceRaw } : {}),
      ...(detailStr != null ? { sourceDetail: detailStr } : {}),
      ...(kind ? { interestPropertyType: kind } : {}),
      ...(mode ? { interestTransactionType: mode } : {}),
      ...(adTitle != null ? { adTitle } : {}),
    },
  });
}
