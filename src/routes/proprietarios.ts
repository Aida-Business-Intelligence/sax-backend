import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import {
  dispatchProprietarioCredentialNotifications,
  generateProvisionalPassword,
  generateUniqueProvisionalPassword,
  parseNotifyCredentials,
} from '../lib/proprietario-credentials.js';
import { publicUploadUrl } from '../lib/public-asset-url.js';

const router = Router();

type ProprietarioStatus = 'pending' | 'active' | 'inactive' | 'rejected';

const statusValues = new Set(['pending', 'active', 'inactive', 'rejected']);
const origemValues = new Set(['erp', 'web']);

let proprietarioSchemaPromise: Promise<void> | null = null;

async function ensureProprietarioSchema() {
  if (!proprietarioSchemaPromise) {
    proprietarioSchemaPromise = (async () => {
      await prisma.$executeRaw(Prisma.sql`
        ALTER TABLE "Proprietario"
          ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS "origem" TEXT NOT NULL DEFAULT 'erp',
          ADD COLUMN IF NOT EXISTS "subdomain" TEXT,
          ADD COLUMN IF NOT EXISTS "access_email" TEXT,
          ADD COLUMN IF NOT EXISTS "password_hash" TEXT,
          ADD COLUMN IF NOT EXISTS "last_provisional_password" TEXT,
          ADD COLUMN IF NOT EXISTS "credential_notify_email" TEXT,
          ADD COLUMN IF NOT EXISTS "credential_notify_whatsapp" TEXT,
          ADD COLUMN IF NOT EXISTS "credential_portal_base_url" TEXT,
          ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3),
          ADD COLUMN IF NOT EXISTS "foto_url" TEXT
      `);

      await prisma.$executeRaw(Prisma.sql`
        CREATE UNIQUE INDEX IF NOT EXISTS "Proprietario_subdomain_key"
        ON "Proprietario"("subdomain")
      `);
    })();
  }

  return proprietarioSchemaPromise;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  subdomain: z.string().optional(),
});

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `prop-${Date.now()}`;
}

