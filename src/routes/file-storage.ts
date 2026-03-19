import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

const CATEGORIES = ['Images', 'Media', 'Documents', 'Other'] as const;

function getCategoryForType(type: string | null): (typeof CATEGORIES)[number] {
  if (!type || typeof type !== 'string') return 'Other';
  const t = type.toLowerCase();
  if (t.startsWith('image/')) return 'Images';
  if (t.startsWith('video/') || t.startsWith('audio/')) return 'Media';
  if (
    t.includes('pdf') ||
    t.includes('document') ||
    t.includes('msword') ||
    t.includes('wordprocessing') ||
    t.includes('sheet') ||
    t.includes('spreadsheet') ||
    t.includes('text/plain') ||
    t.includes('text/html')
  )
    return 'Documents';
  return 'Other';
}

/**
 * GET /api/file_storage/overview
 * Resposta: { total_used_storage_bytes, data: [{ name, size, count }] } por categoria (Images, Media, Documents, Other)
 */
router.get('/overview', async (_req: Request, res: Response) => {
  try {
    const agg = await prisma.file.aggregate({
      _sum: { size: true },
      _count: { id: true },
    });
    const total_used_storage_bytes = Number(agg._sum.size ?? 0);

    const files = await prisma.file.findMany({
      select: { size: true, type: true },
    });

    const byCategory: Record<string, { size: number; count: number }> = {
      Images: { size: 0, count: 0 },
      Media: { size: 0, count: 0 },
      Documents: { size: 0, count: 0 },
      Other: { size: 0, count: 0 },
    };

    for (const file of files) {
      const cat = getCategoryForType(file.type);
      byCategory[cat].size += file.size;
      byCategory[cat].count += 1;
    }

    const data = CATEGORIES.map((name) => ({
      name,
      size: byCategory[name].size,
      count: byCategory[name].count,
    }));

    res.json({
      total_used_storage_bytes,
      data,
    });
  } catch (e) {
    console.error('file_storage overview', e);
    res.status(500).json({ total_used_storage_bytes: 0, data: [] });
  }
});

export default router;
