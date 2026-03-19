import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const LIVE_WINDOW_MS = 5 * 60 * 1000; // 5 min = "em tempo real"
const SUMMARY_DAYS = 30;

/** Retorna true se o erro for de tabela/relação inexistente (migration não rodou). */
function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /does not exist|relation.*does not exist|Table.*doesn't exist/i.test(msg) ||
    /Unknown table|no such table/i.test(msg)
  );
}

/**
 * POST /api/analytics/event — recebe evento do site (público).
 * Body: { sessionId, eventType, path?, payload?, userAgent?, referrer?, utmSource?, utmMedium?, utmCampaign?, deviceType?, browser?, os? }
 */
router.post('/event', async (req, res, next) => {
  try {
    const {
      sessionId,
      eventType,
      path,
      payload,
      userAgent,
      referrer,
      utmSource,
      utmMedium,
      utmCampaign,
      deviceType,
      browser,
      os,
    } = req.body || {};
    if (!sessionId || !eventType) {
      return res.status(400).json({ success: false, message: 'sessionId e eventType são obrigatórios' });
    }
    const sid = String(sessionId).slice(0, 128);
    const payloadStr = payload != null ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    const ua = userAgent || req.headers['user-agent'] || null;

    // Sempre salva o evento primeiro (tempo real e resumo dependem disso)
    await prisma.siteAnalyticsEvent.create({
      data: {
        sessionId: sid,
        eventType: String(eventType).slice(0, 64),
        path: path != null ? String(path).slice(0, 512) : null,
        payload: payloadStr,
      },
    });

    // Visitante (CRM): só tenta se o model existir no client; falha não deve impedir o evento
    const visitorModel = (prisma as any).siteVisitor;
    if (typeof visitorModel?.upsert === 'function') {
      try {
        await visitorModel.upsert({
          where: { sessionId: sid },
          create: {
            sessionId: sid,
            ip: ip?.slice(0, 45) || null,
            userAgent: ua?.slice(0, 512) || null,
            deviceType: deviceType?.slice(0, 32) || null,
            browser: browser?.slice(0, 64) || null,
            os: os?.slice(0, 64) || null,
            referrer: referrer?.slice(0, 512) || null,
            utmSource: utmSource?.slice(0, 128) || null,
            utmMedium: utmMedium?.slice(0, 128) || null,
            utmCampaign: utmCampaign?.slice(0, 128) || null,
          },
          update: {
            lastSeen: new Date(),
            ...(ip && { ip: ip.slice(0, 45) }),
            ...(ua && { userAgent: ua.slice(0, 512) }),
            ...(deviceType && { deviceType: deviceType.slice(0, 32) }),
            ...(browser && { browser: browser.slice(0, 64) }),
            ...(os && { os: os.slice(0, 64) }),
            ...(referrer && { referrer: referrer.slice(0, 512) }),
            ...(utmSource && { utmSource: utmSource.slice(0, 128) }),
            ...(utmMedium && { utmMedium: utmMedium.slice(0, 128) }),
            ...(utmCampaign && { utmCampaign: utmCampaign.slice(0, 128) }),
          },
        });
      } catch {
        // ignora: evento já foi salvo; CRM pode ser preenchido depois com prisma generate + migration
      }
    }

    return res.status(201).json({ success: true });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.status(201).json({ success: true });
    }
    next(e);
  }
});

/**
 * POST /api/analytics/lead — captura lead/contato (formulário com CPF, celular, etc.). Público.
 * Body: { name?, email?, phone?, cpf?, sessionId?, source?, metadata? }
 */
router.post('/lead', async (req, res, next) => {
  try {
    const { name, email, phone, cpf, sessionId, source = 'form', metadata } = req.body || {};
    if (!email && !phone && !cpf) {
      return res.status(400).json({ success: false, message: 'Informe ao menos e-mail, telefone ou CPF' });
    }
    const metadataStr = metadata != null ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;
    await prisma.siteLead.create({
      data: {
        sessionId: sessionId != null ? String(sessionId).slice(0, 128) : null,
        name: name != null ? String(name).slice(0, 255) : null,
        email: email != null ? String(email).slice(0, 255) : null,
        phone: phone != null ? String(phone).slice(0, 64) : null,
        cpf: cpf != null ? String(cpf).slice(0, 20) : null,
        source: String(source).slice(0, 64),
        consent: true,
        metadata: metadataStr,
      },
    });
    return res.status(201).json({ success: true });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.status(201).json({ success: true });
    }
    next(e);
  }
});

/**
 * GET /api/analytics/summary — resumo para o painel (páginas mais visitadas, imóveis, buscas). Requer auth.
 */