function normalizeText(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function normalizeStatus(value: unknown, fallback: ProprietarioStatus = 'pending'): ProprietarioStatus {
  const status = normalizeText(value)?.toLowerCase();
  if (status === 'pending' || status === 'active' || status === 'inactive' || status === 'rejected') {
    return status;
  }
  return fallback;
}

function resolveCreateStatus(origin: string): ProprietarioStatus {
  return origin === 'web' ? 'pending' : 'active';
}

function resolveUpdatedStatus(current: { status?: unknown; origem?: unknown }, requested: unknown): ProprietarioStatus {
  const currentStatus = normalizeStatus(current.status, 'active');
  const currentOrigem = normalizeOrigem(current.origem, 'erp');
  const requestedStatus = normalizeText(requested)?.toLowerCase();

  if (!requestedStatus) {
    return currentStatus;
  }

  if (currentOrigem === 'erp') {
    return requestedStatus === 'inactive' ? 'inactive' : 'active';
  }

  if (requestedStatus === 'active' || requestedStatus === 'inactive' || requestedStatus === 'rejected') {
    return requestedStatus;
  }

  return currentStatus;
}

function normalizeOrigem(value: unknown, fallback = 'erp') {
  const origem = normalizeText(value)?.toLowerCase();
  return origem && origemValues.has(origem) ? origem : fallback;
}

function normalizeAccessBody(body: Record<string, unknown>) {
  const password = normalizeText(body.password ?? body.temp_password ?? body.tempPassword);
  const subdomainRaw = normalizeText(body.subdomain);
  const accessEmailRaw = normalizeText(body.access_email ?? body.accessEmail);
  const createAccess = body.createAccess === true || body.createAccess === '1' || body.createAccess === 1;
  return {
    nome: normalizeText(body.nome ?? body.name) ?? '',
    email: normalizeText(body.email),
    telefone: normalizeText(body.telefone ?? body.phonenumber),
    tipo_documento: normalizeText(body.tipo_documento ?? body.documentType) ?? 'CPF',
    cpf_cnpj: normalizeText(body.cpf_cnpj ?? body.vat ?? body.document),
    cep: normalizeText(body.cep ?? body.zip),
    endereco: normalizeText(body.endereco ?? body.billing_street ?? body.address),
    numero: normalizeText(body.numero ?? body.billing_number ?? body.addressNumber),
    complemento: normalizeText(body.complemento ?? body.billing_complement ?? body.complement),
    bairro: normalizeText(body.bairro ?? body.billing_neighborhood ?? body.neighborhood),
    cidade: normalizeText(body.cidade ?? body.billing_city ?? body.city),
    estado: normalizeText(body.estado ?? body.billing_state ?? body.state),
    observacoes: normalizeText(body.observacoes ?? body.note),
    warehouse_id: normalizeText(body.warehouse_id ?? body.warehouseId),
    status: normalizeText(body.status),
    origem: normalizeText(body.origem),
    subdomain: subdomainRaw,
    access_email: accessEmailRaw,
    password,
    createAccess,
    must_change_password: body.must_change_password === true || body.mustChangePassword === true || body.must_change_password === '1' || body.mustChangePassword === '1',
  };
}

/** Destinos salvos no cadastro (PDV) para reabrir no editar; mesmo objeto de notify_credentials. */
function normalizeNotifyCredentialStorage(body: Record<string, unknown>) {
  const raw = body.notify_credentials ?? body.notifyCredentials;
  if (!raw || typeof raw !== 'object') {
    return { email_to: null as string | null, whatsapp_phone: null as string | null, portal_base_url: null as string | null };
  }
  const o = raw as Record<string, unknown>;
  const email = typeof o.email_to === 'string' ? o.email_to.trim() : '';
  const wa = typeof o.whatsapp_phone === 'string' ? o.whatsapp_phone.trim() : '';
  const url = typeof o.portal_base_url === 'string' ? o.portal_base_url.trim().replace(/\/$/, '') : '';
  return {
    email_to: email || null,
    whatsapp_phone: wa || null,
    portal_base_url: url || null,
  };
}

function formatProprietario(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ''),
    userid: String(row.id ?? ''),
    nome: String(row.nome ?? ''),
    name: String(row.nome ?? ''),
    email: row.email != null ? String(row.email) : '',
    telefone: row.telefone != null ? String(row.telefone) : '',
    phonenumber: row.telefone != null ? String(row.telefone) : '',
    tipo_documento: row.tipo_documento != null ? String(row.tipo_documento) : 'CPF',
    cpf_cnpj: row.cpf_cnpj != null ? String(row.cpf_cnpj) : '',
    vat: row.cpf_cnpj != null ? String(row.cpf_cnpj) : '',
    document: row.cpf_cnpj != null ? String(row.cpf_cnpj) : '',
    cep: row.cep != null ? String(row.cep) : '',
    zip: row.cep != null ? String(row.cep) : '',
    endereco: row.endereco != null ? String(row.endereco) : '',
    billing_street: row.endereco != null ? String(row.endereco) : '',
    numero: row.numero != null ? String(row.numero) : '',
    billing_number: row.numero != null ? String(row.numero) : '',
    complemento: row.complemento != null ? String(row.complemento) : '',
    billing_complement: row.complemento != null ? String(row.complemento) : '',
    bairro: row.bairro != null ? String(row.bairro) : '',
    billing_neighborhood: row.bairro != null ? String(row.bairro) : '',
    cidade: row.cidade != null ? String(row.cidade) : '',
    billing_city: row.cidade != null ? String(row.cidade) : '',
    estado: row.estado != null ? String(row.estado) : '',
    billing_state: row.estado != null ? String(row.estado) : '',
    observacoes: row.observacoes != null ? String(row.observacoes) : '',
    note: row.observacoes != null ? String(row.observacoes) : '',
    warehouse_id: row.warehouse_id != null ? String(row.warehouse_id) : '',
    warehouse_name:
      row.warehouse_name != null
        ? String(row.warehouse_name)
        : row.warehouseName != null
          ? String(row.warehouseName)
          : '',
    status: row.status != null ? String(row.status) : 'pending',
    origem: row.origem != null ? String(row.origem) : 'erp',
    subdomain: row.subdomain != null ? String(row.subdomain) : '',
    access_email: row.access_email != null ? String(row.access_email) : '',
    last_provisional_password:
      row.last_provisional_password != null ? String(row.last_provisional_password) : '',
    credential_notify_email:
      row.credential_notify_email != null ? String(row.credential_notify_email) : '',
    credential_notify_whatsapp:
      row.credential_notify_whatsapp != null ? String(row.credential_notify_whatsapp) : '',
    credential_portal_base_url:
      row.credential_portal_base_url != null ? String(row.credential_portal_base_url) : '',
    must_change_password: Boolean(row.must_change_password),
    mustChangePassword: Boolean(row.must_change_password),
    has_access: Boolean(row.password_hash),
    approvedAt: row.approvedAt ?? null,
    rejectedAt: row.rejectedAt ?? null,
    foto_url: publicUploadUrl(
      row.foto_url != null ? String(row.foto_url) : row.fotoUrl != null ? String(row.fotoUrl) : '',
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildWhere(search?: string, warehouseId?: string, tableAlias?: 'p') {
  const p = tableAlias ? 'p.' : '';
  const filters: Prisma.Sql[] = [];
  if (warehouseId) filters.push(Prisma.sql`${Prisma.raw(`${p}warehouse_id`)} = ${warehouseId}`);
  if (search) {
    const like = `%${search}%`;
    filters.push(
      Prisma.sql`(
        ${Prisma.raw(`${p}nome`)} ILIKE ${like}
        OR ${Prisma.raw(`${p}email`)} ILIKE ${like}
        OR ${Prisma.raw(`${p}telefone`)} ILIKE ${like}
        OR ${Prisma.raw(`${p}cpf_cnpj`)} ILIKE ${like}
        OR ${Prisma.raw(`${p}cidade`)} ILIKE ${like}
      )`,
    );
  }
  if (!filters.length) return null;
  return Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`;
}

function isMissingProprietarioColumnError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  return message.includes('coluna "status" não existe')
    || message.includes('coluna "origem" não existe')
    || message.includes('column "status" does not exist')
    || message.includes('column "origem" does not exist');
}

function listSelect(includeOptionalColumns: boolean) {
  if (includeOptionalColumns) {
    return Prisma.sql`
      SELECT
        p.id,
        p.nome,
        p.email,
        p.telefone,
        p.cpf_cnpj,
        p.cidade,
        p.observacoes,
        p.warehouse_id,
        w."warehouseName" AS warehouse_name,
        p.status,
        p.origem,
        p.foto_url,
        p."createdAt"
      FROM "Proprietario" p
      LEFT JOIN "Warehouse" w ON w.id = p.warehouse_id
    `;
  }

  return Prisma.sql`
    SELECT
      p.id,
      p.nome,
      p.email,
      p.telefone,
      p.cpf_cnpj,
      p.cidade,
      p.observacoes,
      p.warehouse_id,
      w."warehouseName" AS warehouse_name,
      NULL::text AS status,
      NULL::text AS origem,
      NULL::text AS foto_url,
      p."createdAt"
    FROM "Proprietario" p
    LEFT JOIN "Warehouse" w ON w.id = p.warehouse_id
  `;
}

async function queryList(queryWhere: Prisma.Sql | null, pageSize: number, offset: number) {
  const run = async (includeOptionalColumns: boolean) => {
    const fromClause = listSelect(includeOptionalColumns);
    const total = await prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total
      FROM "Proprietario" p
      ${queryWhere ?? Prisma.empty}
    `);
    const data = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      ${fromClause}
      ${queryWhere ?? Prisma.empty}
      ORDER BY p."createdAt" DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);
    return { total, data };
  };

  try {
    return await run(true);
  } catch (error) {
    if (!isMissingProprietarioColumnError(error)) throw error;
    return run(false);
  }
}

