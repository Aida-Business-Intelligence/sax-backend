import { Router, Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { enqueueFromEvent } from '../lib/automations.js';

const router = Router();

/** Pontos por tipo de evento (intenção de compra) */
const SCORE_RULES: Record<string, number> = {
  PAGE_VIEW: 1,
  VIEW_PROPERTY: 5,
  CLICK_WHATSAPP: 20,
  RETURN_VISIT: 10,
};

/**
 * Calcula o score do visitante somando os pontos de todos os eventos.
 */
async function calculateScore(visitorId: string): Promise<number> {
  const eventModel = (prisma as any).trackingEvent;
  if (typeof eventModel?.findMany !== 'function') return 0;
  const events = await eventModel.findMany({
    where: { visitorId },
    select: { type: true },
  });
  let total = 0;
  for (const e of events) {
    const points = SCORE_RULES[e.type];
    if (typeof points === 'number') total += points;
  }
  return total;
}

/** Temperatura do lead: score > 50 → hot, score > 20 → warm, senão cold */
function getTemperature(score: number): 'cold' | 'warm' | 'hot' {
  if (score > 50) return 'hot';
  if (score > 20) return 'warm';
  return 'cold';
}

/**
 * Atualiza o score, temperature e lastActivityAt do lead do visitante (se existir).
 */
async function updateLeadScore(visitorId: string): Promise<void> {
  const leadModel = (prisma as any).lead;
  if (typeof leadModel?.findUnique !== 'function' || typeof leadModel?.update !== 'function') return;
  const lead = await leadModel.findUnique({ where: { visitorId } });
  if (!lead) return;
  const score = await calculateScore(visitorId);
  const temperature = getTemperature(score);
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
 * Body: { fingerprint: string, type: string, data: object }
 * - Se visitor não existir → criar (fingerprint, ip, userAgent)
 * - Criar evento (visitorId, type, data)
 * - Atualizar visitor.updatedAt
 */
router.post('/event', async (req, res, next) => {
  try {
    const { fingerprint, type, data } = req.body ?? {};
    if (!fingerprint || typeof fingerprint !== 'string' || !type || typeof type !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'fingerprint e type são obrigatórios',
      });
    }

    const fp = String(fingerprint).trim().slice(0, 256);
    const eventType = String(type).slice(0, 64);
    const ip = getClientIp(req)?.slice(0, 45) ?? null;
    const userAgent = req.headers['user-agent']?.slice(0, 512) ?? null;
    const payload = data != null && typeof data === 'object' ? data : {};

    const visitorModel = (prisma as any).visitor;
    const eventModel = (prisma as any).trackingEvent;

    if (typeof visitorModel?.upsert !== 'function' || typeof eventModel?.create !== 'function') {
      return res.status(201).json({ success: true });
    }

    const visitor = await visitorModel.upsert({
      where: { fingerprint: fp },
      create: {
        fingerprint: fp,
        ip,
        userAgent,
      },
      update: {
        updatedAt: new Date(),
        ...(ip != null && { ip }),
        ...(userAgent != null && { userAgent }),
      },
    });

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
 * Body: { fingerprint: string, name?: string, email?: string, phone?: string }
 * - Encontrar visitor pelo fingerprint (ou criar se não existir)
 * - Criar ou atualizar lead (um lead por visitor)
 */
router.post('/lead/identify', async (req, res, next) => {
  try {
    const { fingerprint, name, email, phone } = req.body ?? {};
    if (!fingerprint || typeof fingerprint !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'fingerprint é obrigatório',
      });
    }

    const fp = String(fingerprint).trim().slice(0, 256);
    const visitorModel = (prisma as any).visitor;
    const leadModel = (prisma as any).lead;

    if (typeof visitorModel?.upsert !== 'function' || typeof leadModel?.upsert !== 'function') {
      return res.status(201).json({ success: true });
    }

    const ip = getClientIp(req)?.slice(0, 45) ?? null;
    const userAgent = req.headers['user-agent']?.slice(0, 512) ?? null;

    const visitor = await visitorModel.upsert({
      where: { fingerprint: fp },
      create: {
        fingerprint: fp,
        ip,
        userAgent,
      },
      update: {
        updatedAt: new Date(),
        ...(ip != null && { ip }),
        ...(userAgent != null && { userAgent }),
      },
    });

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
    const visitors = await visitorModel.findMany({
      orderBy: { updatedAt: 'desc' },
      take: limit,
      include: { lead: true },
    });
    const visitorIds = visitors.map((v: { id: string }) => v.id);
    const eventCounts = await eventModel.groupBy({
      by: ['visitorId'],
      where: { visitorId: { in: visitorIds } },
      _count: { visitorId: true },
    });
    const countByVisitor = new Map(eventCounts.map((e: { visitorId: string; _count: { visitorId: number } }) => [e.visitorId, e._count.visitorId]));

    type LeadShape = { id: string; name: string | null; email: string | null; phone: string | null; status: string; score: number; temperature?: string; lastActivityAt?: Date | null; createdAt: Date };
    const list = visitors.map((v: {
      id: string;
      fingerprint: string;
      ip: string | null;
      userAgent: string | null;
      createdAt: Date;
      updatedAt: Date;
      lead?: LeadShape | null;
    }) => ({
      id: v.id,
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
 * GET /tracking/recommendations — imóveis recomendados (por fingerprint, público).
 * GET /tracking/recommendations/:visitorId — imóveis recomendados (por visitorId, requer auth).
 */
router.get('/recommendations', async (req, res, next) => {
  try {
    const fingerprint = typeof req.query.fingerprint === 'string' ? req.query.fingerprint.trim().slice(0, 256) : '';
    if (!fingerprint) return res.json([]);

    const visitorModel = (prisma as any).visitor;
    if (typeof visitorModel?.findUnique !== 'function') return res.json([]);
    const visitor = await visitorModel.findUnique({ where: { fingerprint } });
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