router.get('/summary', authMiddleware, async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - SUMMARY_DAYS * 24 * 60 * 60 * 1000);

    const [events, leadsCount] = await Promise.all([
      prisma.siteAnalyticsEvent.findMany({
        where: { createdAt: { gte: since } },
        select: { eventType: true, path: true, payload: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.siteLead.count(),
    ]);

    const pathCount: Record<string, number> = {};
    const propertyCount: Record<string, number> = {};
    const searchCount: Record<string, number> = {};
    for (const e of events) {
      if (e.eventType === 'page_view' && e.path) {
        pathCount[e.path] = (pathCount[e.path] || 0) + 1;
      }
      if (e.eventType === 'property_view' && e.payload) {
        propertyCount[e.payload] = (propertyCount[e.payload] || 0) + 1;
      }
      if (e.eventType === 'search' && e.payload) {
        searchCount[e.payload] = (searchCount[e.payload] || 0) + 1;
      }
    }

    const topPages = Object.entries(pathCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([path, count]) => ({ path, count }));

    const topProperties = Object.entries(propertyCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([payload, count]) => ({ payload, count }));

    const topSearches = Object.entries(searchCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([payload, count]) => ({ payload, count }));

    return res.json({
      leadsCount,
      eventsLast30Days: events.length,
      topPages,
      topProperties,
      topSearches,
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({
        leadsCount: 0,
        eventsLast30Days: 0,
        topPages: [],
        topProperties: [],
        topSearches: [],
      });
    }
    console.error('[analytics/summary]', e);
    return res.json({
      leadsCount: 0,
      eventsLast30Days: 0,
      topPages: [],
      topProperties: [],
      topSearches: [],
    });
  }
});

/**
 * GET /api/analytics/live — sessões ativas (últimos 5 min) e últimos eventos. Requer auth.
 */
router.get('/live', authMiddleware, async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - LIVE_WINDOW_MS);
    const events = await prisma.siteAnalyticsEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const bySession = new Map<string, { lastAt: Date; events: typeof events }>();
    for (const e of events) {
      if (!bySession.has(e.sessionId)) {
        bySession.set(e.sessionId, { lastAt: e.createdAt, events: [] });
      }
      const s = bySession.get(e.sessionId)!;
      s.events.push(e);
      if (e.createdAt > s.lastAt) s.lastAt = e.createdAt;
    }

    const sessions = Array.from(bySession.entries()).map(([sessionId, data]) => ({
      sessionId,
      lastActivity: data.lastAt.toISOString(),
      events: data.events.slice(0, 20).map((ev) => ({
        eventType: ev.eventType,
        path: ev.path,
        payload: ev.payload ? tryParse(ev.payload) : null,
        createdAt: ev.createdAt.toISOString(),
      })),
    }));

    return res.json({
      activeNow: sessions.length,
      sessions,
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ activeNow: 0, sessions: [] });
    }
    console.error('[analytics/live]', e);
    return res.json({ activeNow: 0, sessions: [] });
  }
});

/**
 * GET /api/analytics/leads — lista leads captados. Requer auth.
 */
router.get('/leads', authMiddleware, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const leads = await prisma.siteLead.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return res.json(leads.map((l) => ({
      id: l.id,
      sessionId: l.sessionId,
      name: l.name,
      email: l.email,
      phone: l.phone,
      cpf: l.cpf,
      source: l.source,
      metadata: l.metadata ? tryParse(l.metadata) : null,
      createdAt: l.createdAt.toISOString(),
    })));
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json([]);
    }
    console.error('[analytics/leads]', e);
    return res.json([]);
  }
});

/**
 * GET /api/analytics/visitors — lista CRM: visitantes com dados técnicos, de marketing e lead (se houver). Requer auth.
 */
router.get('/visitors', authMiddleware, async (req, res, next) => {
  try {
    // Cliente Prisma pode não ter siteVisitor se não rodou "prisma generate" após adicionar o model
    if (typeof (prisma as any).siteVisitor?.findMany !== 'function') {
      return res.json([]);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const visitors = await prisma.siteVisitor.findMany({
      orderBy: { lastSeen: 'desc' },
      take: limit,
    });
    const sessionIds = visitors.map((v) => v.sessionId);
    const [leads, eventCounts] = await Promise.all([
      prisma.siteLead.findMany({ where: { sessionId: { in: sessionIds } } }),
      prisma.siteAnalyticsEvent.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: sessionIds } },
        _count: { sessionId: true },
      }),
    ]);
    const leadBySession = new Map(leads.map((l) => [l.sessionId!, l]));
    const countBySession = new Map(eventCounts.map((e) => [e.sessionId, e._count.sessionId]));

    const list = visitors.map((v) => {
      const lead = v.sessionId ? leadBySession.get(v.sessionId) : null;
      return {
        sessionId: v.sessionId,
        firstSeen: v.firstSeen.toISOString(),
        lastSeen: v.lastSeen.toISOString(),
        ip: v.ip,
        userAgent: v.userAgent,
        deviceType: v.deviceType,
        browser: v.browser,
        os: v.os,
        country: v.country,
        city: v.city,
        region: v.region,
        referrer: v.referrer,
        utmSource: v.utmSource,
        utmMedium: v.utmMedium,
        utmCampaign: v.utmCampaign,
        eventCount: countBySession.get(v.sessionId) ?? 0,
        lead: lead
          ? {
              id: lead.id,
              name: lead.name,
              email: lead.email,
              phone: lead.phone,
              cpf: lead.cpf,
              source: lead.source,
              createdAt: lead.createdAt.toISOString(),
            }
          : null,
      };
    });

    return res.json(list);
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json([]);
    }
    console.error('[analytics/visitors]', e);
    return res.json([]);
  }
});

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export default router;
