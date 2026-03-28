import { Router, Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { enqueueFromEvent } from '../lib/automations.js';
import { syncCrmLeadFromTracking } from '../lib/crm-lead-sync.js';
import { calculateVisitorIntentScore, getLeadTemperature } from '../lib/tracking-score.js';

const router = Router();

function normalizeClientVisitorId(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, 128);
  return s.length ? s : null;
}

function normalizeFingerprint(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, 256);
  return s.length ? s : null;
}

/**
 * Move eventos/sessões/lead do visitante duplicado para o canônico e remove o duplicado.
 */
async function mergeVisitorsKeepCanonical(
  tx: Prisma.TransactionClient,
  canonicalId: string,
  duplicateId: string,
): Promise<void> {
  if (canonicalId === duplicateId) return;

  await tx.trackingEvent.updateMany({
    where: { visitorId: duplicateId },
    data: { visitorId: canonicalId },
  });

  await tx.trackingSession.updateMany({
    where: { visitorId: duplicateId },
    data: { visitorId: canonicalId },
  });

  const dup = await tx.visitor.findUnique({
    where: { id: duplicateId },
    include: { lead: true },
  });
  const can = await tx.visitor.findUnique({
    where: { id: canonicalId },
    include: { lead: true },
  });

  if (!dup) return;

  if (dup.lead && !can?.lead) {
    await tx.lead.update({
      where: { id: dup.lead.id },
      data: { visitorId: canonicalId },
    });
  } else if (dup.lead && can?.lead) {
    await tx.lead.update({
      where: { id: can.lead.id },
      data: {
        name: can.lead.name || dup.lead.name,
        email: can.lead.email || dup.lead.email,
        phone: can.lead.phone || dup.lead.phone,
        score: Math.max(can.lead.score ?? 0, dup.lead.score ?? 0),
      },
    });
    await tx.lead.delete({ where: { id: dup.lead.id } });
  }

  await tx.visitor.delete({ where: { id: duplicateId } });
}

