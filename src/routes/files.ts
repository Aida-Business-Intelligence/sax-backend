import { Router, Request, Response } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { uploadPrivate, deleteObject, getPresignedUrl, keys } from '../lib/storage.js';
import { SIZE } from '../lib/file-validation.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.PDV_FILE },
});

router.use(authMiddleware);

function formatFileMeta(row: { id: string; name: string; size: number; type: string | null; path: string; isFavorite: boolean; folderId: string; createdAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    size: String(row.size),
    type: row.type || '',
    path: row.path,
    is_favorite: row.isFavorite,
    folder_id: row.folderId,
    created_at: row.createdAt,
  };
}

/**
 * POST /api/files/create
 * multipart: folder_id, name, size, type, file[] (array of files)
 * Ou para upload sem pasta: só file[] (não envia folder_id) - não suportado; front deve enviar folder_id
 */
router.post('/create', upload.array('file[]', 20), async (req: Request, res: Response) => {
  try {
    const folderId = (req.body as { folder_id?: string }).folder_id;
    const names = (req.body as { name?: string | string[] }).name;
    const sizes = (req.body as { size?: string | string[] }).size;
    const types = (req.body as { type?: string | string[] }).type;
    const files = req.files as Express.Multer.File[] | undefined;

    if (!folderId || !files?.length) {
      res.status(400).json({ status: false, message: 'folder_id e ao menos um arquivo são obrigatórios' });
      return;
    }

    const folder = await prisma.fileFolder.findUnique({ where: { id: folderId } });
    if (!folder) {
      res.status(404).json({ status: false, message: 'Pasta não encontrada' });
      return;
    }

    const nameArr = Array.isArray(names) ? names : names ? [names] : [];
    const sizeArr = Array.isArray(sizes) ? sizes : sizes ? [sizes] : [];
    const typeArr = Array.isArray(types) ? types : types ? [types] : [];

    let totalSize = folder.size;
    const created: { id: string; name: string; size: number }[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = (nameArr[i] ?? file.originalname ?? 'file').trim();
      const size = Number(sizeArr[i]) || file.size || 0;
      const type = typeArr[i] ?? file.mimetype ?? '';
      const safeName = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = keys.pdvFile(folderId, `${Date.now()}-${safeName}`);
      await uploadPrivate(key, file.buffer, file.mimetype || 'application/octet-stream');

      const row = await prisma.file.create({
        data: {
          folderId,
          name,
          size,
          type: String(type).slice(0, 255),
          path: key,
        },
      });
      totalSize += size;
      created.push({ id: row.id, name: row.name, size: row.size });
    }

    await prisma.fileFolder.update({
      where: { id: folderId },
      data: {
        filesCount: folder.filesCount + files.length,
        size: totalSize,
      },
    });

    res.status(201).json({
      status: true,
      data: created.length === 1 ? created[0] : created,
    });
  } catch (e) {
    console.error('files create', e);
    res.status(500).json({ status: false, message: 'Erro ao enviar arquivos' });
  }
});

/**
 * GET /api/files/list?page=1&limit=5&folder_id= — folder_id opcional: filtra por pasta
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const folderIdParam = req.query.folder_id as string | undefined;
    const where = folderIdParam ? { folderId: folderIdParam } : {};

    const [items, total] = await Promise.all([
      prisma.file.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.file.count({ where }),
    ]);

    const data = await Promise.all(
      items.map(async (row) => {
        const url = await getPresignedUrl(row.path, 300);
        // file_path expõe a URL assinada para que o front possa fazer fetch() direto
        return { ...formatFileMeta(row), url, file_path: url };
      }),
    );

    res.json({
      data,
      total,
      page,
      limit,
    });
  } catch (e) {
    console.error('files list', e);
    res.status(500).json({ status: false, message: 'Erro ao listar arquivos' });
  }
});

/**
 * DELETE /api/files/delete/:id
 */
router.delete('/delete/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const file = await prisma.file.findUnique({ where: { id }, include: { folder: true } });
    if (!file) {
      res.status(404).json({ status: false, message: 'Arquivo não encontrado' });
      return;
    }
    await deleteObject(file.path);
    await prisma.file.delete({ where: { id } });
    await prisma.fileFolder.update({
      where: { id: file.folderId },
      data: {
        filesCount: Math.max(0, file.folder.filesCount - 1),
        size: Math.max(0, file.folder.size - file.size),
      },
    });
    res.json({ status: true, message: 'Arquivo excluído' });
  } catch (e) {
    console.error('files delete', e);
    res.status(500).json({ status: false, message: 'Erro ao excluir arquivo' });
  }
});

/**
 * DELETE /api/files/bulk_delete_by_folder/:folderId
 */
router.delete('/bulk_delete_by_folder/:folderId', async (req: Request, res: Response) => {
  try {
    const { folderId } = req.params;
    const folder = await prisma.fileFolder.findUnique({ where: { id: folderId }, include: { files: true } });
    if (!folder) {
      res.status(404).json({ status: false, message: 'Pasta não encontrada' });
      return;
    }
    await Promise.all(folder.files.map((f) => deleteObject(f.path)));
    await prisma.file.deleteMany({ where: { folderId } });
    await prisma.fileFolder.update({
      where: { id: folderId },
      data: { filesCount: 0, size: 0 },
    });
    res.json({ status: true, message: 'Arquivos da pasta excluídos' });
  } catch (e) {
    console.error('files bulk_delete_by_folder', e);
    res.status(500).json({ status: false, message: 'Erro ao excluir arquivos' });
  }
});

/**
 * PUT /api/files/favorite/:id
 * Body: { is_favorite: boolean }
 */
router.put('/favorite/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isFavorite = Boolean((req.body as { is_favorite?: boolean }).is_favorite);
    const file = await prisma.file.findUnique({ where: { id } });
    if (!file) {
      res.status(404).json({ status: false, message: 'Arquivo não encontrado' });
      return;
    }
    await prisma.file.update({ where: { id }, data: { isFavorite } });
    res.json({ status: true, is_favorite: isFavorite });
  } catch (e) {
    console.error('files favorite', e);
    res.status(500).json({ status: false, message: 'Erro ao atualizar favorito' });
  }
});

/**
 * GET /api/files/chart
 * Resposta: { chart: [] } para o PDV File (gráfico de uso)
 */
router.get('/chart', async (_req: Request, res: Response) => {
  try {
    const byFolder = await prisma.fileFolder.findMany({
      include: { files: { select: { size: true } } },
    });
    const chart = byFolder.map((f) => {
      const value = f.files.reduce((s, x) => s + x.size, 0);
      return { label: f.name, value };
    });
    res.json({ chart });
  } catch (e) {
    console.error('files chart', e);
    res.status(500).json({ chart: [] });
  }
});

export default router;
