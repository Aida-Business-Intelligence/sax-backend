import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    || `post-${Date.now()}`;
}

function toPublicPost(row: { id: string; slug: string; title: string; excerpt: string; content: string; coverUrl: string | null; tags: string | null; authorName: string; published: boolean; reactions: string | null; comments: string | null; createdAt: Date; updatedAt: Date }, options?: { includePublished?: boolean }) {
  const tags: string[] = row.tags ? (JSON.parse(row.tags) as string[]) : [];
  const reactions = row.reactions ? (JSON.parse(row.reactions) as { likes?: number }) : { likes: 0 };
  const comments = row.comments ? (JSON.parse(row.comments) as Array<{ id: string; authorName: string; message: string; createdAt: string }>) : [];
  const out: Record<string, unknown> = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    coverUrl: row.coverUrl ?? undefined,
    tags,
    authorName: row.authorName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reactions: { likes: reactions.likes ?? 0 },
    comments,
  };
  if (options?.includePublished) (out as Record<string, boolean>).published = row.published;
  return out;
}

/**
 * GET /api/blog - lista posts. Para o site: só publicados. PDV pode enviar ?all=1 para listar todos.
 */
router.get('/', async (req, res, next) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    const where = all ? {} : { published: true };
    const rows = await prisma.blogPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    const posts = rows.map((r) => toPublicPost(r, { includePublished: true }));
    res.json(posts);
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/blog/list - lista (mesmo que GET /)
 */
router.get('/list', async (req, res, next) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    const where = all ? {} : { published: true };
    const rows = await prisma.blogPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows.map((r) => toPublicPost(r, { includePublished: true })));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/blog/by-slug/:slug - obtém um post pelo slug (público, só publicados).
 */
router.get('/by-slug/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const row = await prisma.blogPost.findFirst({
      where: { slug, published: true },
    });
    if (!row) {
      res.status(404).json({ message: 'Post não encontrado' });
      return;
    }
    res.json(toPublicPost(row, { includePublished: true }));
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/blog/:id - obtém por id (PDV, qualquer status). Requer auth.
 */
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const row = await prisma.blogPost.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ message: 'Post não encontrado' });
      return;
    }
    res.json(toPublicPost(row, { includePublished: true }));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/blog - cria post. Requer auth (PDV).
 */
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const excerpt = String(body.excerpt ?? '').trim();
    const content = String(body.content ?? '').trim();
    if (!title) {
      res.status(400).json({ message: 'Título é obrigatório' });
      return;
    }
    const slugBase = slugify(title);
    let slug = slugBase;
    let suffix = 1;
    while (await prisma.blogPost.findUnique({ where: { slug } })) {
      slug = `${slugBase}-${suffix++}`;
    }
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const tagsJson = JSON.stringify(tags.map((t) => String(t)));
    const coverUrl = body.coverUrl != null ? String(body.coverUrl) : null;
    const authorName = body.authorName != null ? String(body.authorName) : 'Equipe SAX';
    const published = body.published !== false && body.published !== '0';

    const row = await prisma.blogPost.create({
      data: {
        slug,
        title,
        excerpt,
        content,
        coverUrl,
        tags: tagsJson,
        authorName,
        published,
        reactions: JSON.stringify({ likes: 0 }),
        comments: JSON.stringify([]),
      },
    });
    res.status(201).json(toPublicPost(row, { includePublished: true }));
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/blog/:id - atualiza post. Requer auth.
 */
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const row = await prisma.blogPost.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ message: 'Post não encontrado' });
      return;
    }
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.excerpt !== undefined) data.excerpt = String(body.excerpt).trim();
    if (body.content !== undefined) data.content = String(body.content).trim();
    if (body.coverUrl !== undefined) data.coverUrl = body.coverUrl == null ? null : String(body.coverUrl);
    if (body.tags !== undefined) data.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.map(String) : []);
    if (body.authorName !== undefined) data.authorName = String(body.authorName);
    if (body.published !== undefined) data.published = body.published !== false && body.published !== '0';
    if (body.slug !== undefined) data.slug = String(body.slug).trim() || row.slug;

    const updated = await prisma.blogPost.update({
      where: { id },
      data: data as Parameters<typeof prisma.blogPost.update>[0]['data'],
    });
    res.json(toPublicPost(updated, { includePublished: true }));
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/blog/:id - remove post. Requer auth.
 */
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    await prisma.blogPost.delete({ where: { id } });
    res.status(204).send();
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'P2025') {
      res.status(404).json({ message: 'Post não encontrado' });
      return;
    }
    next(e);
  }
});

export default router;
