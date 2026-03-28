import { randomUUID } from 'crypto';
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

function registrationIncompleteFromRow(row: Record<string, unknown>): boolean {
  const v = row.registration_incomplete ?? row.registrationIncomplete;
  return v === true || v === 'true' || v === 't' || v === 1 || v === '1';
}

function activeFromRow(row: Record<string, unknown>): boolean {
  const v = row.active;
  if (v === undefined || v === null) return true;
  return v === true || v === 'true' || v === 't' || v === 1 || v === '1';
}

/** Qualquer negócio CRM ligado a imóvel deste cliente impede exclusão física (evita dados órfãos). */
async function clientHasLinkedDeals(clientId: string): Promise<boolean> {
  const n = await prisma.crmLeadDeal.count({
    where: {
      property: { clientId },
    },
  });
  return n > 0;
}

function formatClient(c: {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  documentType?: string | null;
  birthDate?: Date | string | null;
  gender?: string | null;
  warehouseId: string | null;
  zip?: string | null;
  address?: string | null;
  addressNumber?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  marketingConsent?: boolean | null;
  communicationPreference?: string | null;
  createdAt: Date | string;
  registrationIncomplete?: boolean | null;
}) {
  const row = c as unknown as Record<string, unknown>;
  return {
    userid: c.id,
    company: c.name,
    name: c.name,
    email_default: c.email,
    phonenumber: c.phone,
    vat: c.document,
    document: c.document,
    documentType: c.documentType ?? null,
    birthDate: c.birthDate ? (c.birthDate instanceof Date ? c.birthDate.toISOString().split('T')[0] : String(c.birthDate).split('T')[0]) : null,
    gender: c.gender ?? null,
    warehouse_id: c.warehouseId,
    zip: c.zip ?? null,
    billing_street: c.address ?? null,
    address: c.address ?? null,
    billing_number: c.addressNumber ?? null,
    billing_complement: c.complement ?? null,
    billing_neighborhood: c.neighborhood ?? null,
    billing_city: c.city ?? null,
    billing_state: c.state ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    marketingConsent: c.marketingConsent ? '1' : '0',
    communicationPreference: c.communicationPreference ?? null,
    datecreated: c.createdAt instanceof Date ? c.createdAt.toISOString().split('T')[0] : String(c.createdAt).split('T')[0],
    active: activeFromRow(row) ? '1' : '0',
    registration_incomplete: registrationIncompleteFromRow(row) ? '1' : '0',
  };
}

function parseBirthDate(value: unknown) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return new Date(text);
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return new Date(text.split('/').reverse().join('-'));
  return null;
}

function normalizeClientBody(body: Record<string, unknown>) {
  const rawWarehouse = body.warehouse_id ?? body.warehouseId;
  return {
    name: String(body.company ?? body.name ?? '').trim(),
    email: body.email_default ?? body.email ?? null,
    phone: body.phonenumber ?? body.phone ?? null,
    document: body.vat ?? body.document ?? null,
    warehouseId: rawWarehouse != null && rawWarehouse !== '' ? String(rawWarehouse) : null,
    documentType: body.documentType != null ? String(body.documentType) : null,
    birthDate: parseBirthDate(body.birthDate),
    gender: body.gender != null ? String(body.gender) : null,
    zip: body.zip != null ? String(body.zip) : null,
    address: body.billing_street ?? body.address ?? null,
    addressNumber: body.billing_number ?? body.addressNumber ?? null,
    complement: body.billing_complement ?? body.complement ?? null,
    neighborhood: body.billing_neighborhood ?? body.neighborhood ?? null,
    city: body.billing_city ?? body.city ?? null,
    state: body.billing_state ?? body.state ?? null,
    marketingConsent: body.marketingConsent === '1' || body.marketingConsent === true,
    communicationPreference: body.communicationPreference != null ? String(body.communicationPreference) : null,
  };
}

/**
 * GET /api/client/:id - obtém um cliente (para edição e detalhes).
 */