async function list(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize ?? 25) || 25, 1);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const warehouseId = typeof req.query.warehouse_id === 'string' ? req.query.warehouse_id.trim() : '';
    const where = buildWhere(search, warehouseId || undefined, 'p');
    const offset = (page - 1) * pageSize;
    const { total, data } = await queryList(where, pageSize, offset);
    res.json({ data: data.map(formatProprietario), total: Number(total[0]?.total ?? 0) });
  } catch (error) {
    console.error('Erro ao listar proprietários:', error);
    res.status(500).json({ message: 'Erro ao listar proprietários' });
  }
}

async function getById(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'ID do proprietário é obrigatório' });
      return;
    }
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        p.id,
        p.nome,
        p.email,
        p.telefone,
        p.tipo_documento,
        p.cpf_cnpj,
        p.cep,
        p.endereco,
        p.numero,
        p.complemento,
        p.bairro,
        p.cidade,
        p.estado,
        p.observacoes,
        p.warehouse_id,
        w."warehouseName" AS warehouse_name,
        p.status,
        p.origem,
        p.subdomain,
        p.access_email,
        p.last_provisional_password,
        p.credential_notify_email,
        p.credential_notify_whatsapp,
        p.credential_portal_base_url,
        p.must_change_password,
        p.password_hash,
        p."approvedAt",
        p."rejectedAt",
        p.foto_url,
        p."createdAt",
        p."updatedAt"
      FROM "Proprietario" p
      LEFT JOIN "Warehouse" w ON w.id = p.warehouse_id
      WHERE p.id = ${id}
      LIMIT 1
    `);
    if (!rows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatProprietario(rows[0]));
  } catch (error) {
    console.error('Erro ao buscar proprietário:', error);
    res.status(500).json({ message: 'Erro ao buscar proprietário' });
  }
}

async function insertOwner(
  data: ReturnType<typeof normalizeAccessBody>,
  options: { forceStatus?: string | null; forceOrigem?: string | null } = {},
  nc: ReturnType<typeof normalizeNotifyCredentialStorage> = {
    email_to: null,
    whatsapp_phone: null,
    portal_base_url: null,
  },
) {
  const id = randomUUID().replace(/-/g, '');
  const shouldCreateAccess = Boolean(data.password || data.access_email || data.subdomain || data.createAccess);
  const origin = normalizeOrigem(options.forceOrigem ?? data.origem, 'erp');
  const status = resolveCreateStatus(origin);
  const subdomain = data.subdomain || (shouldCreateAccess ? slugify(data.nome) : null);
  const accessEmail = data.access_email || (shouldCreateAccess ? data.email : null);
  const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
  const lastProvisional = passwordHash && data.password ? data.password : null;
  const mustChangePassword = shouldCreateAccess ? (data.must_change_password || status === 'active') : false;
  const credEmail = data.createAccess ? nc.email_to : null;
  const credWa = data.createAccess ? nc.whatsapp_phone : null;
  const credUrl = data.createAccess ? nc.portal_base_url : null;

  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    INSERT INTO "Proprietario" (
      id,
      nome,
      email,
      telefone,
      tipo_documento,
      cpf_cnpj,
      cep,
      endereco,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
      observacoes,
      warehouse_id,
      status,
      origem,
      subdomain,
      access_email,
      password_hash,
      last_provisional_password,
      credential_notify_email,
      credential_notify_whatsapp,
      credential_portal_base_url,
      must_change_password,
      "approvedAt",
      "rejectedAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${id},
      ${data.nome},
      ${data.email},
      ${data.telefone},
      ${data.tipo_documento},
      ${data.cpf_cnpj},
      ${data.cep},
      ${data.endereco},
      ${data.numero},
      ${data.complemento},
      ${data.bairro},
      ${data.cidade},
      ${data.estado},
      ${data.observacoes},
      ${data.warehouse_id},
      ${status},
      ${origin},
      ${subdomain},
      ${accessEmail},
      ${passwordHash},
      ${lastProvisional},
      ${credEmail},
      ${credWa},
      ${credUrl},
      ${mustChangePassword},
      ${status === 'active' ? new Date() : null},
      ${null},
      NOW(),
      NOW()
    )
    RETURNING
      id,
      nome,
      email,
      telefone,
      tipo_documento,
      cpf_cnpj,
      cep,
      endereco,
      numero,
      complemento,
      bairro,
      cidade,
      estado,
      observacoes,
      foto_url,
      warehouse_id,
      status,
      origem,
      subdomain,
      access_email,
      must_change_password,
      password_hash,
      last_provisional_password,
      credential_notify_email,
      credential_notify_whatsapp,
      credential_portal_base_url,
      "approvedAt",
      "rejectedAt",
      "createdAt",
      "updatedAt"
  `);

  return rows[0];
}

