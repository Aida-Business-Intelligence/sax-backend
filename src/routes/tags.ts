import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const createTagSchema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  slug: z.string().min(1, 'Slug obrigatório').regex(/^[a-z0-9-]+$/, 'Slug: apenas letras minúsculas, números e hífen'),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const updateTagSchema = createTagSchema.partial();

/**
 * GET /api/tags ou /api/tags/list - lista todas as tags.
 */
async function list(_req: import('express').Request, res: import('express').Response) {
  const list = await prisma.tag.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, slug: true, sortOrder: true, active: true },
  });
  res.json(list);
}

router.get('/', list);
router.get('/list', list);
router.get('/list/', list);

/**
 * GET /api/tags/:id - obtém uma tag (para edição). Requer auth.
 */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const tag = await prisma.tag.findUnique({
      where: { id },
    });
    if (!tag) {
      res.status(404).json({ success: false, message: 'Tag não encontrada' });
      return;
    }
    res.json(tag);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/tags - cria tag. Requer auth.
 */
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const parsed = createTagSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      res.status(400).json({ success: false, message: msg });
      return;
    }
    const { name, slug, sortOrder, active } = parsed.data;
    const existing = await prisma.tag.findUnique({ where: { slug } });
    if (existing) {
      res.status(409).json({ success: false, message: 'Já existe uma tag com este slug' });
      return;
    }
    const tag = await prisma.tag.create({
      data: {
        name,
        slug,
        sortOrder: sortOrder ?? 0,
        active: active ?? true,
      },
    });
    res.status(201).json(tag);
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/tags/:id - atualiza tag. Requer auth.
 */
router.put('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const parsed = updateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      res.status(400).json({ success: false, message: msg });
      return;
    }
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Tag não encontrada' });
      return;
    }
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const slugTaken = await prisma.tag.findUnique({ where: { slug: parsed.data.slug } });
      if (slugTaken) {
        res.status(409).json({ success: false, message: 'Já existe uma tag com este slug' });
        return;
      }
    }
    const tag = await prisma.tag.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.slug !== undefined && { slug: parsed.data.slug }),
        ...(parsed.data.sortOrder !== undefined && { sortOrder: parsed.data.sortOrder }),
        ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      },
    });
    res.json(tag);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/tags/:id - remove tag. Requer auth.
 */
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.tag.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Tag não encontrada' });
      return;
    }
    await prisma.tag.delete({ where: { id } });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
