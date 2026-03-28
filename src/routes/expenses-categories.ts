import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { assertWarehouseAccess } from '../lib/financial.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

function asyncHandler(
  fn: (req: Authed, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req as Authed, res).catch((e: Error & { statusCode?: number }) => {
      const code = e.statusCode ?? 500;
      res.status(code).json({ status: false, message: e.message || 'Erro no servidor' });
    });
  };
}

function mapKind(type: unknown): 'receivable' | 'payable' {
  const t = String(type ?? '').toLowerCase();
  if (t === 'payable' || t === 'despesa' || t === 'expense') return 'payable';
  return 'receivable';
}

const listHandler = asyncHandler(async (req: Authed, res) => {
  const q = req.query as { warehouse_id?: string; type?: string; search?: string };
  const warehouseId = assertWarehouseAccess(req.user, q.warehouse_id);
  const kind = mapKind(q.type);
  const search = String(q.search ?? '').trim();

  const where = {
    warehouseId,
    kind,
    ...(search
      ? {
          name: { contains: search, mode: 'insensitive' as const },
        }
      : {}),
  };

  const rows = await prisma.finCategory.findMany({
    where,
    orderBy: { name: 'asc' },
  });

  res.json({
    status: true,
    data: rows.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? '',
    })),
  });
});

router.get('/', listHandler);
router.get('/list/', listHandler);

router.get(
  '/:id/',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const warehouseId = assertWarehouseAccess(
      req.user,
      (req.query as { warehouse_id?: string }).warehouse_id
    );
    const cat = await prisma.finCategory.findFirst({ where: { id } });
    if (!cat || cat.warehouseId !== warehouseId) {
      res.status(404).json({ status: false, message: 'Categoria não encontrada' });
      return;
    }
    res.json({
      status: true,
      data: { id: cat.id, name: cat.name, description: cat.description ?? '' },
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { warehouse_id?: string; name?: string; description?: string; type?: string };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const kind = mapKind(body.type);
    const name = String(body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ status: false, message: 'Nome é obrigatório' });
      return;
    }
    const created = await prisma.finCategory.create({
      data: {
        warehouseId,
        kind,
        name,
        description: body.description != null ? String(body.description) : null,
      },
    });
    res.status(201).json({ status: true, data: { id: created.id } });
  })
);

router.put(
  '/:id/',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const body = req.body as { warehouse_id?: string; name?: string; description?: string; type?: string };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const existing = await prisma.finCategory.findFirst({ where: { id } });
    if (!existing || existing.warehouseId !== warehouseId) {
      res.status(404).json({ status: false, message: 'Categoria não encontrada' });
      return;
    }
    const name = String(body.name ?? existing.name).trim();
    await prisma.finCategory.update({
      where: { id },
      data: {
        name,
        description: body.description != null ? String(body.description) : existing.description,
      },
    });
    res.json({ status: true });
  })
);

router.delete(
  '/:id/',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const existing = await prisma.finCategory.findFirst({ where: { id } });
    if (!existing) {
      res.status(404).json({ status: false, message: 'Categoria não encontrada' });
      return;
    }
    assertWarehouseAccess(req.user, existing.warehouseId);
    await prisma.finCategory.delete({ where: { id } });
    res.json({ status: true });
  })
);

export default router;