async function create(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const data = normalizeAccessBody(req.body as Record<string, unknown>);
    if (!data.nome || !data.email) {
      res.status(400).json({ message: 'Nome e e-mail são obrigatórios' });
      return;
    }
    if (!data.warehouse_id) {
      res.status(400).json({ message: 'Imobiliária/warehouse é obrigatória' });
      return;
    }
    if (data.createAccess && !data.password) {
      res.status(400).json({ message: 'Informe a senha provisória para criar o acesso' });
      return;
    }
    let warehouse = await prisma.warehouse.findUnique({ where: { id: data.warehouse_id } });
    if (!warehouse) {
      const count = await prisma.warehouse.count();
      if (count === 0) {
        res.status(400).json({
          message:
            'Nenhuma imobiliária no banco. Rode no backend: npm run db:seed',
        });
        return;
      }
      if (count === 1) {
        warehouse = await prisma.warehouse.findFirst();
        if (warehouse) data.warehouse_id = warehouse.id;
      }
      if (!warehouse) {
        res.status(400).json({
          message:
            'Imobiliária não encontrada. Selecione a imobiliária no topo da página ou rode: npm run db:seed',
        });
        return;
      }
    }
    const nc = normalizeNotifyCredentialStorage(req.body as Record<string, unknown>);
    const row = await insertOwner(data, {
      forceOrigem: data.origem ?? undefined,
    }, nc);
    const notify = parseNotifyCredentials(req.body as Record<string, unknown>);
    let notifications: Awaited<ReturnType<typeof dispatchProprietarioCredentialNotifications>> | null =
      null;
    if (notify && data.password && data.createAccess) {
      try {
        notifications = await dispatchProprietarioCredentialNotifications({
          nome: data.nome,
          passwordPlain: data.password,
          accessEmail: String(data.access_email || data.email || ''),
          subdomain: String(data.subdomain || ''),
          notify,
        });
      } catch (e) {
        console.error('Erro ao enviar credenciais:', e);
      }
    }
    res.status(201).json({ ...formatProprietario(row), notifications });
  } catch (error) {
    console.error('Erro ao criar proprietário:', error);
    const message =
      error instanceof Error ? error.message : 'Erro ao criar proprietário';
    const isFk =
      message.includes('foreign key') ||
      message.includes('violates foreign key constraint');
    res.status(500).json({
      message: isFk
        ? 'Imobiliária não encontrada. Rode no backend: npm run db:seed'
        : 'Erro ao criar proprietário',
    });
  }
}

