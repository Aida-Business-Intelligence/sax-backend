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

router.get(
  '/list',
  asyncHandler(async (req: Authed, res) => {
    const q = req.query as { warehouse_id?: string };
    const warehouseId = assertWarehouseAccess(req.user, q.warehouse_id);
    const rows = await prisma.finBankAccount.findMany({
      where: { warehouseId },
      orderBy: { name: 'asc' },
    });
    res.json({
      status: true,
      data: rows.map((b) => ({
        id: b.id,
        name: b.name,
        bank_name: b.bankName ?? '',
        agency: b.agency ?? '',
        account_number: b.accountNumber,
      })),
    });
  })
);

/** Stub: integração Open Finance / OFX pode ser ligada depois. */
router.post(
  '/sync',
  asyncHandler(async (_req: Authed, res) => {
    res.json({ status: true, message: 'Nenhuma sincronização externa configurada.' });
  })
);

router.post(
  '/create',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as {
      warehouse_id?: string;
      name?: string;
      bank_name?: string;
      agency?: string;
      account_number?: string;
    };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const name = String(body.name ?? '').trim();
    const accountNumber = String(body.account_number ?? '').trim();
    if (!name || !accountNumber) {
      res.status(400).json({ status: false, message: 'Nome e número da conta são obrigatórios' });
      return;
    }
    const created = await prisma.finBankAccount.create({
      data: {
        warehouseId,
        name,
        bankName: body.bank_name != null ? String(body.bank_name) : null,
        agency: body.agency != null ? String(body.agency) : null,
        accountNumber,
      },
    });
    res.status(201).json({ status: true, data: { id: created.id } });
  })
);

router.post(
  '/update/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const body = req.body as {
      warehouse_id?: string;
      name?: string;
      bank_name?: string;
      agency?: string;
      account_number?: string;
    };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const existing = await prisma.finBankAccount.findFirst({ where: { id } });
    if (!existing || existing.warehouseId !== warehouseId) {
      res.status(404).json({ status: false, message: 'Conta não encontrada' });
      return;
    }
    await prisma.finBankAccount.update({
      where: { id },
      data: {
        name: String(body.name ?? existing.name).trim(),
        bankName: body.bank_name != null ? String(body.bank_name) : existing.bankName,
        agency: body.agency != null ? String(body.agency) : existing.agency,
        accountNumber: String(body.account_number ?? existing.accountNumber).trim(),
      },
    });
    res.json({ status: true });
  })
);

router.post(
  '/delete/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const existing = await prisma.finBankAccount.findFirst({ where: { id } });
    if (!existing) {
      res.status(404).json({ status: false, message: 'Conta não encontrada' });
      return;
    }
    assertWarehouseAccess(req.user, existing.warehouseId);
    await prisma.finBankAccount.delete({ where: { id } });
    res.json({ status: true });
  })
);

export default router;
