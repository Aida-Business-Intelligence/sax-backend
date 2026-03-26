import multer from 'multer';
import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadPublic, deleteObject, keyFromCdnUrl, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

const storyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.SITE_ASSET },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

function hasSiteConfigInstagramColumns(): boolean {
  return true;
}

const BUBBLE_LABEL_MAX = 80;

function clipBubbleLabel(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.length > BUBBLE_LABEL_MAX ? s.slice(0, BUBBLE_LABEL_MAX) : s;
}

/** Express omite chaves `undefined` no JSON — evita resposta 500 com `{}` e sem mensagem. */
function serverErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e.trim()) return e.trim();
  try {
    const s = JSON.stringify(e);
    if (s && s !== '{}') return s;
  } catch {
    /* ignore */
  }
  return 'Erro interno no servidor';
}

function parseOptionalExpiresAt(raw: string | null | undefined): Date | null {
  if (raw == null || String(raw).trim() === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/site-stories/upload — envia imagem (formato story) para CDN; retorna { url }.
 */
router.post(
  '/upload',
  authMiddleware,
  storyUpload.single('file'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ message: 'Envie o arquivo no campo "file"' });
        return;
      }
      const validation = validateImage(req.file.buffer, SIZE.SITE_ASSET);
      if (!validation.ok) {
        res.status(422).json({ message: validation.error });
        return;
      }
      const ext = safeExtFromMime(validation.mime!);
      const sid = randomUUID();
      const objectKey = keys.siteStory(sid, `bg${ext}`);
      const url = await uploadPublic(objectKey, req.file.buffer, validation.mime!);
      res.json({ url, storyKey: sid });
    } catch (e) {
      console.error('[site-stories upload]', e);
      res.status(500).json({ message: serverErrorMessage(e) });
    }
  }
);

/**
 * GET /api/site-stories/instagram-config — credenciais Instagram (PDV; token mascarado).
 * Registrado antes de /:id para não colidir.
 */
router.get('/instagram-config', authMiddleware, async (_req: Request, res: Response) => {
  try {
    if (!hasSiteConfigInstagramColumns()) {
      res.json({
        instagramBusinessAccountId: null,
        hasToken: false,
        tokenHint: null,
      });
      return;
    }
    const row = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const acc = (row as { instagramBusinessAccountId?: string | null })?.instagramBusinessAccountId ?? null;
    const tok = (row as { instagramAccessToken?: string | null })?.instagramAccessToken ?? null;
    const hasToken = typeof tok === 'string' && tok.length > 8;
    const tokenHint = hasToken ? `…${tok!.slice(-4)}` : null;
    res.json({
      instagramBusinessAccountId: acc,
      hasToken,
      tokenHint,
    });
  } catch (e) {
    console.error('[instagram-config GET]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

/**
 * PUT /api/site-stories/instagram-config — salva ID da conta Business + token de longa duração.
 */
router.put('/instagram-config', authMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      instagramBusinessAccountId?: string | null;
      instagramAccessToken?: string | null;
    };
    const acc =
      body.instagramBusinessAccountId != null && String(body.instagramBusinessAccountId).trim() !== ''
        ? String(body.instagramBusinessAccountId).trim()
        : null;
    const tok =
      body.instagramAccessToken != null && String(body.instagramAccessToken).trim() !== ''
        ? String(body.instagramAccessToken).trim()
        : null;

    let row = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!row) {
      row = await prisma.siteConfig.create({
        data: {
          instagramBusinessAccountId: acc,
          instagramAccessToken: tok,
        } as never,
      });
    } else {
      await prisma.siteConfig.update({
        where: { id: row.id },
        data: {
          instagramBusinessAccountId: acc,
          instagramAccessToken: tok,
        } as never,
      });
    }

    res.json({
      ok: true,
      instagramBusinessAccountId: acc,
      hasToken: !!tok && tok.length > 8,
      tokenHint: tok && tok.length > 8 ? `…${tok.slice(-4)}` : null,
    });
  } catch (e) {
    console.error('[instagram-config PUT]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

/**
 * GET /api/site-stories — lista stories (PDV).
 */
router.get('/', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const list = await prisma.siteStory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
    });
    res.json(list);
  } catch (e) {
    console.error('[site-stories GET]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

/**
 * POST /api/site-stories — cria story.
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: { id: string; warehouseId: string | null } }).user;
    const body = req.body as {
      imageUrl?: string;
      caption?: string;
      bubbleLabel?: string | null;
      overlays?: unknown;
      sortOrder?: number;
      published?: boolean;
      expiresAt?: string | null;
    };
    const imageUrl = String(body.imageUrl ?? '').trim();
    if (!imageUrl) {
      res.status(400).json({ message: 'imageUrl é obrigatório' });
      return;
    }

    const row = await prisma.siteStory.create({
      data: {
        warehouseId: user.warehouseId ?? undefined,
        imageUrl,
        caption: body.caption != null ? String(body.caption) : null,
        bubbleLabel: clipBubbleLabel(body.bubbleLabel),
        overlays: body.overlays != null ? (body.overlays as object) : undefined,
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
        published: body.published !== false,
        expiresAt: parseOptionalExpiresAt(body.expiresAt ?? undefined),
        createdByUserId: user.id,
      },
    });
    res.status(201).json(row);
  } catch (e) {
    console.error('[site-stories POST]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

/**
 * PATCH /api/site-stories/:id
 */
router.patch('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body as {
      imageUrl?: string;
      caption?: string | null;
      bubbleLabel?: string | null;
      overlays?: unknown | null;
      sortOrder?: number;
      published?: boolean;
      expiresAt?: string | null;
    };

    const data: Record<string, unknown> = {};
    if (body.imageUrl !== undefined) data.imageUrl = String(body.imageUrl);
    if (body.caption !== undefined) data.caption = body.caption;
    if (body.bubbleLabel !== undefined) data.bubbleLabel = clipBubbleLabel(body.bubbleLabel);
    if (body.overlays !== undefined) data.overlays = body.overlays;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
    if (body.published !== undefined) data.published = body.published;
    if (body.expiresAt !== undefined) {
      data.expiresAt = parseOptionalExpiresAt(body.expiresAt ?? undefined);
    }

    const row = await prisma.siteStory.update({
      where: { id },
      data: data as never,
    });
    res.json(row);
  } catch (e) {
    console.error('[site-stories PATCH]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

/**
 * DELETE /api/site-stories/:id — remove story e tenta apagar arquivo no Space pela URL.
 */
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.siteStory.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Story não encontrada' });
      return;
    }
    const k = keyFromCdnUrl(existing.imageUrl);
    if (k) await deleteObject(k);

    await prisma.siteStory.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[site-stories DELETE]', e);
    res.status(500).json({ message: serverErrorMessage(e) });
  }
});

export default router;