async function publicRegister(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const data = normalizeAccessBody(req.body as Record<string, unknown>);
    if (!data.nome || !data.email) {
      res.status(400).json({ message: 'Nome e e-mail são obrigatórios' });
      return;
    }
    if (!data.warehouse_id) {
      res.status(400).json({ message: 'Imobiliária/warehouse é obrigatória' });
      return;
    }
    const row = await insertOwner(data, { forceStatus: 'pending', forceOrigem: 'web' });
    res.status(201).json(formatProprietario(row));
  } catch (error) {
    console.error('Erro ao registrar proprietário web:', error);
    res.status(500).json({ message: 'Erro ao registrar proprietário' });
  }
}

async function update(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'ID do proprietário é obrigatório' });
      return;
    }
    const data = normalizeAccessBody(req.body as Record<string, unknown>);
    const currentRows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        id,
        status,
        origem,
        subdomain,
        access_email,
        password_hash,
        must_change_password
      FROM "Proprietario"
      WHERE id = ${id}
      LIMIT 1
    `);
    if (!currentRows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    const current = currentRows[0];
    const hasExistingPassword = Boolean(current.password_hash);
    if (data.createAccess && !data.password && !hasExistingPassword) {
      res.status(400).json({ message: 'Informe a senha provisória para criar o acesso' });
      return;
    }
    const passwordHash = data.password ? await bcrypt.hash(data.password, 10) : null;
    const nextStatus = resolveUpdatedStatus(current, data.status);
    const nextOrigem = data.origem ? normalizeOrigem(data.origem, String(current.origem ?? 'erp')) : String(current.origem ?? 'erp');
    const wantsAccessUpdate =
      data.createAccess || Boolean(passwordHash) || data.subdomain !== null || data.access_email !== null;
    const nextSubdomain = wantsAccessUpdate
      ? (data.subdomain ?? current.subdomain ?? slugify(data.nome))
      : (current.subdomain ?? null);
    const nextAccessEmail = wantsAccessUpdate
      ? (data.access_email ?? current.access_email ?? data.email ?? null)
      : (current.access_email ?? null);
    const nextMustChange = wantsAccessUpdate
      ? (typeof data.must_change_password === 'boolean'
        ? data.must_change_password
        : Boolean(passwordHash || current.must_change_password))
      : Boolean(current.must_change_password);
    const setParts = [
      Prisma.sql`nome = ${data.nome}`,
      Prisma.sql`email = ${data.email}`,
      Prisma.sql`telefone = ${data.telefone}`,
      Prisma.sql`tipo_documento = ${data.tipo_documento}`,
      Prisma.sql`cpf_cnpj = ${data.cpf_cnpj}`,
      Prisma.sql`cep = ${data.cep}`,
      Prisma.sql`endereco = ${data.endereco}`,
      Prisma.sql`numero = ${data.numero}`,
      Prisma.sql`complemento = ${data.complemento}`,
      Prisma.sql`bairro = ${data.bairro}`,
      Prisma.sql`cidade = ${data.cidade}`,
      Prisma.sql`estado = ${data.estado}`,
      Prisma.sql`observacoes = ${data.observacoes}`,
      Prisma.sql`warehouse_id = ${data.warehouse_id}`,
      Prisma.sql`status = ${nextStatus}`,
      Prisma.sql`origem = ${nextOrigem}`,
      Prisma.sql`subdomain = ${nextSubdomain}`,
      Prisma.sql`access_email = ${nextAccessEmail}`,
      Prisma.sql`must_change_password = ${nextMustChange}`,
      Prisma.sql`"updatedAt" = NOW()`,
    ];
    if (passwordHash) {
      setParts.splice(
        18,
        0,
        Prisma.sql`password_hash = ${passwordHash}`,
        Prisma.sql`last_provisional_password = ${data.password}`,
      );
    }
    const nc = normalizeNotifyCredentialStorage(req.body as Record<string, unknown>);
    if (data.createAccess) {
      setParts.splice(
        setParts.length - 1,
        0,
        Prisma.sql`credential_notify_email = ${nc.email_to}`,
        Prisma.sql`credential_notify_whatsapp = ${nc.whatsapp_phone}`,
        Prisma.sql`credential_portal_base_url = ${nc.portal_base_url}`,
      );
    }
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      UPDATE "Proprietario"
      SET ${Prisma.join(setParts, ', ')}
      WHERE id = ${id}
      RETURNING
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        foto_url,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        last_provisional_password,
        credential_notify_email,
        credential_notify_whatsapp,
        credential_portal_base_url,
        must_change_password,
        password_hash,
      "approvedAt",
      "rejectedAt",
        "createdAt",
        "updatedAt"
    `);
    const saved = formatProprietario(rows[0]);
    const notify = parseNotifyCredentials(req.body as Record<string, unknown>);
    let notifications: Awaited<ReturnType<typeof dispatchProprietarioCredentialNotifications>> | null =
      null;
    const plainForNotify = data.password
      ? data.password
      : null;
    if (notify && data.createAccess && plainForNotify) {
      try {
        notifications = await dispatchProprietarioCredentialNotifications({
          nome: data.nome,
          passwordPlain: plainForNotify,
          accessEmail: String(
            data.access_email ?? saved.access_email ?? data.email ?? saved.email ?? '',
          ),
          subdomain: String(data.subdomain ?? saved.subdomain ?? ''),
          notify,
        });
      } catch (e) {
        console.error('Erro ao enviar credenciais:', e);
      }
    }
    res.json({ ...saved, notifications });
  } catch (error) {
    console.error('Erro ao atualizar proprietário:', error);
    res.status(500).json({ message: 'Erro ao atualizar proprietário' });
  }
}