async function getClient(req: import('express').Request, res: import('express').Response) {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'ID do cliente é obrigatório' });
      return;
    }
    const client = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        id,
        name,
        email,
        phone,
        document,
        "documentType",
        "birthDate",
        gender,
        "warehouseId",
        zip,
        address,
        "addressNumber",
        complement,
        neighborhood,
        city,
        state,
        "marketingConsent",
        "communicationPreference",
        "registration_incomplete",
        active,
        "createdAt"
      FROM "Client"
      WHERE id = ${id}
        AND "deleted_at" IS NULL
      LIMIT 1`;
    if (!client || client.length === 0) {
      res.status(404).json({ message: 'Cliente não encontrado' });
      return;
    }
    res.json(formatClient(client[0] as any));
  } catch (e) {
    res.status(500).json({ message: 'Erro ao buscar cliente' });
  }
}

/**
 * GET /api/client/list - lista clientes (query: warehouse_id opcional).
 */
async function listClients(req: import('express').Request, res: import('express').Response) {
  try {
    const warehouseId = (req.query.warehouse_id as string) || undefined;
    const list = warehouseId
      ? await prisma.$queryRaw<Array<Record<string, unknown>>>`
          SELECT
            id,
            name,
            email,
            phone,
            document,
            "documentType",
            "birthDate",
            gender,
            "warehouseId",
            zip,
            address,
            "addressNumber",
            complement,
            neighborhood,
            city,
            state,
            "marketingConsent",
            "communicationPreference",
            "registration_incomplete",
            active,
            "createdAt"
          FROM "Client"
          WHERE "warehouseId" = ${warehouseId}
            AND "deleted_at" IS NULL
            AND active = true
          ORDER BY name ASC`
      : await prisma.$queryRaw<Array<Record<string, unknown>>>`
          SELECT
            id,
            name,
            email,
            phone,
            document,
            "documentType",
            "birthDate",
            gender,
            "warehouseId",
            zip,
            address,
            "addressNumber",
            complement,
            neighborhood,
            city,
            state,
            "marketingConsent",
            "communicationPreference",
            "registration_incomplete",
            active,
            "createdAt"
          FROM "Client"
          WHERE "deleted_at" IS NULL
            AND active = true
          ORDER BY name ASC`;
    const formatted = list.map((row) => formatClient(row as any));
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ message: 'Erro ao listar clientes' });
  }
}

/**
 * POST /api/client/create - cria cliente.
 * Body: company ou name, email_default ou email, phonenumber ou phone, vat ou document, warehouse_id
 */
async function createClient(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>;
    const normalized = normalizeClientBody(body);
    if (!normalized.name) {
      res.status(400).json({ message: 'Nome do cliente é obrigatório' });
      return;
    }
    const id = randomUUID().replace(/-/g, '');
    const registrationIncomplete =
      body.registration_incomplete === true ||
      body.registration_incomplete === '1' ||
      body.registration_incomplete === 'true';
    const client = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      INSERT INTO "Client" (
        id,
        name,
        email,
        phone,
        document,
        "documentType",
        "birthDate",
        gender,
        "warehouseId",
        zip,
        address,
        "addressNumber",
        complement,
        neighborhood,
        city,
        state,
        "marketingConsent",
        "communicationPreference",
        "registration_incomplete",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${id}, ${normalized.name}, ${normalized.email}, ${normalized.phone}, ${normalized.document}, ${normalized.documentType}, ${normalized.birthDate}, ${normalized.gender}, ${normalized.warehouseId}, ${normalized.zip}, ${normalized.address}, ${normalized.addressNumber}, ${normalized.complement}, ${normalized.neighborhood}, ${normalized.city}, ${normalized.state}, ${normalized.marketingConsent}, ${normalized.communicationPreference}, ${registrationIncomplete}, NOW(), NOW()
      )
      RETURNING
        id,
        name,
        email,
        phone,
        document,
        "documentType",
        "birthDate",
        gender,
        "warehouseId",
        zip,
        address,
        "addressNumber",
        complement,
        neighborhood,
        city,
        state,
        "marketingConsent",
        "communicationPreference",
        "registration_incomplete",
        active,
        "createdAt"`;
    res.status(201).json(formatClient(client[0] as any));
  } catch (e) {
    console.error('Erro ao criar cliente:', e);
    res.status(500).json({ message: 'Erro ao criar cliente' });
  }
}

