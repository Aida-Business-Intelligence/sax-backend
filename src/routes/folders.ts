import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

function formatFolder(row: { id: string; name: string; filesCount: number; size: number; isFavorite: boolean; parentId: string | null; createdAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    files_count: row.filesCount,
    size: String(row.size),
    is_favorite: row.isFavorite,
    parent_id: row.parentId,
    type: 'folder',
    created_at: row.createdAt,
  };
}

/**
 * POST /api/folders/create
 * Body: { name, files_count?, size?, parent_id? } — parent_id = subpasta
 * Resposta: { id, name, files_count, size } para o front usar response.id
 */
router.post('/create', async (req: Request, res: Response) => {
  try {
    const body = req.body as { name?: string; files_count?: number; size?: number; parent_id?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ status: false, message: 'Nome da pasta é obrigatório' });
      return;
    }
    const user = (req as Request & { user?: { warehouseId?: string | null } }).user;
    const warehouseId = user?.warehouseId ?? null;
    const parentId = typeof body.parent_id === 'string' && body.parent_id.trim() ? body.parent_id.trim() : null;

    const folder = await prisma.fileFolder.create({
      data: {
        name,
        filesCount: Number(body.files_count) || 0,
        size: Number(body.size) || 0,
        warehouseId,
        parentId,
      },
    });

    res.status(201).json({
      id: folder.id,
      name: folder.name,
      files_count: folder.filesCount,
      size: folder.size,
      status: true,
    });
  } catch (e) {
    console.error('folders create', e);
    res.status(500).json({ status: false, message: 'Erro ao criar pasta' });
  }
});

/**
 * GET /api/folders/list?page=1&limit=5&parent_id= — parent_id opcional: lista subpastas; omitir = pastas raiz
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;
    const parentIdParam = req.query.parent_id as string | undefined;
    const where = parentIdParam === '' || parentIdParam === undefined
      ? { parentId: null }
      : { parentId: parentIdParam };

    const [items, total] = await Promise.all([
      prisma.fileFolder.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.fileFolder.count({ where }),
    ]);

    res.json({
      data: items.map(formatFolder),
      total,
      page,
      limit,
    });
  } catch (e) {
    console.error('folders list', e);
    res.status(500).json({ status: false, message: 'Erro ao listar pastas' });
  }
});

/**
 * GET /api/folders/get/:id
 * Resposta: { status, data: { id, name, files_count, size, ... } }
 */
router.get('/get/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const folder = await prisma.fileFolder.findUnique({ where: { id } });
    if (!folder) {
      res.status(404).json({ status: false, message: 'Pasta não encontrada' });
      return;
    }
    res.json({
      status: true,
      data: {
        id: folder.id,
        name: folder.name,
        files_count: folder.filesCount,
        size: String(folder.size),
        is_favorite: folder.isFavorite,
        parent_id: folder.parentId,
      },
    });
  } catch (e) {
    console.error('folders get', e);
    res.status(500).json({ status: false, message: 'Erro ao obter pasta' });
  }
});

/**
 * PUT /api/folders/folderUpdate/:id
 * Body: { name?, is_favorite?, files_count?, size? }
 */
router.put('/folderUpdate/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body as { name?: string; is_favorite?: boolean; files_count?: number; size?: number };

    const folder = await prisma.fileFolder.findUnique({ where: { id } });
    if (!folder) {
      res.status(404).json({ status: false, message: 'Pasta não encontrada' });
      return;
    }

    const updateData: { name?: string; isFavorite?: boolean; filesCount?: number; size?: number } = {};
    if (typeof body.name === 'string' && body.name.trim()) updateData.name = body.name.trim();
    if (typeof body.is_favorite === 'boolean') updateData.isFavorite = body.is_favorite;
    if (typeof body.files_count === 'number') updateData.filesCount = body.files_count;
    if (typeof body.size === 'number') updateData.size = body.size;

    const updated = await prisma.fileFolder.update({
      where: { id },
      data: updateData,
    });

    res.json({
      status: true,
      id: updated.id,
      name: updated.name,
      files_count: updated.filesCount,
      size: updated.size,
    });
  } catch (e) {
    console.error('folders folderUpdate', e);
    res.status(500).json({ status: false, message: 'Erro ao atualizar pasta' });
  }
});

/**
 * DELETE /api/folders/delete/:id
 */
router.delete('/delete/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const folder = await prisma.fileFolder.findUnique({ where: { id } });
    if (!folder) {
      res.status(404).json({ status: false, message: 'Pasta não encontrada' });
      return;
    }
    await prisma.fileFolder.delete({ where: { id } });
    res.json({ status: true, message: 'Pasta excluída' });
  } catch (e) {
    console.error('folders delete', e);
    res.status(500).json({ status: false, message: 'Erro ao excluir pasta' });
  }
});

export default router;