async function approve(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      UPDATE "Proprietario"
      SET
        status = 'active',
        "approvedAt" = NOW(),
        "rejectedAt" = NULL,
        "updatedAt" = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        foto_url,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        must_change_password,
        password_hash,
      "approvedAt",
      "rejectedAt",
        "createdAt",
        "updatedAt"
    `);
    if (!rows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatProprietario(rows[0]));
  } catch (error) {
    console.error('Erro ao aprovar proprietário:', error);
    res.status(500).json({ message: 'Erro ao aprovar proprietário' });
  }
}

async function reject(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      UPDATE "Proprietario"
      SET
        status = 'rejected',
        "rejectedAt" = NOW(),
        "approvedAt" = NULL,
        "updatedAt" = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        foto_url,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        must_change_password,
        password_hash,
        "approvedAt",
        "rejectedAt",
        "createdAt",
        "updatedAt"
    `);
    if (!rows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatProprietario(rows[0]));
  } catch (error) {
    console.error('Erro ao rejeitar proprietário:', error);
    res.status(500).json({ message: 'Erro ao rejeitar proprietário' });
  }
}

async function activate(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      UPDATE "Proprietario"
      SET
        status = 'active',
        "approvedAt" = COALESCE("approvedAt", NOW()),
        "rejectedAt" = NULL,
        "updatedAt" = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        foto_url,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        must_change_password,
        password_hash,
        "approvedAt",
        "rejectedAt",
        "createdAt",
        "updatedAt"
    `);
    if (!rows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatProprietario(rows[0]));
  } catch (error) {
    console.error('Erro ao ativar proprietário:', error);
    res.status(500).json({ message: 'Erro ao ativar proprietário' });
  }
}

async function deactivate(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const { id } = req.params;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      UPDATE "Proprietario"
      SET
        status = 'inactive',
        "updatedAt" = NOW()
      WHERE id = ${id}
      RETURNING
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        foto_url,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        must_change_password,
        password_hash,
        "approvedAt",
        "rejectedAt",
        "createdAt",
        "updatedAt"
    `);
    if (!rows.length) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatProprietario(rows[0]));
  } catch (error) {
    console.error('Erro ao desativar proprietário:', error);
    res.status(500).json({ message: 'Erro ao desativar proprietário' });
  }
}

