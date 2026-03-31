import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { assertWarehouseAccess } from '../lib/financial.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

type FinOriginDelegate = {
  findMany: (args: Prisma.FinOriginFindManyArgs) => Promise<{ id: string; name: string }[]>;
  findFirst: (args: Prisma.FinOriginFindFirstArgs) => Promise<{ id: string; warehouseId: string } | null>;
  create: (args: Prisma.FinOriginCreateArgs) => Promise<{ id: string }>;
  delete: (args: Prisma.FinOriginDeleteArgs) => Promise<unknown>;
};

/** Após `prisma generate`, existe `prisma.finOrigin`. Se o singleton estiver antigo (EPERM no Windows), fica `undefined`. */
function getFinOriginDelegate(): FinOriginDelegate | null {
  const d = (prisma as unknown as { finOrigin?: FinOriginDelegate }).finOrigin;
  if (!d || typeof d.findMany !== 'function') return null;
  return d;
}

const PRISMA_REGEN_MSG =
  'Prisma sem modelo FinOrigin. Pare o servidor Node, na pasta sax-backend execute `npx prisma generate` e reinicie (no Windows, se der EPERM, feche o IDE/terminal que bloqueia o ficheiro).';

function asyncHandler(
  fn: (req: Authed, res: Response) => Promise<void>
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req as Authed, res).catch((e: Error & { statusCode?: number }) => {
      const code = e.statusCode ?? 500;
      res.status(code).json({ success: false, status: false, message: e.message || 'Erro no servidor' });
    });
  };
}

/** Lista origens (compatível com PDV: success + data). */
router.get(
  '/list/',
  asyncHandler(async (req: Authed, res) => {
    const fo = getFinOriginDelegate();
    const q = req.query as { warehouse_id?: string; search?: string; page?: string; pageSize?: string };
    const warehouseId = assertWarehouseAccess(req.user, q.warehouse_id);
    const search = String(q.search ?? '').trim();
    const take = Math.min(100, Math.max(1, parseInt(String(q.pageSize ?? '50'), 10) || 50));

    if (!fo) {
      res.json({ success: true, status: true, data: [] });
      return;
    }

    const where: Prisma.FinOriginWhereInput = { warehouseId };
    if (search) {
      where.name = { contains: search, mode: Prisma.QueryMode.insensitive };
    }

    const rows = await fo.findMany({
      where,
      orderBy: { name: 'asc' },
      take,
    });

    res.json({
      success: true,
      status: true,
      data: rows.map((o) => ({ id: o.id, name: o.name })),
    });
  })
);

router.post(
  '/create/',
  asyncHandler(async (req: Authed, res) => {
    const fo = getFinOriginDelegate();
    const body = req.body as { warehouse_id?: string; name?: string };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const name = String(body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ success: false, status: false, message: 'Nome é obrigatório' });
      return;
    }
    if (!fo) {
      res.status(503).json({ success: false, status: false, message: PRISMA_REGEN_MSG });
      return;
    }
    const created = await fo.create({
      data: { warehouseId, name },
    });
    res.status(201).json({ success: true, status: true, data: { id: created.id } });
  })
);

router.post(
  '/delete/',
  asyncHandler(async (req: Authed, res) => {
    const fo = getFinOriginDelegate();
    const body = req.body as { id?: string };
    const id = String(body.id ?? '').trim();
    if (!id) {
      res.status(400).json({ success: false, status: false, message: 'id é obrigatório' });
      return;
    }
    if (!fo) {
      res.status(503).json({ success: false, status: false, message: PRISMA_REGEN_MSG });
      return;
    }
    const row = await fo.findFirst({ where: { id } });
    if (!row) {
      res.status(404).json({ success: false, status: false, message: 'Origem não encontrada' });
      return;
    }
    assertWarehouseAccess(req.user, row.warehouseId);

    const txs = await prisma.finTransaction.findMany({
      where: { warehouseId: row.warehouseId, kind: 'RECEIVABLE' },
      select: { metadata: true },
    });
    const inUse = txs.some((t) => {
      const m = t.metadata as Record<string, unknown> | null;
      return m && typeof m === 'object' && String(m.originId ?? '') === id;
    });
    if (inUse) {
      res.status(409).json({
        success: false,
        status: false,
        message: 'Não é possível excluir esta origem pois ela está associada a uma ou mais receitas.',
      });
      return;
    }

    await fo.delete({ where: { id } });
    res.json({ success: true, status: true, message: 'OK' });
  })
);

export default router;