/**
 * PUT /api/client/:id - atualiza um cliente.
 */
async function updateClient(req: import('express').Request, res: import('express').Response) {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'ID do cliente é obrigatório' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const normalized = normalizeClientBody(body);
    const client = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      UPDATE "Client"
       SET
         name = ${normalized.name},
         email = ${normalized.email},
         phone = ${normalized.phone},
         document = ${normalized.document},
         "documentType" = ${normalized.documentType},
         "birthDate" = ${normalized.birthDate},
         gender = ${normalized.gender},
         "warehouseId" = ${normalized.warehouseId},
         zip = ${normalized.zip},
         address = ${normalized.address},
         "addressNumber" = ${normalized.addressNumber},
         complement = ${normalized.complement},
         neighborhood = ${normalized.neighborhood},
         city = ${normalized.city},
         state = ${normalized.state},
         "marketingConsent" = ${normalized.marketingConsent},
         "communicationPreference" = ${normalized.communicationPreference},
         "registration_incomplete" = false,
         "updatedAt" = NOW()
       WHERE id = ${id}
         AND "deleted_at" IS NULL
       RETURNING
         id,
         name,
         email,
         phone,
         document,
         "documentType",
         "birthDate",
         gender,
         "warehouseId",
         zip,
         address,
         "addressNumber",
         complement,
         neighborhood,
         city,
         state,
         "marketingConsent",
         "communicationPreference",
         "registration_incomplete",
         active,
         "createdAt"`;
    if (!client || client.length === 0) {
      res.status(404).json({ message: 'Cliente não encontrado' });
      return;
    }
    res.json(formatClient(client[0] as any));
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') {
      res.status(404).json({ message: 'Cliente não encontrado' });
      return;
    }
    console.error('Erro ao atualizar cliente:', e);
    res.status(500).json({ message: 'Erro ao atualizar cliente' });
  }
}

/**
 * POST /api/client/remove - remove clientes (body: { rows: string[] }).
 */
async function removeClients(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as { rows?: string[] };
    const ids = Array.isArray(body?.rows)
      ? body.rows.map((id) => String(id ?? '').trim()).filter(Boolean)
      : [];
    if (ids.length === 0) {
      res.status(400).json({ message: 'Nenhum cliente informado' });
      return;
    }
    const candidates = await prisma.client.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true },
    });
    /** Antes respondia 200 mesmo com 0 linhas — o front “sumia” por refresh mas o pgAdmin continuava igual (IDs errados / outra base). */
    if (candidates.length === 0) {
      res.status(400).json({
        message:
          'Nenhum cliente foi excluído: nenhum ID bateu com a base desta API. Confira se o PDV usa o mesmo banco que o pgAdmin ou o cliente já foi inativado.',
        deleted: 0,
      });
      return;
    }

    const candidateIds = candidates.map((c) => c.id);
    const dealChecks = await Promise.all(
      candidateIds.map(async (id) => ({
        id,
        hasDeals: await clientHasLinkedDeals(id),
      })),
    );

    const softIds = dealChecks.filter((x) => x.hasDeals).map((x) => x.id);
    const hardIds = dealChecks.filter((x) => !x.hasDeals).map((x) => x.id);

    if (softIds.length > 0) {
      await prisma.client.updateMany({
        where: { id: { in: softIds } },
        data: { deletedAt: new Date(), active: false },
      });
    }

    let hardDeleted = 0;
    if (hardIds.length > 0) {
      const r = await prisma.client.deleteMany({ where: { id: { in: hardIds } } });
      hardDeleted = r.count;
    }

    const softInactivated = softIds.length;
    res.json({
      success: true,
      deleted: softInactivated + hardDeleted,
      softInactivated,
      hardDeleted,
    });
  } catch (e) {
    console.error('Erro ao excluir clientes:', e);
    res.status(500).json({ message: 'Erro ao excluir clientes' });
  }
}

router.get('/list', listClients);
router.get('/list/', listClients);
router.get('/:id', getClient);
router.put('/:id', updateClient);
router.post('/create', createClient);
router.post('/create/', createClient);
router.post('/remove', removeClients);
router.post('/remove/', removeClients);

export default router;