async function login(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'E-mail e senha são obrigatórios' });
      return;
    }
    const { email, password, subdomain } = parsed.data;
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT
        id,
        nome,
        email,
        telefone,
        tipo_documento,
        cpf_cnpj,
        cep,
        endereco,
        numero,
        complemento,
        bairro,
        cidade,
        estado,
        observacoes,
        warehouse_id,
        status,
        origem,
        subdomain,
        access_email,
        must_change_password,
        password_hash,
        foto_url,
        "approvedAt",
        "rejectedAt",
        "createdAt",
        "updatedAt"
      FROM "Proprietario"
      WHERE (LOWER(COALESCE(access_email, email)) = LOWER(${email}))
        ${subdomain ? Prisma.sql`AND subdomain = ${subdomain}` : Prisma.empty}
      LIMIT 1
    `);
    if (!rows.length) {
      res.status(401).json({ message: 'Acesso inválido' });
      return;
    }
    const owner = rows[0];
    if (String(owner.status ?? '') !== 'active') {
      res.status(403).json({ message: 'Acesso ainda não aprovado' });
      return;
    }
    const passwordHash = owner.password_hash ? String(owner.password_hash) : '';
    const valid = passwordHash ? await bcrypt.compare(password, passwordHash) : false;
    if (!valid) {
      res.status(401).json({ message: 'Acesso inválido' });
      return;
    }
    const jwtSecret = String(config.jwtSecret);
    const jwtExpiresIn = config.jwtExpiresIn as jwt.SignOptions['expiresIn'];
    const token = jwt.sign(
      { ownerId: String(owner.id), subdomain: owner.subdomain ?? undefined, type: 'owner' },
      jwtSecret,
      { expiresIn: jwtExpiresIn },
    );
    res.json({
      success: true,
      token,
      owner: formatProprietario(owner),
      mustChangePassword: Boolean(owner.must_change_password),
    });
  } catch (error) {
    console.error('Erro no login do proprietário:', error);
    res.status(500).json({ message: 'Erro no login do proprietário' });
  }
}

async function remove(req: import('express').Request, res: import('express').Response) {
  try {
    await ensureProprietarioSchema();
    const body = req.body as { rows?: string[] };
    const rows = Array.isArray(body.rows) ? body.rows.filter(Boolean) : [];
    if (!rows.length) {
      res.status(400).json({ message: 'Nenhum proprietário informado' });
      return;
    }
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "Proprietario"
      WHERE id IN (${Prisma.join(rows)})
    `);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao excluir proprietários:', error);
    res.status(500).json({ message: 'Erro ao excluir proprietários' });
  }
}

