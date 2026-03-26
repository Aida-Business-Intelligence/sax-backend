import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { fetchInstagramMedia } from '../lib/instagram-fetch.js';

const router = Router();

/**
 * GET /api/public/feed — stories publicadas + mídias Instagram (se configurado). Sem autenticação (sax-site).
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const stories = await prisma.siteStory.findMany({
      where: {
        published: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
      select: {
        id: true,
        imageUrl: true,
        caption: true,
        bubbleLabel: true,
        overlays: true,
        publishedAt: true,
        expiresAt: true,
        sortOrder: true,
      },
    });

    let instagram: { items: Awaited<ReturnType<typeof fetchInstagramMedia>> } | null = null;
    try {
      const cfg = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
      const acc = (cfg as { instagramBusinessAccountId?: string | null })?.instagramBusinessAccountId;
      const tok = (cfg as { instagramAccessToken?: string | null })?.instagramAccessToken;
      if (acc && tok) {
        const items = await fetchInstagramMedia(acc, tok, 12);
        instagram = { items };
      }
    } catch (igErr) {
      console.warn('[public-feed] instagram', igErr);
    }

    res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
    res.json({
      stories,
      instagram,
    });
  } catch (e) {
    console.error('[public-feed]', e);
    res.status(500).json({ stories: [], instagram: null, message: (e as Error).message });
  }
});

export default router;
