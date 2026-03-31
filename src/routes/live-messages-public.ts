import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

/** Retorna true se tabela/relação não existe (migration pendente). */
function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /does not exist|relation.*does not exist|Table.*doesn't exist/i.test(msg) ||
    /Unknown table|no such table/i.test(msg)
  );
}

/**
 * GET /api/public/live-messages?sessionId= — mensagens pendentes para o visitante (site).
 * Só entrega se a sessão teve atividade recente (analytics). Marca como entregues ao retornar.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId ?? '').trim().slice(0, 128);
    if (!sessionId) {
      return res.status(400).json({ messages: [] });
    }

    const since = new Date(Date.now() - ACTIVITY_WINDOW_MS);
    const recent = await prisma.siteAnalyticsEvent.findFirst({
      where: { sessionId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (!recent) {
      return res.json({ messages: [] });
    }

    /** Só pop-up (toast) por aqui; mensagens `chat` vêm no GET /api/public/live-chat/thread */
    const rows = await prisma.liveVisitorMessage.findMany({
      where: { sessionId, delivered: false, kind: 'popup' },
      orderBy: { createdAt: 'asc' },
      take: 25,
      select: { id: true, kind: true, body: true, createdAt: true },
    });

    if (rows.length === 0) {
      return res.json({ messages: [] });
    }

    await prisma.liveVisitorMessage.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { delivered: true },
    });

    return res.json({
      messages: rows.map((r) => ({
        id: r.id,
        kind: r.kind === 'chat' ? 'chat' : 'popup',
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ messages: [] });
    }
    console.error('[public/live-messages]', e);
    return res.status(500).json({ messages: [] });
  }
});

export default router;
