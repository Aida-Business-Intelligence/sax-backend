import { Router, type Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { isLikelyPublicIp, lookupIpGeo } from '../lib/geo-ip.js';
import { roughCoordsFromTimeZone } from '../lib/timezone-geo.js';
import { getLiveChatThread } from '../lib/live-chat-thread.js';

const router = Router();
const LIVE_WINDOW_MS = 5 * 60 * 1000; // 5 min = "em tempo real"
const SUMMARY_DAYS = 30;
/** Prazo para o atendente tratar o lead (push/chat) a partir da última interação na sessão. */
const LEAD_TREAT_MS = 12 * 60 * 60 * 1000;
/** Janela de eventos para o resumo (imóveis visitados, buscas). */
const INSIGHT_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** Retorna true se o erro for de tabela/relação inexistente (migration não rodou). */
function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /does not exist|relation.*does not exist|Table.*doesn't exist/i.test(msg) ||
    /Unknown table|no such table/i.test(msg)
  );
}

/** Último contato: analytics, mensagem do operador ou resposta do visitante (o mais recente). */
async function getLastSessionTouchMs(sessionId: string): Promise<number | null> {
  const dates: Date[] = [];
  try {
    const ev = await prisma.siteAnalyticsEvent.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (ev) dates.push(ev.createdAt);
  } catch {
    /* ignore */
  }
  try {
    const lv = await prisma.liveVisitorMessage.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (lv) dates.push(lv.createdAt);
  } catch {
    /* ignore */
  }
  try {
    const vr = await prisma.visitorChatReply.findFirst({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (vr) dates.push(vr.createdAt);
  } catch {
    /* ignore */
  }
  if (dates.length === 0) return null;
  return Math.max(...dates.map((d) => d.getTime()));
}

function parseCoord(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Preenche lat/lng por IP quando o visitante não enviou GPS (assíncrono, não bloqueia a resposta). */
async function enrichGeoFromIpIfNeeded(sessionId: string, ip: string | null, skipIpLookup: boolean): Promise<void> {
  if (skipIpLookup) return;
  if (!ip || !isLikelyPublicIp(ip)) return;
  try {
    const v = await prisma.siteVisitor.findUnique({
      where: { sessionId },
      select: { latitude: true, longitude: true },
    });
    if (v?.latitude != null && v?.longitude != null) return;
    const geo = await lookupIpGeo(ip);
    if (!geo) return;
    await prisma.siteVisitor.update({
      where: { sessionId },
      data: {
        latitude: geo.lat,
        longitude: geo.lon,
        ...(geo.city ? { city: geo.city } : {}),
        ...(geo.region ? { region: geo.region } : {}),
        ...(geo.country ? { country: geo.country } : {}),
      },
    });
  } catch {
    // modelo/colunas ausentes ou IP não resolvido
  }
}

/** Quando não há IP público (ex.: localhost), posição aproximada pelo fuso do navegador. */
async function enrichGeoFromTimezoneIfNeeded(
  sessionId: string,
  timeZone: string | null | undefined,
): Promise<void> {
  if (!timeZone) return;
  try {
    const v = await prisma.siteVisitor.findUnique({
      where: { sessionId },
      select: { latitude: true, longitude: true },
    });
    if (v?.latitude != null && v?.longitude != null) return;
    const rough = roughCoordsFromTimeZone(timeZone);
    if (!rough) return;
    await prisma.siteVisitor.update({
      where: { sessionId },
      data: {
        latitude: rough.lat,
        longitude: rough.lng,
        ...(rough.city ? { city: rough.city } : {}),
      },
    });
  } catch {
    // colunas ausentes
  }
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
      latitude: latRaw,
      longitude: lngRaw,
      timeZone: timeZoneRaw,
    } = req.body || {};
    const timeZoneBody = typeof timeZoneRaw === 'string' ? timeZoneRaw.slice(0, 64) : null;
    const clientLat = parseCoord(latRaw);
    const clientLng = parseCoord(lngRaw);
    const hasClientGeo =
      clientLat != null &&
      clientLng != null &&
      clientLat >= -90 &&
      clientLat <= 90 &&
      clientLng >= -180 &&
      clientLng <= 180;
    if (!sessionId || !eventType) {
      return res.status(400).json({ success: false, message: 'sessionId e eventType são obrigatórios' });
    }
    const sid = String(sessionId).slice(0, 128);
    const et = String(eventType).slice(0, 64);
    const isGeoUpdate = et === 'geo_update';
    const payloadStr = payload != null ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
    const ua = userAgent || req.headers['user-agent'] || null;

    // geo_update só atualiza visitante (coords); não polui a tabela de eventos nem o resumo
    if (!isGeoUpdate) {
      await prisma.siteAnalyticsEvent.create({
        data: {
          sessionId: sid,
          eventType: et,
          path: path != null ? String(path).slice(0, 512) : null,
          payload: payloadStr,
        },
      });
    }

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
            ...(hasClientGeo ? { latitude: clientLat, longitude: clientLng } : {}),
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
            ...(hasClientGeo ? { latitude: clientLat, longitude: clientLng } : {}),
          },
        });
        if (!hasClientGeo) {
          if (ip && isLikelyPublicIp(ip)) {
            void enrichGeoFromIpIfNeeded(sid, ip, false);
          } else {
            await enrichGeoFromTimezoneIfNeeded(sid, timeZoneBody);
          }
        }
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

    const sessionIds = Array.from(bySession.keys());
    const geoBySession = new Map<
      string,
      { lat: number; lng: number; city: string | null; region: string | null; country: string | null }
    >();
    try {
      if (sessionIds.length && typeof prisma.siteVisitor?.findMany === 'function') {
        const rows = await prisma.siteVisitor.findMany({
          where: { sessionId: { in: sessionIds } },
          select: {
            sessionId: true,
            latitude: true,
            longitude: true,
            city: true,
            region: true,
            country: true,
          },
        });
        for (const r of rows) {
          if (r.latitude != null && r.longitude != null) {
            geoBySession.set(r.sessionId, {
              lat: r.latitude,
              lng: r.longitude,
              city: r.city,
              region: r.region,
              country: r.country,
            });
          }
        }
      }
    } catch {
      // colunas antigas / modelo ausente
    }

    const sessions = Array.from(bySession.entries()).map(([sessionId, data]) => {
      const geo = geoBySession.get(sessionId) ?? null;
      return {
        sessionId,
        lastActivity: data.lastAt.toISOString(),
        geo,
        events: data.events.slice(0, 20).map((ev) => ({
          eventType: ev.eventType,
          path: ev.path,
          payload: ev.payload ? tryParse(ev.payload) : null,
          createdAt: ev.createdAt.toISOString(),
        })),
      };
    });

    const slugSet = new Set<string>();
    for (const sess of sessions) {
      const first = firstScreenEvent(sess.events);
      if (first?.eventType === 'property_view') {
        const slug = propertySlugFromPayload(first.payload);
        if (slug) slugSet.add(slug);
      }
    }

    const propertyBySlug = new Map<string, { title: string; ref: string | null }>();
    if (slugSet.size > 0) {
      try {
        const props = await prisma.property.findMany({
          where: { slug: { in: Array.from(slugSet) } },
          select: { slug: true, title: true, ref: true },
        });
        for (const p of props) {
          propertyBySlug.set(p.slug, { title: p.title, ref: p.ref ?? null });
        }
      } catch {
        // modelo Property indisponível
      }
    }

    const sessionsOut = sessions.map((sess) => {
      const first = firstScreenEvent(sess.events);
      let liveProperty: { slug: string; title: string; ref: string | null } | null = null;
      if (first?.eventType === 'property_view') {
        const slug = propertySlugFromPayload(first.payload);
        if (slug) {
          const meta = propertyBySlug.get(slug);
          liveProperty = {
            slug,
            title: meta?.title ?? slug,
            ref: meta?.ref ?? null,
          };
        }
      }
      return { ...sess, liveProperty };
    });

    return res.json({
      activeNow: sessionsOut.length,
      sessions: sessionsOut,
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
 * GET /api/analytics/live-session-insight?sessionId=
 * Resumo para o atendente: imóveis visitados, filtros de busca, prazo de 12h desde a última interação.
 */
router.get('/live-session-insight', authMiddleware, async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId ?? '').trim().slice(0, 128);
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId é obrigatório' });
    }

    const since = new Date(Date.now() - INSIGHT_LOOKBACK_MS);
    const events = await prisma.siteAnalyticsEvent.findMany({
      where: { sessionId, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      take: 2000,
    });

    const touchMs = await getLastSessionTouchMs(sessionId);
    const leadExpiresAt = touchMs != null ? new Date(touchMs + LEAD_TREAT_MS) : null;
    const isExpired = leadExpiresAt != null && Date.now() > leadExpiresAt.getTime();
    const secondsUntilExpiry =
      leadExpiresAt != null ? Math.max(0, Math.floor((leadExpiresAt.getTime() - Date.now()) / 1000)) : 0;

    const propertyMap = new Map<string, { slug: string; lastAt: Date }>();
    const searchRows: { lastAt: Date; filters: Record<string, unknown> }[] = [];

    for (const e of events) {
      if (e.eventType === 'property_view' && e.payload) {
        const p = tryParse(e.payload);
        const slug =
          typeof p === 'object' &&
          p !== null &&
          'propertySlug' in p &&
          typeof (p as { propertySlug?: unknown }).propertySlug === 'string'
            ? String((p as { propertySlug: string }).propertySlug).trim()
            : '';
        if (slug) {
          const prev = propertyMap.get(slug);
          if (!prev || e.createdAt > prev.lastAt) {
            propertyMap.set(slug, { slug, lastAt: e.createdAt });
          }
        }
      }
      if (e.eventType === 'search' && e.payload) {
        const p = tryParse(e.payload);
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          searchRows.push({ lastAt: e.createdAt, filters: p as Record<string, unknown> });
        }
      }
    }

    let propertyViews: { slug: string; title: string; ref: string | null; lastAt: string }[] = [];
    const slugs = Array.from(propertyMap.keys());
    if (slugs.length > 0) {
      const props = await prisma.property.findMany({
        where: { slug: { in: slugs } },
        select: { slug: true, title: true, ref: true },
      });
      const pmap = new Map(props.map((x) => [x.slug, x]));
      propertyViews = Array.from(propertyMap.values()).map((v) => {
        const pr = pmap.get(v.slug);
        return {
          slug: v.slug,
          title: pr?.title ?? v.slug,
          ref: pr?.ref ?? null,
          lastAt: v.lastAt.toISOString(),
        };
      });
      propertyViews.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
    }

    const seenSearch = new Set<string>();
    const searchesOut: { lastAt: string; filters: Record<string, unknown> }[] = [];
    for (let i = searchRows.length - 1; i >= 0 && searchesOut.length < 6; i--) {
      const row = searchRows[i];
      const key = JSON.stringify(row.filters);
      if (seenSearch.has(key)) continue;
      seenSearch.add(key);
      searchesOut.unshift({ lastAt: row.lastAt.toISOString(), filters: row.filters });
    }

    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];

    return res.json({
      sessionId,
      firstActivityAt: firstEvent?.createdAt?.toISOString() ?? null,
      lastActivityAt: lastEvent?.createdAt?.toISOString() ?? null,
      lastTouchAt: touchMs != null ? new Date(touchMs).toISOString() : null,
      leadExpiresAt: leadExpiresAt?.toISOString() ?? null,
      isExpired,
      secondsUntilExpiry,
      propertyViews,
      searches: searchesOut,
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({
        sessionId: String(req.query.sessionId ?? ''),
        firstActivityAt: null,
        lastActivityAt: null,
        lastTouchAt: null,
        leadExpiresAt: null,
        isExpired: true,
        secondsUntilExpiry: 0,
        propertyViews: [],
        searches: [],
      });
    }
    next(e);
  }
});

