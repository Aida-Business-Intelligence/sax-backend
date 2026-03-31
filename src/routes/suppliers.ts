import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { assertWarehouseAccess } from '../lib/financial.js';

const router = Router();
router.use(authMiddleware);

type Authed = Request & { user: { id: string; warehouseId: string | null } };

/** Resposta JSON (camelCase), alinhada ao Prisma model Supplier. */
export type SupplierApi = {
  id: string;
  warehouseId: string;
  name: string;
  personType: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  supplyKind: string;
  serviceType: string | null;
  productType: string | null;
  notes: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Fragmento SQL seguro para SELECT / RETURNING (Prisma.sql, não string interpolada). */
const SUPPLIER_COLUMNS = Prisma.sql`
  id,
  warehouse_id AS "warehouseId",
  name,
  person_type AS "personType",
  document,
  email,
  phone,
  supply_kind AS "supplyKind",
  service_type AS "serviceType",
  product_type AS "productType",
  notes,
  active,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

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

const SUPPLY_KINDS = new Set(['service', 'product', 'both']);

function normalizeBody(body: Record<string, unknown>) {
  const supplyKind = String(body.supply_kind ?? body.supplyKind ?? 'service').trim();
  if (!SUPPLY_KINDS.has(supplyKind)) {
    const err = new Error('supply_kind inválido (use service, product ou both)');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  const serviceType =
    body.service_type != null && String(body.service_type).trim()
      ? String(body.service_type).trim()
      : null;
  const productType =
    body.product_type != null && String(body.product_type).trim()
      ? String(body.product_type).trim()
      : null;

  if (supplyKind === 'service' || supplyKind === 'both') {
    if (!serviceType) {
      const err = new Error('Tipo de serviço é obrigatório para este fornecimento');
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }
  if (supplyKind === 'product' || supplyKind === 'both') {
    if (!productType) {
      const err = new Error('Tipo de produto é obrigatório para este fornecimento');
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }

  return {
    name: String(body.name ?? '').trim(),
    personType: String(body.person_type ?? body.personType ?? 'pj').trim() || 'pj',
    document: body.document != null && String(body.document).trim() ? String(body.document).trim() : null,
    email: body.email != null && String(body.email).trim() ? String(body.email).trim() : null,
    phone: body.phone != null && String(body.phone).trim() ? String(body.phone).trim() : null,
    supplyKind,
    serviceType: supplyKind === 'product' ? null : serviceType,
    productType: supplyKind === 'service' ? null : productType,
    notes: body.notes != null && String(body.notes).trim() ? String(body.notes).trim() : null,
    active: body.active === false || body.active === '0' ? false : true,
  };
}

router.get(
  '/',
  asyncHandler(async (req: Authed, res) => {
    const warehouseId = assertWarehouseAccess(req.user, (req.query as { warehouse_id?: string }).warehouse_id);
    const search = String((req.query as { search?: string }).search ?? '').trim();

    let rows: SupplierApi[];
    if (search) {
      const p = `%${search}%`;
      rows = await prisma.$queryRaw<SupplierApi[]>`
        SELECT ${SUPPLIER_COLUMNS}
        FROM suppliers
        WHERE warehouse_id = ${warehouseId}
          AND (
            name ILIKE ${p}
            OR COALESCE(document, '') ILIKE ${p}
            OR COALESCE(email, '') ILIKE ${p}
          )
        ORDER BY name ASC
      `;
    } else {
      rows = await prisma.$queryRaw<SupplierApi[]>`
        SELECT ${SUPPLIER_COLUMNS}
        FROM suppliers
        WHERE warehouse_id = ${warehouseId}
        ORDER BY name ASC
      `;
    }

    res.json({ status: true, data: rows, total: rows.length });
  })
);

/** Exclusão em massa (ids da loja). Deve ficar antes de GET /:id. */
router.post(
  '/bulk-delete',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { warehouse_id?: string; ids?: unknown };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!ids.length) {
      res.status(400).json({ status: false, message: 'ids é obrigatório' });
      return;
    }
    await prisma.$executeRaw`
      DELETE FROM suppliers
      WHERE warehouse_id = ${warehouseId}
        AND id IN (${Prisma.join(ids)})
    `;
    res.json({ status: true, deleted: ids.length });
  })
);

/** Ativar / desativar em massa. */
router.post(
  '/bulk-active',
  asyncHandler(async (req: Authed, res) => {
    const body = req.body as { warehouse_id?: string; ids?: unknown; active?: unknown };
    const warehouseId = assertWarehouseAccess(req.user, body.warehouse_id);
    const ids = Array.isArray(body.ids)
      ? body.ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!ids.length) {
      res.status(400).json({ status: false, message: 'ids é obrigatório' });
      return;
    }
    const active = !(body.active === false || body.active === '0' || body.active === 0);
    const now = new Date();
    await prisma.$executeRaw`
      UPDATE suppliers
      SET active = ${active}, updated_at = ${now}
      WHERE warehouse_id = ${warehouseId}
        AND id IN (${Prisma.join(ids)})
    `;
    res.json({ status: true, updated: ids.length });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const found = await prisma.$queryRaw<SupplierApi[]>`
      SELECT ${SUPPLIER_COLUMNS}
      FROM suppliers
      WHERE id = ${id}
      LIMIT 1
    `;
    const row = found[0];
    if (!row) {
      res.status(404).json({ status: false, message: 'Fornecedor não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, row.warehouseId);
    res.json({ status: true, data: row });
  })
);

router.post(
  '/',
  asyncHandler(async (req: Authed, res) => {
    const body = normalizeBody(req.body as Record<string, unknown>);
    if (!body.name) {
      res.status(400).json({ status: false, message: 'Nome é obrigatório' });
      return;
    }
    const warehouseId = assertWarehouseAccess(
      req.user,
      (req.body as { warehouse_id?: string }).warehouse_id
    );
    const id = randomUUID();
    /** Migração define `updated_at` NOT NULL sem DEFAULT; INSERT raw deve preencher. */
    const now = new Date();
    const created = await prisma.$queryRaw<SupplierApi[]>`
      INSERT INTO suppliers (
        id, warehouse_id, name, person_type, document, email, phone,
        supply_kind, service_type, product_type, notes, active,
        created_at, updated_at
      )
      VALUES (
        ${id},
        ${warehouseId},
        ${body.name},
        ${body.personType},
        ${body.document},
        ${body.email},
        ${body.phone},
        ${body.supplyKind},
        ${body.serviceType},
        ${body.productType},
        ${body.notes},
        ${body.active},
        ${now},
        ${now}
      )
      RETURNING ${SUPPLIER_COLUMNS}
    `;
    const row = created[0];
    res.status(201).json({ status: true, data: row });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const existingRows = await prisma.$queryRaw<SupplierApi[]>`
      SELECT ${SUPPLIER_COLUMNS}
      FROM suppliers
      WHERE id = ${id}
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ status: false, message: 'Fornecedor não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, (req.body as { warehouse_id?: string }).warehouse_id ?? existing.warehouseId);
    const body = normalizeBody(req.body as Record<string, unknown>);
    if (!body.name) {
      res.status(400).json({ status: false, message: 'Nome é obrigatório' });
      return;
    }
    const updatedAt = new Date();
    const updated = await prisma.$queryRaw<SupplierApi[]>`
      UPDATE suppliers SET
        name = ${body.name},
        person_type = ${body.personType},
        document = ${body.document},
        email = ${body.email},
        phone = ${body.phone},
        supply_kind = ${body.supplyKind},
        service_type = ${body.serviceType},
        product_type = ${body.productType},
        notes = ${body.notes},
        active = ${body.active},
        updated_at = ${updatedAt}
      WHERE id = ${id}
      RETURNING ${SUPPLIER_COLUMNS}
    `;
    const row = updated[0];
    res.json({ status: true, data: row });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: Authed, res) => {
    const id = String(req.params.id ?? '').trim();
    const existingRows = await prisma.$queryRaw<SupplierApi[]>`
      SELECT ${SUPPLIER_COLUMNS}
      FROM suppliers
      WHERE id = ${id}
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({ status: false, message: 'Fornecedor não encontrado' });
      return;
    }
    assertWarehouseAccess(req.user, (req.query as { warehouse_id?: string }).warehouse_id ?? existing.warehouseId);
    await prisma.$executeRaw`
      DELETE FROM suppliers WHERE id = ${id}
    `;
    res.json({ status: true });
  })
);

export default router;