async function generateProvisionalPasswordRoute(
  _req: import('express').Request,
  res: import('express').Response,
) {
  try {
    await ensureProprietarioSchema();
    const password = await generateUniqueProvisionalPassword();
    res.json({ password });
  } catch (error) {
    console.error('Erro ao gerar senha provisória (fallback sem deduplicação no banco):', error);
    res.json({ password: generateProvisionalPassword() });
  }
}

router.post('/credentials/generate-password', generateProvisionalPasswordRoute);
router.post('/credentials/generate-password/', generateProvisionalPasswordRoute);
router.post('/auth/login', login);
router.post('/public/register', publicRegister);
router.get('/list', list);
router.get('/list/', list);
router.get('/get/:id', getById);
router.get('/get/:id/', getById);
router.post('/create', create);
router.post('/create/', create);
router.put('/update/:id', update);
router.put('/update/:id/', update);
router.patch('/approve/:id', approve);
router.patch('/approve/:id/', approve);
router.patch('/reject/:id', reject);
router.patch('/reject/:id/', reject);
router.patch('/activate/:id', activate);
router.patch('/activate/:id/', activate);
router.patch('/deactivate/:id', deactivate);
router.patch('/deactivate/:id/', deactivate);
router.post('/remove', remove);
router.post('/remove/', remove);

export default router;
