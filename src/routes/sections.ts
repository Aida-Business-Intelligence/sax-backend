import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const createSectionSchema = z.object({
  title: z.string().min(1, 'Título obrigatório'),
  slug: z.string().min(1, 'Slug obrigatório').regex(/^[a-z0-9-]+$/, 'Slug: apenas letras minúsculas, números e hífen'),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

const updateSectionSchema = createSectionSchema.partial();

/**
 * GET /api/sections ou /api/sections/list
 * Lista todas as seções (para admin e para dropdown; no dropdown o front pode filtrar active).
 */
async function list(_req: import('express').Request, res: import('express').Response) {
  const list = await prisma.section.findMany({
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    select: { id: true, title: true, slug: true, sortOrder: true, active: true },
  });
  res.json(list);
}

router.get('/', list);
router.get('/list', list);
router.get('/list/', list);

/**
 * GET /api/sections/:id - obtém uma seção (para edição). Requer auth.
 */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const section = await prisma.section.findUnique({
      where: { id },
    });
    if (!section) {
      res.status(404).json({ success: false, message: 'Seção não encontrada' });
      return;
    }
    res.json(section);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/sections - cria seção. Requer auth.
 */
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const parsed = createSectionSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      res.status(400).json({ success: false, message: msg });
      return;
    }
    const { title, slug, sortOrder, active } = parsed.data;
    const existing = await prisma.section.findUnique({ where: { slug } });
    if (existing) {
      res.status(409).json({ success: false, message: 'Já existe uma seção com este slug' });
      return;
    }
    const section = await prisma.section.create({
      data: {
        title,
        slug,
        sortOrder: sortOrder ?? 0,
        active: active ?? true,
      },
    });
    res.status(201).json(section);
  } catch (e) {
    next(e);
  }
});

/**
 * PUT /api/sections/:id - atualiza seção. Requer auth.
 */
router.put('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const parsed = updateSectionSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      res.status(400).json({ success: false, message: msg });
      return;
    }
    const existing = await prisma.section.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Seção não encontrada' });
      return;
    }
    if (parsed.data.slug && parsed.data.slug !== existing.slug) {
      const slugTaken = await prisma.section.findUnique({ where: { slug: parsed.data.slug } });
      if (slugTaken) {
        res.status(409).json({ success: false, message: 'Já existe uma seção com este slug' });
        return;
      }
    }
    const section = await prisma.section.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined && { title: parsed.data.title }),
        ...(parsed.data.slug !== undefined && { slug: parsed.data.slug }),
        ...(parsed.data.sortOrder !== undefined && { sortOrder: parsed.data.sortOrder }),
        ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      },
    });
    res.json(section);
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/sections/:id - remove seção. Requer auth.
 */
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const existing = await prisma.section.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Seção não encontrada' });
      return;
    }
    await prisma.section.delete({ where: { id } });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