/**
 * GET /api/analytics/live-chat/thread?sessionId=
 * Histórico mesclado (operador + visitante) — módulo CRM Push.
 */
router.get('/live-chat/thread', authMiddleware, async (req, res, next) => {
  try {
    const sessionId = String(req.query.sessionId ?? '').trim().slice(0, 128);
    if (!sessionId) {
      return res.status(400).json({ messages: [] });
    }
    const messages = await getLiveChatThread(sessionId);
    return res.json({ messages });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ messages: [] });
    }
    next(e);
  }
});

/**
 * POST /api/analytics/live-push — mensagem instantânea ao visitante no site (popup ou chat). Requer auth.
 * Body: { sessionId, body, kind?: 'popup' | 'chat' }
 */
router.post('/live-push', authMiddleware, async (req, res, next) => {
  try {
    const { sessionId, body: text, kind } = (req.body || {}) as {
      sessionId?: string;
      body?: string;
      kind?: string;
    };
    const sid = sessionId != null ? String(sessionId).trim().slice(0, 128) : '';
    const msg = text != null ? String(text).trim() : '';
    if (!sid || !msg) {
      return res.status(400).json({ success: false, message: 'sessionId e body são obrigatórios' });
    }
    if (msg.length > 4000) {
      return res.status(400).json({ success: false, message: 'Mensagem muito longa (máx. 4000 caracteres)' });
    }

    const touchMs = await getLastSessionTouchMs(sid);
    if (touchMs != null && Date.now() - touchMs > LEAD_TREAT_MS) {
      return res.status(410).json({
        success: false,
        message:
          'Prazo de 12 horas para atender esta sessão expirou. O visitante pode voltar ao site e gerar nova atividade.',
      });
    }

    const k = kind === 'chat' ? 'chat' : 'popup';
    await prisma.liveVisitorMessage.create({
      data: {
        sessionId: sid,
        kind: k,
        body: msg,
      },
    });
    return res.status(201).json({ success: true });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.status(503).json({
        success: false,
        message: 'Mensagens ao vivo não disponíveis. Rode a migration no servidor (live_visitor_messages).',
      });
    }
    next(e);
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

/** Mesma regra do painel ao vivo: primeiro evento “de tela” (mais recente). */
function firstScreenEvent(events: { eventType: string; payload?: unknown }[]) {
  return events.find((e) => e.eventType === 'page_view' || e.eventType === 'property_view') ?? null;
}

function propertySlugFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const s = (payload as Record<string, unknown>).propertySlug;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

type AuthUser = { role?: { name: string } | null };

/**
 * POST /api/analytics/reset-painel-site — apaga dados exibidos no painel Gestão do site (analytics do site,
 * visitantes/leads do site, tracking CRM de visitantes/eventos). Apenas Super Admin.
 */
router.post('/reset-painel-site', authMiddleware, async (req, res, next) => {
  try {
    const user = (req as Request & { user?: AuthUser }).user;
    if (!user || user.role?.name !== 'Super Admin') {
      return res.status(403).json({
        success: false,
        message: 'Apenas usuário Super Admin pode zerar os dados do painel do site.',
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.automationQueue.deleteMany({});
      await tx.trackingEvent.deleteMany({});
      await tx.trackingSession.deleteMany({});
      await tx.lead.deleteMany({});
      await tx.visitor.deleteMany({});
      await tx.siteAnalyticsEvent.deleteMany({});
      await tx.siteVisitor.deleteMany({});
      await tx.siteLead.deleteMany({});
      await tx.crmLead.updateMany({
        where: { trackingVisitorId: { not: null } },
        data: { trackingVisitorId: null },
      });
    });

    return res.json({ success: true });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ success: true });
    }
    next(e);
  }
});

export default router;