/** Une registros quando fingerprint e clientVisitorId apontavam para visitantes diferentes. */
async function stabilizeVisitorRecords(
  tx: Prisma.TransactionClient,
  cid: string | null,
  fp: string | null,
): Promise<void> {
  if (!cid && !fp) return;
  for (let i = 0; i < 8; i++) {
    let changed = false;
    const byCid = cid ? await tx.visitor.findUnique({ where: { clientVisitorId: cid } }) : null;
    const byFp = fp ? await tx.visitor.findUnique({ where: { fingerprint: fp } }) : null;

    if (byCid && byFp && byCid.id !== byFp.id) {
      await mergeVisitorsKeepCanonical(tx, byCid.id, byFp.id);
      changed = true;
    } else if (byCid && fp) {
      const fpOwner = await tx.visitor.findUnique({ where: { fingerprint: fp } });
      if (fpOwner && fpOwner.id !== byCid.id) {
        await mergeVisitorsKeepCanonical(tx, byCid.id, fpOwner.id);
        changed = true;
      }
    } else if (byFp && cid) {
      const cidOwner = await tx.visitor.findUnique({ where: { clientVisitorId: cid } });
      if (cidOwner && cidOwner.id !== byFp.id) {
        await mergeVisitorsKeepCanonical(tx, cidOwner.id, byFp.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

async function resolveOrCreateVisitor(
  cid: string | null,
  fp: string | null,
  ip: string | null,
  userAgent: string | null,
): Promise<{ id: string }> {
  if (!cid && !fp) {
    throw new Error('MISSING_IDS');
  }

  return prisma.$transaction(async (tx) => {
    await stabilizeVisitorRecords(tx, cid, fp);

    let v = cid ? await tx.visitor.findUnique({ where: { clientVisitorId: cid } }) : null;
    if (!v && fp) {
      v = await tx.visitor.findUnique({ where: { fingerprint: fp } });
    }

    const touch: Prisma.VisitorUpdateInput = {
      updatedAt: new Date(),
      ...(ip != null && ip.length > 0 ? { ip } : {}),
      ...(userAgent != null && userAgent.length > 0 ? { userAgent } : {}),
    };

    if (!v) {
      return tx.visitor.create({
        data: {
          fingerprint: fp ?? `cid:${cid}`,
          ...(cid ? { clientVisitorId: cid } : {}),
          ip,
          userAgent,
        },
      });
    }

    if (cid) {
      const cidRow = await tx.visitor.findUnique({ where: { clientVisitorId: cid } });
      if (cidRow && cidRow.id !== v.id) {
        await mergeVisitorsKeepCanonical(tx, cidRow.id, v.id);
        v = (await tx.visitor.findUnique({ where: { id: cidRow.id } }))!;
      }
    }

    if (fp && v.fingerprint !== fp) {
      const fpRow = await tx.visitor.findUnique({ where: { fingerprint: fp } });
      if (fpRow && fpRow.id !== v.id) {
        await mergeVisitorsKeepCanonical(tx, v.id, fpRow.id);
        v = (await tx.visitor.findUnique({ where: { id: v.id } }))!;
      }
    }

    const data: Prisma.VisitorUpdateInput = {
      ...touch,
      ...((cid && (!v.clientVisitorId || v.clientVisitorId === cid)) ? { clientVisitorId: cid } : {}),
      ...(fp ? { fingerprint: fp } : {}),
    };

    return tx.visitor.update({
      where: { id: v.id },
      data,
    });
  });
}

/**
 * Atualiza o score, temperature e lastActivityAt do lead do visitante (se existir).
 */
async function updateLeadScore(visitorId: string): Promise<void> {
  const leadModel = (prisma as any).lead;
  if (typeof leadModel?.findUnique !== 'function' || typeof leadModel?.update !== 'function') return;
  const lead = await leadModel.findUnique({ where: { visitorId } });
  if (!lead) return;
  const score = await calculateVisitorIntentScore(visitorId);
  const temperature = getLeadTemperature(score);
  const lastActivityAt = new Date();
  await leadModel.update({
    where: { id: lead.id },
    data: { score, temperature, lastActivityAt },
  });
}

function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]?.trim() || null;
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * POST /tracking/event
 * Body: { clientVisitorId?: string, fingerprint?: string, type: string, data: object }
 * — Pelo menos um de clientVisitorId ou fingerprint é obrigatório (IP/UA vêm do request).
 */
router.post('/event', async (req, res, next) => {
  try {
    const { type, data } = req.body ?? {};
    const cid = normalizeClientVisitorId(req.body?.clientVisitorId);
    const fp = normalizeFingerprint(req.body?.fingerprint);

    if (!type || typeof type !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'type é obrigatório',
      });
    }
    if (!cid && !fp) {
      return res.status(400).json({
        success: false,
        message: 'clientVisitorId ou fingerprint é obrigatório',
      });
    }

    const eventType = String(type).slice(0, 64);
    const ip = getClientIp(req)?.slice(0, 45) ?? null;
    const userAgent = req.headers['user-agent']?.slice(0, 512) ?? null;
    const payload = data != null && typeof data === 'object' ? data : {};

    const eventModel = (prisma as any).trackingEvent;
    if (typeof prisma.visitor !== 'object' || typeof eventModel?.create !== 'function') {
      return res.status(201).json({ success: true });
    }

    let visitor: { id: string };
    try {
      visitor = await resolveOrCreateVisitor(cid, fp, ip, userAgent);
    } catch (err) {
      if (err instanceof Error && err.message === 'MISSING_IDS') {
        return res.status(400).json({ success: false, message: 'clientVisitorId ou fingerprint é obrigatório' });
      }
      throw err;
    }

    await eventModel.create({
      data: {
        visitorId: visitor.id,
        type: eventType,
        data: payload,
      },
    });

    await updateLeadScore(visitor.id).catch(() => {});

    await enqueueFromEvent(visitor.id, eventType, payload).catch(() => {});

    return res.status(201).json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /tracking/lead/identify
 * Body: { clientVisitorId?: string, fingerprint?: string, name?, email?, phone? }
 */
router.post('/lead/identify', async (req, res, next) => {
  try {
    const { name, email, phone } = req.body ?? {};
    const cid = normalizeClientVisitorId(req.body?.clientVisitorId);
    const fp = normalizeFingerprint(req.body?.fingerprint);

    if (!cid && !fp) {
      return res.status(400).json({
        success: false,
        message: 'clientVisitorId ou fingerprint é obrigatório',
      });
    }

    const leadModel = (prisma as any).lead;

    if (typeof prisma.visitor !== 'object' || typeof leadModel?.upsert !== 'function') {
      return res.status(201).json({ success: true });
    }

    const ip = getClientIp(req)?.slice(0, 45) ?? null;
    const userAgent = req.headers['user-agent']?.slice(0, 512) ?? null;

    let visitor: { id: string };
    try {
      visitor = await resolveOrCreateVisitor(cid, fp, ip, userAgent);
    } catch (err) {
      if (err instanceof Error && err.message === 'MISSING_IDS') {
        return res.status(400).json({ success: false, message: 'clientVisitorId ou fingerprint é obrigatório' });
      }
      throw err;
    }

    const updateData: { name?: string; email?: string; phone?: string } = {};
    if (name != null && typeof name === 'string' && name.trim()) updateData.name = name.trim().slice(0, 256);
    if (email != null && typeof email === 'string' && email.trim()) updateData.email = email.trim().slice(0, 256);
    if (phone != null && typeof phone === 'string' && phone.trim()) updateData.phone = phone.trim().slice(0, 64);

    await leadModel.upsert({
      where: { visitorId: visitor.id },
      create: {
        visitorId: visitor.id,
        ...updateData,
      },
      update: updateData,
    });

    await updateLeadScore(visitor.id).catch(() => {});

    const source =
      typeof (req.body as { source?: string })?.source === 'string'
        ? (req.body as { source: string }).source.trim().slice(0, 64)
        : undefined;
    const crmMetadata = (req.body as { crmMetadata?: unknown }).crmMetadata;
    const warehouseIdBody =
      typeof (req.body as { warehouse_id?: string })?.warehouse_id === 'string'
        ? (req.body as { warehouse_id: string }).warehouse_id.trim().slice(0, 128) || undefined
        : undefined;
    await syncCrmLeadFromTracking(visitor.id, {
      source,
      crmMetadata,
      warehouseId: warehouseIdBody,
    }).catch((err) => {
      console.error('[tracking/lead/identify] syncCrmLeadFromTracking', err);
    });

    return res.status(201).json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /tracking/visitors — lista visitantes (CRM tracking). Requer auth.
 */
router.get('/visitors', authMiddleware, async (req, res, next) => {
  try {
    const visitorModel = (prisma as any).visitor;
    const eventModel = (prisma as any).trackingEvent;
    if (typeof visitorModel?.findMany !== 'function' || typeof eventModel?.groupBy !== 'function') {
      return res.json([]);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    type LeadShape = { id: string; name: string | null; email: string | null; phone: string | null; status: string; score: number; temperature?: string; lastActivityAt?: Date | null; createdAt: Date };
    const visitors = await visitorModel.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { lead: true },
    }) as Array<{
      id: string;
      clientVisitorId: string | null;
      fingerprint: string;
      ip: string | null;
      userAgent: string | null;
      createdAt: Date;
      updatedAt: Date;
      lead?: LeadShape | null;
    }>;
    const visitorIds = visitors.map((v: { id: string }) => v.id);
    const eventCounts = await eventModel.groupBy({
      by: ['visitorId'],
      where: { visitorId: { in: visitorIds } },
      _count: { visitorId: true },
    });
    const countByVisitor = new Map(eventCounts.map((e: { visitorId: string; _count: { visitorId: number } }) => [e.visitorId, e._count.visitorId]));

    const list = visitors.map((v) => ({
      id: v.id,
      clientVisitorId: v.clientVisitorId ?? null,
      fingerprint: v.fingerprint,
      ip: v.ip,
      userAgent: v.userAgent,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
      eventCount: countByVisitor.get(v.id) ?? 0,
      lead: v.lead
        ? {
            id: v.lead.id,
            name: v.lead.name,
            email: v.lead.email,
            phone: v.lead.phone,
            status: v.lead.status,
            score: v.lead.score ?? 0,
            temperature: (v.lead as LeadShape & { temperature?: string }).temperature ?? 'cold',
            lastActivityAt: (v.lead as LeadShape & { lastActivityAt?: Date | null }).lastActivityAt?.toISOString() ?? null,
            createdAt: v.lead.createdAt.toISOString(),
          }
        : null,
    }));
    list.sort((a: typeof list[number], b: typeof list[number]) => (b.lead?.score ?? 0) - (a.lead?.score ?? 0));
    return res.json(list);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /tracking/lead/:id/score — retorna o score do lead (intenção de compra). Requer auth.
 */
router.get('/lead/:id/score', authMiddleware, async (req, res, next) => {
  try {
    const leadId = req.params.id;
    const leadModel = (prisma as any).lead;
    if (typeof leadModel?.findUnique !== 'function') {
      return res.status(404).json({ success: false, message: 'Lead não encontrado' });
    }
    const lead = await leadModel.findUnique({
      where: { id: leadId },
      select: { id: true, visitorId: true, score: true },
    });
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead não encontrado' });
    }
    return res.json({ id: lead.id, visitorId: lead.visitorId, score: lead.score ?? 0 });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /tracking/events — lista eventos (CRM tracking). Requer auth.
 */
router.get('/events', authMiddleware, async (req, res, next) => {
  try {
    const eventModel = (prisma as any).trackingEvent;
    if (typeof eventModel?.findMany !== 'function') {
      return res.json([]);
    }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const events = await eventModel.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const list = events.map((e: { id: string; visitorId: string; type: string; data: unknown; createdAt: Date }) => ({
      id: e.id,
      visitorId: e.visitorId,
      type: e.type,
      data: e.data,
      createdAt: e.createdAt.toISOString(),
    }));
    return res.json(list);
  } catch (e) {
    next(e);
  }
});

/** Faixas de preço (venda) para filtro */
const PRICE_RANGES: Record<string, { min?: number; max?: number }> = {
  lt500k: { max: 500_000 },
  '500k-1m': { min: 500_000, max: 1_000_000 },
  '1m-2m': { min: 1_000_000, max: 2_000_000 },
  gt2m: { min: 2_000_000 },
};

async function getRecommendationsForVisitorId(visitorId: string): Promise<unknown[]> {
  const eventModel = (prisma as any).trackingEvent;
  const propertyModel = (prisma as any).property;
  if (typeof eventModel?.findMany !== 'function' || typeof propertyModel?.findMany !== 'function') {
    return [];
  }

  const events = await eventModel.findMany({
    where: { visitorId, type: { in: ['VIEW_PROPERTY', 'SEARCH'] } },
    orderBy: { createdAt: 'desc' },
    take: 80,
  });

  const excludeSlugs = new Set<string>();
  const cities = new Set<string>();
  const types = new Set<string>();
  let mode = 'venda';
  let bedroomsMin: number | undefined;
  let priceRange: string | undefined;

  for (const e of events) {
    const data = (e as { data?: unknown }).data as Record<string, unknown> | undefined;
    if (!data) continue;
    if ((e as { type: string }).type === 'VIEW_PROPERTY') {
      const slug = typeof data.slug === 'string' ? data.slug.trim() : '';
      if (slug) excludeSlugs.add(slug);
    }
    if ((e as { type: string }).type === 'SEARCH') {
      const city = typeof data.city === 'string' ? data.city.trim() : '';
      if (city && city !== '__all__') cities.add(city);
      const t = typeof data.type === 'string' ? data.type.trim().toLowerCase() : '';
      if (t && ['casa', 'apartamento', 'terreno', 'comercial'].includes(t)) types.add(t);
      const m = typeof data.mode === 'string' ? data.mode.trim().toLowerCase() : '';
      if (m && ['venda', 'aluguel', 'crowdfunding'].includes(m)) mode = m;
      const b = data.bedrooms != null ? Number(data.bedrooms) : NaN;
      if (!Number.isNaN(b) && b >= 0) bedroomsMin = bedroomsMin != null ? Math.min(bedroomsMin, b) : b;
      const pr = typeof data.priceRange === 'string' ? data.priceRange.trim() : '';
      if (pr && ['lt500k', '500k-1m', '1m-2m', 'gt2m'].includes(pr)) priceRange = pr;
    }
  }

  if (excludeSlugs.size > 0 && (cities.size === 0 || types.size === 0)) {
    const viewed = await propertyModel.findMany({
      where: { slug: { in: Array.from(excludeSlugs) }, status: 'published' },
      select: { city: true, state: true, propertyType: true },
    });
    for (const p of viewed) {
      if (p.city && p.state) cities.add(`${p.city}-${p.state}`);
      if (p.propertyType) types.add(String(p.propertyType).toLowerCase());
    }
  }

  const where: Record<string, unknown> = {
    status: 'published',
    ...(excludeSlugs.size > 0 ? { slug: { notIn: Array.from(excludeSlugs) } } : {}),
  };
  const and: Record<string, unknown>[] = [];
  if (cities.size > 0) {
    and.push({ OR: Array.from(cities).map((cs) => {
      const [city, state] = cs.split('-');
      return { city: city || undefined, state: state || undefined };
    }) });
  }
  if (types.size > 0) and.push({ propertyType: { in: Array.from(types) } });
  if (bedroomsMin != null && bedroomsMin > 0) and.push({ bedrooms: { gte: bedroomsMin } });
  if (priceRange && PRICE_RANGES[priceRange]) {
    const { min, max } = PRICE_RANGES[priceRange];
    const priceField = mode === 'aluguel' ? 'priceAluguel' : 'priceVenda';
    const rangeCond: Record<string, number> = {};
    if (min != null) rangeCond.gte = min;
    if (max != null) rangeCond.lte = max;
    if (Object.keys(rangeCond).length) and.push({ [priceField]: rangeCond });
  }
  if (and.length > 0) where.AND = and;

  const list = await propertyModel.findMany({
    where,
    include: { media: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 12,
  });

  function parseJsonArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }

  return list.map((p: {
    id: string;
    slug: string;
    title: string;
    description: string | null;
    price: unknown;
    priceVenda: unknown;
    priceAluguel: unknown;
    transactionTypes: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    area: unknown;
    propertyType: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    address: string | null;
    zip: string | null;
    latitude: unknown;
    longitude: unknown;
    tagImovel: string | null;
    builder: string | null;
    media: { url: string }[];
  }) => {
    const tagImovel = p.tagImovel ? parseJsonArray(p.tagImovel) : [];
    const transactionTypes = parseJsonArray(p.transactionTypes);
    const priceVendaNum = p.priceVenda != null ? Number(p.priceVenda) : null;
    const priceAluguelNum = p.priceAluguel != null ? Number(p.priceAluguel) : null;
    const priceVenda = priceVendaNum != null && Number.isFinite(priceVendaNum) && priceVendaNum > 0 ? priceVendaNum : null;
    const priceAluguel = priceAluguelNum != null && Number.isFinite(priceAluguelNum) && priceAluguelNum > 0 ? priceAluguelNum : null;
    const price = p.price ? Number(p.price) : 0;
    return {
      id: p.id,
      slug: p.slug,
      title: p.title,
      description: p.description ?? '',
      price,
      priceVenda,
      priceAluguel,
      transactionTypes,
      bedrooms: p.bedrooms ?? 0,
      bathrooms: p.bathrooms ?? 0,
      area: p.area ? Number(p.area) : 0,
      type: (p.propertyType ?? 'apartamento') as string,
      address: {
        neighborhood: p.neighborhood ?? '',
        city: p.city ?? '',
        state: p.state ?? '',
        street: p.address ?? undefined,
        zip: p.zip ?? undefined,
        lat: p.latitude ? Number(p.latitude) : undefined,
        lng: p.longitude ? Number(p.longitude) : undefined,
      },
      coverImage: p.media?.[0]
        ? { url: p.media[0].url, alt: p.title, width: 1200, height: 800 }
        : { url: '', alt: p.title, width: 1200, height: 800 },
      images: p.media?.map((m) => ({ url: m.url, alt: p.title })) ?? [],
      tagImovel,
      builder: p.builder ?? undefined,
    };
  });
}

/**
 * GET /tracking/recommendations — imóveis recomendados (público).
 * Query: clientVisitorId (preferencial) e/ou fingerprint.
 */
router.get('/recommendations', async (req, res, next) => {
  try {
    const cid = normalizeClientVisitorId(req.query.clientVisitorId);
    const fp = normalizeFingerprint(req.query.fingerprint);
    if (!cid && !fp) return res.json([]);

    const visitorModel = (prisma as any).visitor;
    if (typeof visitorModel?.findUnique !== 'function') return res.json([]);

    let visitor = cid ? await visitorModel.findUnique({ where: { clientVisitorId: cid } }) : null;
    if (!visitor && fp) {
      visitor = await visitorModel.findUnique({ where: { fingerprint: fp } });
    }
    if (!visitor) return res.json([]);

    const formatted = await getRecommendationsForVisitorId(visitor.id);
    return res.json(formatted);
  } catch (e) {
    next(e);
  }
});

router.get('/recommendations/:visitorId', authMiddleware, async (req, res, next) => {
  try {
    const visitorId = req.params.visitorId;
    const formatted = await getRecommendationsForVisitorId(visitorId);
    return res.json(formatted);
  } catch (e) {
    next(e);
  }
});

export default router;
