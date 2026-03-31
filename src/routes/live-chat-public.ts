import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getLiveChatThread, type ThreadMessage } from '../lib/live-chat-thread.js';

const router = Router();

const ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

function isMissingTableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /does not exist|relation.*does not exist|Table.*doesn't exist/i.test(msg) ||
    /Unknown table|no such table/i.test(msg)
  );
}

/**
 * GET /api/public/live-chat/thread?sessionId=
 * Histórico mesclado (operador + visitante) para o widget de chat no site.
 */
router.get('/thread', async (req: Request, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId ?? '').trim().slice(0, 128);
    if (!sessionId) {
      return res.status(400).json({ messages: [] as ThreadMessage[] });
    }

    const since = new Date(Date.now() - ACTIVITY_WINDOW_MS);
    const recent = await prisma.siteAnalyticsEvent.findFirst({
      where: { sessionId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (!recent) {
      return res.json({ messages: [] as ThreadMessage[] });
    }

    const messages = await getLiveChatThread(sessionId);
    return res.json({ messages });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.json({ messages: [] as ThreadMessage[] });
    }
    console.error('[public/live-chat/thread]', e);
    return res.status(500).json({ messages: [] as ThreadMessage[] });
  }
});

/**
 * POST /api/public/live-chat/reply
 * Body: { sessionId, body } — visitante responde no site.
 */
router.post('/reply', async (req: Request, res: Response) => {
  try {
    const sessionId =
      req.body?.sessionId != null ? String(req.body.sessionId).trim().slice(0, 128) : '';
    const bodyRaw = req.body?.body != null ? String(req.body.body).trim() : '';
    if (!sessionId || !bodyRaw) {
      return res.status(400).json({ success: false, message: 'sessionId e body são obrigatórios' });
    }
    if (bodyRaw.length > 4000) {
      return res.status(400).json({ success: false, message: 'Mensagem muito longa (máx. 4000 caracteres)' });
    }

    const since = new Date(Date.now() - ACTIVITY_WINDOW_MS);
    const recent = await prisma.siteAnalyticsEvent.findFirst({
      where: { sessionId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (!recent) {
      return res.status(403).json({ success: false, message: 'Sessão inativa ou expirada' });
    }

    await prisma.visitorChatReply.create({
      data: { sessionId, body: bodyRaw },
    });
    return res.status(201).json({ success: true });
  } catch (e) {
    if (isMissingTableError(e)) {
      return res.status(503).json({
        success: false,
        message: 'Chat indisponível. Rode a migration visitor_chat_replies.',
      });
    }
    console.error('[public/live-chat/reply]', e);
    return res.status(500).json({ success: false, message: 'Erro ao enviar' });
  }
});

export default router;
