import { randomUUID } from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ownerAuth, type OwnerRequest } from '../middleware/ownerAuth.js';
import {
  getNextRef,
  lockWarehouseForRefAllocation,
  assertRefAvailableInWarehouse,
  buildPropertySlugBase,
} from '../lib/property-ref.js';
import { formatPropriedade, slugify } from './propriedades.js';
import { buildGeoAddressKey, geocodeBrazilAddress } from '../lib/geocode.js';
import { buildPropertyListWhere } from '../lib/property-list-filters.js';
import { publicUploadUrl } from '../lib/public-asset-url.js';
import { attachHelpdeskOwnerRoutes } from './helpdesk-owner.js';
import {
  uploadPublic,
  deleteObject,
  keyFromCdnUrl,
  keys,
  resolvePropertyMediaPublicUrl,
} from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.AVATAR },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const propertyImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.PROPERTY_IMAGE },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

router.use(ownerAuth);

function ownerId(req: OwnerRequest) {
  return String(req.ownerId ?? '');
}

function parsePrivacyJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatOwnerMe(row: {
  id: string;
  nome: string;
  email: string | null;
  access_email: string | null;
  subdomain: string | null;
  telefone: string | null;
  tipo_documento: string | null;
  cpf_cnpj: string | null;
  cep: string | null;
  endereco: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  observacoes: string | null;
  fotoUrl: string | null;
  warehouse_id: string;
  must_change_password: boolean;
  privacyJson: string | null;
}) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    access_email: row.access_email,
    subdomain: row.subdomain,
    telefone: row.telefone,
    tipo_documento: row.tipo_documento,
    cpf_cnpj: row.cpf_cnpj,
    cep: row.cep,
    endereco: row.endereco,
    numero: row.numero,
    complemento: row.complemento,
    bairro: row.bairro,
    cidade: row.cidade,
    estado: row.estado,
    observacoes: row.observacoes,
    foto_url: publicUploadUrl(row.fotoUrl),
    warehouse_id: row.warehouse_id,
    must_change_password: row.must_change_password,
    privacy: parsePrivacyJson(row.privacyJson),
  };
}

/** GET /api/proprietarios/portal/me */
router.get('/me', async (req, res) => {
  try {
    const id = ownerId(req);
    const row = await prisma.proprietario.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    res.json(formatOwnerMe(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao carregar perfil' });
  }
});

router.get('/me/', (req, res, next) => {
  req.url = '/me';
  (router as any).handle(req, res, next);
});

/** PATCH /api/proprietarios/portal/me */
router.patch('/me', async (req, res) => {
  try {
    const id = ownerId(req);
    const body = req.body as Record<string, unknown>;
    const data: Prisma.ProprietarioUpdateInput = {};

    if (typeof body.nome === 'string') data.nome = body.nome.trim();
    if (typeof body.telefone === 'string') data.telefone = body.telefone.trim() || null;
    if (typeof body.tipo_documento === 'string') data.tipo_documento = body.tipo_documento.trim() || null;
    if (typeof body.cpf_cnpj === 'string') data.cpf_cnpj = body.cpf_cnpj.trim() || null;
    if (typeof body.cep === 'string') data.cep = body.cep.trim() || null;
    if (typeof body.endereco === 'string') data.endereco = body.endereco.trim() || null;
    if (typeof body.numero === 'string') data.numero = body.numero.trim() || null;
    if (typeof body.complemento === 'string') data.complemento = body.complemento.trim() || null;
    if (typeof body.bairro === 'string') data.bairro = body.bairro.trim() || null;
    if (typeof body.cidade === 'string') data.cidade = body.cidade.trim() || null;
    if (typeof body.estado === 'string') data.estado = body.estado.trim() || null;
    if (typeof body.observacoes === 'string') data.observacoes = body.observacoes.trim() || null;
    if (body.privacy !== undefined && body.privacy !== null && typeof body.privacy === 'object') {
      data.privacyJson = JSON.stringify(body.privacy);
    }

    const row = await prisma.proprietario.update({
      where: { id },
      data,
    });
    res.json(formatOwnerMe(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao atualizar perfil' });
  }
});

router.patch('/me/', (req, res, next) => {
  req.url = '/me';
  (router as any).handle(req, res, next);
});

/** POST /api/proprietarios/portal/me/avatar — multipart campo "file" (máx. 3 MB) */
router.post('/me/avatar', (req, res) => {
  avatarUpload.single('file')(req, res, async (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload inválido';
      res.status(400).json({ message: msg });
      return;
    }
    try {
      const id = ownerId(req as OwnerRequest);
      const file = (req as OwnerRequest & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ message: 'Envie um arquivo (campo file)' });
        return;
      }
      const validation = validateImage(file.buffer, SIZE.AVATAR);
      if (!validation.ok) {
        res.status(400).json({ message: validation.error });
        return;
      }
      const current = await prisma.proprietario.findUnique({ where: { id } });
      if (!current) {
        res.status(404).json({ message: 'Proprietário não encontrado' });
        return;
      }
      // Delete old avatar from Space if it exists
      await deleteObject(keyFromCdnUrl(current.fotoUrl));
      const ext = safeExtFromMime(validation.mime);
      const objectKey = keys.avatar(`${Date.now()}-${randomUUID()}${ext}`);
      const cdnUrl = await uploadPublic(objectKey, file.buffer, validation.mime);
      const row = await prisma.proprietario.update({
        where: { id },
        data: { fotoUrl: cdnUrl },
      });
      res.json(formatOwnerMe(row));
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: 'Erro ao salvar foto' });
    }
  });
});

/** DELETE /api/proprietarios/portal/me/avatar */
router.delete('/me/avatar', async (req, res) => {
  try {
    const id = ownerId(req);
    const current = await prisma.proprietario.findUnique({ where: { id } });
    if (!current) {
      res.status(404).json({ message: 'Proprietário não encontrado' });
      return;
    }
    await deleteObject(keyFromCdnUrl(current.fotoUrl));
    const row = await prisma.proprietario.update({
      where: { id },
      data: { fotoUrl: null },
    });
    res.json(formatOwnerMe(row));
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao remover foto' });
  }
});

/** PATCH /api/proprietarios/portal/me/password */
router.patch('/me/password', async (req, res) => {
  try {
    const id = ownerId(req);
    const body = req.body as { currentPassword?: string; newPassword?: string };
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (next.length < 6) {
      res.status(400).json({ message: 'A nova senha deve ter ao menos 6 caracteres' });
      return;
    }
    const row = await prisma.proprietario.findUnique({ where: { id } });
    if (!row?.password_hash) {
      res.status(400).json({ message: 'Senha atual não configurada' });
      return;
    }
    const ok = await bcrypt.compare(current, row.password_hash);
    if (!ok) {
      res.status(400).json({ message: 'Senha atual incorreta' });
      return;
    }
    const password_hash = await bcrypt.hash(next, 10);
    await prisma.proprietario.update({
      where: { id },
      data: { password_hash, must_change_password: false },
    });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao alterar senha' });
  }
});

router.patch('/me/password/', (req, res, next) => {
  req.url = '/me/password';
  (router as any).handle(req, res, next);
});

/** GET /api/proprietarios/portal/dashboard */
router.get('/dashboard', async (req, res) => {
  try {
    const oid = ownerId(req);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const props = await prisma.property.findMany({
      where: { proprietarioId: oid },
      select: { id: true, slug: true, status: true, ownerSubmissionStatus: true },
    });
    const slugs = props.map((p) => p.slug).filter(Boolean);
    let viewsLast30 = 0;
    if (slugs.length > 0) {
      const raw = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c
        FROM "SiteAnalyticsEvent" e
        WHERE e."eventType" = 'property_view'
          AND e."createdAt" >= ${since}
          AND e.payload IS NOT NULL
          AND (e.payload::jsonb->>'propertySlug') IN (${Prisma.join(slugs)})
      `;
      viewsLast30 = Number(raw[0]?.c ?? 0);
    }

    res.json({
      totalImoveis: props.length,
      pendentesAprovacao: props.filter((p) => p.ownerSubmissionStatus === 'pending').length,
      publicados: props.filter((p) => p.status === 'published').length,
      viewsUltimos30Dias: viewsLast30,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao carregar métricas' });
  }
});

router.get('/dashboard/', (req, res, next) => {
  req.url = '/dashboard';
  (router as any).handle(req, res, next);
});

/** GET /api/proprietarios/portal/reports?from=ISO&to=ISO */
router.get('/reports', async (req, res) => {
  try {
    const oid = ownerId(req);
    const q = req.query as { from?: string; to?: string };
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ message: 'Datas inválidas' });
      return;
    }

    const props = await prisma.property.findMany({
      where: { proprietarioId: oid },
      select: { id: true, slug: true },
    });
    const slugs = props.map((p) => p.slug);
    const ids = props.map((p) => p.id);

    const visits =
      slugs.length === 0
        ? []
        : await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
          SELECT DATE_TRUNC('day', e."createdAt") AS day, COUNT(*)::bigint AS count
          FROM "SiteAnalyticsEvent" e
          WHERE e."eventType" = 'property_view'
            AND e."createdAt" >= ${from}
            AND e."createdAt" <= ${to}
            AND e.payload IS NOT NULL
            AND (e.payload::jsonb->>'propertySlug') IN (${Prisma.join(slugs)})
          GROUP BY 1
          ORDER BY 1 ASC
        `;

    let leads: Array<{ day: Date; count: bigint }> = [];
    if (slugs.length > 0 || ids.length > 0) {
      const orParts: Prisma.Sql[] = [];
      if (slugs.length > 0) {
        orParts.push(Prisma.sql`(l.metadata::jsonb->>'propertySlug') IN (${Prisma.join(slugs)})`);
      }
      if (ids.length > 0) {
        orParts.push(Prisma.sql`(l.metadata::jsonb->>'propertyId') IN (${Prisma.join(ids)})`);
      }
      const orSql = orParts.length === 1 ? orParts[0]! : Prisma.sql`(${Prisma.join(orParts, ' OR ')})`;
      leads = await prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
        SELECT DATE_TRUNC('day', l."createdAt") AS day, COUNT(*)::bigint AS count
        FROM "SiteLead" l
        WHERE l."createdAt" >= ${from}
          AND l."createdAt" <= ${to}
          AND l.metadata IS NOT NULL
          AND (${orSql})
        GROUP BY 1
        ORDER BY 1 ASC
      `;
    }

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      visitsByDay: visits.map((r) => ({
        date: new Date(r.day).toISOString().slice(0, 10),
        count: Number(r.count),
      })),
      leadsByDay: leads.map((r) => ({
        date: new Date(r.day).toISOString().slice(0, 10),
        count: Number(r.count),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao carregar relatórios' });
  }
});

router.get('/reports/', (req, res, next) => {
  req.url = '/reports';
  (router as any).handle(req, res, next);
});

/** GET /api/proprietarios/portal/properties — query: search, ref, transactionType, propertyType, state */
router.get('/properties', async (req, res) => {
  try {
    const oid = ownerId(req);
    const q = req.query as Record<string, string | undefined>;
    const where = buildPropertyListWhere(
      { proprietarioId: oid },
      {
        search: q.search,
        ref: q.ref,
        transactionType: q.transactionType,
        propertyType: q.propertyType,
        state: q.state,
      },
    );
    const list = await prisma.property.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      include: {
        media: {
          orderBy: { sortOrder: 'asc' },
          take: 1,
          select: { url: true },
        },
      },
    });
    res.json({
      data: list.map((p) => ({
        ...formatPropriedade(p),
        foto_url: p.media?.[0]?.url ? resolvePropertyMediaPublicUrl(p.media[0].url) : null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao listar imóveis' });
  }
});

router.get('/properties/', (req, res, next) => {
  req.url = '/properties';
  (router as any).handle(req, res, next);
});

/**
 * POST /api/proprietarios/portal/properties/:propertyId/upload
 * Mesmo contrato de /api/propriedades/upload/:propertyId (multipart "file"), só para imóvel do proprietário logado.
 */
router.post('/properties/:propertyId/upload', propertyImageUpload.array('file', 20), async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    const oid = ownerId(req as OwnerRequest);
    if (!propertyId) {
      res.status(400).json({ success: false, message: 'propertyId é obrigatório' });
      return;
    }
    const multerFiles = (req.files ?? []) as Express.Multer.File[];
    if (multerFiles.length === 0) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }
    const existing = await prisma.property.findFirst({
      where: { id: propertyId, proprietarioId: oid },
      include: { media: true },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Propriedade não encontrada' });
      return;
    }
    const maxOrder = existing.media.length > 0
      ? Math.max(...existing.media.map((m) => m.sortOrder))
      : -1;
    const created: { id: string; url: string; sortOrder: number }[] = [];
    let sortOrder = maxOrder + 1;
    for (const file of multerFiles) {
      const validation = validateImage(file.buffer, SIZE.PROPERTY_IMAGE);
      if (!validation.ok) {
        res.status(400).json({ success: false, message: validation.error });
        return;
      }
      const ext = safeExtFromMime(validation.mime);
      const objectKey = keys.propertyImage(propertyId, `${Date.now()}-${sortOrder}${ext}`);
      const url = await uploadPublic(objectKey, file.buffer, validation.mime);
      const m = await prisma.propertyMedia.create({
        data: { propertyId, url, type: 'image', sortOrder },
      });
      created.push({ id: m.id, url: m.url, sortOrder: m.sortOrder });
      sortOrder += 1;
    }
    res.json({ success: true, media: created });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

/** GET /api/proprietarios/portal/properties/:id */
router.get('/properties/:id', async (req, res) => {
  try {
    const oid = ownerId(req);
    const id = req.params.id;
    const p = await prisma.property.findFirst({
      where: { id, proprietarioId: oid },
      include: {
        sections: { select: { sectionId: true } },
        media: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!p) {
      res.status(404).json({ message: 'Imóvel não encontrado' });
      return;
    }
    const formatted = formatPropriedade(p) as Record<string, unknown>;
    formatted.section_ids = p.sections?.map((s) => s.sectionId) ?? [];
    formatted.media = (p.media ?? []).map((m) => ({
      id: m.id,
      url: resolvePropertyMediaPublicUrl(m.url),
      sortOrder: m.sortOrder,
    }));
    formatted.anexos = (p.media ?? []).map((m) => resolvePropertyMediaPublicUrl(m.url));
    formatted.imagem_capa_index = 0;
    res.json(formatted);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao carregar imóvel' });
  }
});

/** DELETE /api/proprietarios/portal/properties/:id — apenas imóveis do proprietário logado */
router.delete('/properties/:id', async (req, res) => {
  try {
    const oid = ownerId(req);
    const id = req.params.id;
    const existing = await prisma.property.findFirst({
      where: { id, proprietarioId: oid },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ message: 'Imóvel não encontrado' });
      return;
    }
    const mediaToDelete = await prisma.propertyMedia.findMany({
      where: { propertyId: id },
      select: { url: true },
    });
    await Promise.all(mediaToDelete.map((m) => deleteObject(keyFromCdnUrl(m.url))));
    await prisma.property.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao excluir imóvel' });
  }
});

router.delete('/properties/:id/', (req, res, next) => {
  req.url = req.url.replace(/\/$/, '');
  (router as any).handle(req, res, next);
});

/**
 * POST /api/proprietarios/portal/properties/remove
 * Body: { rows: string[] } — exclui vários imóveis do proprietário logado.
 */
router.post('/properties/remove', async (req, res) => {
  try {
    const oid = ownerId(req);
    const body = req.body as Record<string, unknown>;
    const rows = body.rows as string[] | undefined;
    const ids = Array.isArray(rows) ? rows.filter((x) => typeof x === 'string' && x.length > 0) : [];
    if (ids.length === 0) {
      res.status(400).json({ message: 'Nenhum ID informado' });
      return;
    }
    const mediaToDelete = await prisma.propertyMedia.findMany({
      where: { propertyId: { in: ids }, property: { proprietarioId: oid } },
      select: { url: true },
    });
    await Promise.all(mediaToDelete.map((m) => deleteObject(keyFromCdnUrl(m.url))));
    const result = await prisma.property.deleteMany({
      where: {
        id: { in: ids },
        proprietarioId: oid,
      },
    });
    res.json({ success: true, deleted: result.count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Erro ao excluir imóveis' });
  }
});

router.post('/properties/remove/', (req, res, next) => {
  req.url = '/properties/remove';
  (router as any).handle(req, res, next);
});

/** POST /api/proprietarios/portal/properties — cria imóvel pendente de aprovação do master */
router.post('/properties', async (req, res, next) => {
  try {
    const oid = ownerId(req);
    const body = req.body as Record<string, unknown>;
    const propRow = await prisma.proprietario.findUnique({
      where: { id: oid },
      select: { warehouse_id: true },
    });
    if (!propRow?.warehouse_id) {
      res.status(400).json({ message: 'Loja não vinculada ao proprietário' });
      return;
    }
    const warehouseId = propRow.warehouse_id;

    const title = String(body.titulo ?? body.title ?? '').trim();
    if (!title) {
      res.status(400).json({ message: 'Título é obrigatório' });
      return;
    }

    const refFromBody =
      body.ref != null && String(body.ref).trim() !== '' ? String(body.ref).trim() : null;

    const tipoTransacao = body.tipo_transacao;
    const type = Array.isArray(tipoTransacao) && tipoTransacao.length > 0
      ? String(tipoTransacao[0])
      : (body.type as string) ?? 'venda';

    const tipoTransacaoArr = Array.isArray(body.tipo_transacao) ? body.tipo_transacao : [];
    const transactionTypesJson = tipoTransacaoArr.length > 0 ? JSON.stringify(tipoTransacaoArr) : null;
    const priceVenda = body.preco_venda != null && body.preco_venda !== '' ? new Prisma.Decimal(Number(body.preco_venda)) : null;
    const priceAluguel = body.preco_aluguel != null && body.preco_aluguel !== '' ? new Prisma.Decimal(Number(body.preco_aluguel)) : null;
    const priceCrowdfunding = body.preco_crowdfunding != null && body.preco_crowdfunding !== '' ? new Prisma.Decimal(Number(body.preco_crowdfunding)) : null;
    const mainPrice = priceVenda ?? priceAluguel ?? priceCrowdfunding ?? (body.preco != null && body.preco !== '' ? new Prisma.Decimal(Number(body.preco)) : null);

    const addrForGeo = {
      street: body.endereco != null ? String(body.endereco) : null,
      number: body.numero != null && String(body.numero).trim() !== '' ? String(body.numero).trim() : null,
      neighborhood: body.bairro != null ? String(body.bairro) : null,
      city: body.cidade != null ? String(body.cidade) : null,
      state: body.estado != null ? String(body.estado) : null,
      zip: body.cep != null ? String(body.cep) : null,
    };
    let latitude: Prisma.Decimal | null = null;
    let longitude: Prisma.Decimal | null = null;
    const bodyLat = body.latitude != null && body.latitude !== '' ? Number(body.latitude) : NaN;
    const bodyLng = body.longitude != null && body.longitude !== '' ? Number(body.longitude) : NaN;
    if (Number.isFinite(bodyLat) && Number.isFinite(bodyLng)) {
      latitude = new Prisma.Decimal(bodyLat);
      longitude = new Prisma.Decimal(bodyLng);
    } else {
      const geo = await geocodeBrazilAddress(addrForGeo);
      if (geo) {
        latitude = new Prisma.Decimal(geo.lat);
        longitude = new Prisma.Decimal(geo.lng);
      }
    }

    const sectionIds = (body.section_ids ?? body.exibir_nas_secoes) as string[] | undefined;

    const property = await prisma.$transaction(
      async (tx) => {
        await lockWarehouseForRefAllocation(tx, warehouseId);
        let ref: string;
        if (refFromBody) {
          await assertRefAvailableInWarehouse(tx, warehouseId, refFromBody);
          ref = refFromBody;
        } else {
          ref = await getNextRef(warehouseId, tx);
        }
        const slug = buildPropertySlugBase(title, slugify);

        const p = await tx.property.create({
          data: {
            ref,
            slug,
            title,
            description: body.descricao != null ? String(body.descricao) : null,
            type,
            transactionTypes: transactionTypesJson,
            status: 'draft',
            ownerSubmissionStatus: 'pending',
            propertyType: (body.tipo_imovel as string) || null,
            price: mainPrice,
            priceVenda,
            priceAluguel,
            priceCrowdfunding,
            area: body.area_total != null && body.area_total !== '' ? new Prisma.Decimal(Number(body.area_total)) : null,
            bedrooms: body.quartos != null && body.quartos !== '' ? Number(body.quartos) : null,
            suites: body.suites != null && body.suites !== '' ? Number(body.suites) : null,
            demiSuites: body.demi_suites != null && body.demi_suites !== '' ? Number(body.demi_suites) : null,
            bathrooms: body.banheiros != null && body.banheiros !== '' ? Number(body.banheiros) : null,
            garage: body.vagas_garagem != null && body.vagas_garagem !== '' ? Number(body.vagas_garagem) : null,
            address: body.endereco != null ? String(body.endereco) : null,
            numero: body.numero != null && String(body.numero).trim() !== '' ? String(body.numero).trim() : null,
            neighborhood: body.bairro != null ? String(body.bairro) : null,
            city: body.cidade != null ? String(body.cidade) : null,
            state: body.estado != null ? String(body.estado) : null,
            zip: body.cep != null ? String(body.cep) : null,
            latitude,
            longitude,
            geoAddressKey: buildGeoAddressKey(addrForGeo),
            builder: body.construtora != null && String(body.construtora).trim() !== '' ? String(body.construtora).trim() : null,
            warehouseId,
            proprietarioId: oid,
            comodidades: Array.isArray(body.comodidades) ? JSON.stringify(body.comodidades) : (typeof body.comodidades === 'string' ? body.comodidades : null),
            mobiliado: body.mobiliado === true || body.mobiliado === '1',
            aceita_pets: body.aceita_pets === true || body.aceita_pets === '1',
            aceita_permuta: body.aceita_permuta === true || body.aceita_permuta === '1',
            em_construcao: body.em_construcao === true || body.em_construcao === '1',
            parceria: body.parceria === true || body.parceria === '1',
            dataPrevistaEntrega: body.data_prevista_entrega != null && String(body.data_prevista_entrega).trim() !== '' ? new Date(body.data_prevista_entrega as string) : null,
            tagImovel: Array.isArray(body.tag_imovel) ? JSON.stringify(body.tag_imovel) : (typeof body.tag_imovel === 'string' ? body.tag_imovel : null),
          },
        });

        if (Array.isArray(sectionIds) && sectionIds.length > 0) {
          await tx.propertySection.createMany({
            data: sectionIds.map((sectionId, i) => ({
              propertyId: p.id,
              sectionId: String(sectionId),
              sortOrder: i,
            })),
            skipDuplicates: true,
          });
        }
        return p;
      },
      { maxWait: 15000, timeout: 60000 },
    );

    res.status(201).json(formatPropriedade(property));
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    if (err.statusCode === 409) {
      res.status(409).json({ message: err.message });
      return;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = (e.meta?.target as string[]) ?? [];
      const msg = target.some((t) => String(t).includes('ref'))
        ? 'Referência (REF) já em uso nesta imobiliária.'
        : 'Registro duplicado. Tente novamente.';
      res.status(409).json({ message: msg });
      return;
    }
    next(e);
  }
});

router.post('/properties/', (req, res, next) => {
  req.url = '/properties';
  (router as any).handle(req, res, next);
});

/** PUT /api/proprietarios/portal/properties/:id */
router.put('/properties/:id', async (req, res, next) => {
  try {
    const oid = ownerId(req);
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;

    const existing = await prisma.property.findFirst({ where: { id, proprietarioId: oid } });
    if (!existing) {
      res.status(404).json({ message: 'Imóvel não encontrado' });
      return;
    }

    if (existing.ownerSubmissionStatus === 'approved' && existing.status === 'published') {
      res.status(403).json({
        message: 'Imóvel já publicado. Solicite alterações pela imobiliária.',
      });
      return;
    }

    const title = body.titulo ?? body.title ?? existing.title;
    const tipoTransacao = body.tipo_transacao;
    const type = Array.isArray(tipoTransacao) && tipoTransacao.length > 0
      ? String(tipoTransacao[0])
      : (body.type as string) ?? existing.type;
    const transactionTypesJson = Array.isArray(tipoTransacao) && tipoTransacao.length > 0
      ? JSON.stringify(tipoTransacao)
      : existing.transactionTypes;

    const priceVenda = body.preco_venda !== undefined
      ? (body.preco_venda != null && body.preco_venda !== '' ? new Prisma.Decimal(Number(body.preco_venda)) : null)
      : existing.priceVenda;
    const priceAluguel = body.preco_aluguel !== undefined
      ? (body.preco_aluguel != null && body.preco_aluguel !== '' ? new Prisma.Decimal(Number(body.preco_aluguel)) : null)
      : existing.priceAluguel;
    const priceCrowdfunding = body.preco_crowdfunding !== undefined
      ? (body.preco_crowdfunding != null && body.preco_crowdfunding !== '' ? new Prisma.Decimal(Number(body.preco_crowdfunding)) : null)
      : existing.priceCrowdfunding;
    const mainPrice = priceVenda ?? priceAluguel ?? priceCrowdfunding ?? existing.price;

    const mergedAddr = {
      street: body.endereco !== undefined ? String(body.endereco) : existing.address,
      number: body.numero !== undefined ? (body.numero != null && String(body.numero).trim() !== '' ? String(body.numero).trim() : null) : existing.numero,
      neighborhood: body.bairro !== undefined ? String(body.bairro) : existing.neighborhood,
      city: body.cidade !== undefined ? String(body.cidade) : existing.city,
      state: body.estado !== undefined ? String(body.estado) : existing.state,
      zip: body.cep !== undefined ? String(body.cep) : existing.zip,
    };

    let nextLat: Prisma.Decimal | null = existing.latitude;
    let nextLng: Prisma.Decimal | null = existing.longitude;
    const bLat = body.latitude !== undefined && body.latitude !== '' ? Number(body.latitude) : NaN;
    const bLng = body.longitude !== undefined && body.longitude !== '' ? Number(body.longitude) : NaN;
    if (body.latitude !== undefined && body.longitude !== undefined && Number.isFinite(bLat) && Number.isFinite(bLng)) {
      nextLat = new Prisma.Decimal(bLat);
      nextLng = new Prisma.Decimal(bLng);
    } else {
      const geo = await geocodeBrazilAddress({
        street: mergedAddr.street,
        number: mergedAddr.number,
        neighborhood: mergedAddr.neighborhood,
        city: mergedAddr.city,
        state: mergedAddr.state,
        zip: mergedAddr.zip,
      });
      if (geo) {
        nextLat = new Prisma.Decimal(geo.lat);
        nextLng = new Prisma.Decimal(geo.lng);
      }
    }

    await prisma.property.update({
      where: { id },
      data: {
        title: String(title).trim() || existing.title,
        description: body.descricao !== undefined ? String(body.descricao) : existing.description,
        type,
        transactionTypes: transactionTypesJson,
        propertyType: body.tipo_imovel !== undefined ? (body.tipo_imovel as string) || null : existing.propertyType,
        price: mainPrice,
        priceVenda,
        priceAluguel,
        priceCrowdfunding,
        area: body.area_total != null && body.area_total !== '' ? new Prisma.Decimal(Number(body.area_total)) : existing.area,
        bedrooms: body.quartos !== undefined && body.quartos !== '' ? Number(body.quartos) : existing.bedrooms,
        suites: body.suites !== undefined ? (body.suites === '' ? null : Number(body.suites)) : existing.suites,
        demiSuites: body.demi_suites !== undefined ? (body.demi_suites === '' ? null : Number(body.demi_suites)) : existing.demiSuites,
        bathrooms: body.banheiros !== undefined && body.banheiros !== '' ? Number(body.banheiros) : existing.bathrooms,
        garage: body.vagas_garagem !== undefined && body.vagas_garagem !== '' ? Number(body.vagas_garagem) : existing.garage,
        address: body.endereco !== undefined ? String(body.endereco) : existing.address,
        numero:
          body.numero !== undefined
            ? body.numero != null && String(body.numero).trim() !== ''
              ? String(body.numero).trim()
              : null
            : existing.numero,
        neighborhood: body.bairro !== undefined ? String(body.bairro) : existing.neighborhood,
        city: body.cidade !== undefined ? String(body.cidade) : existing.city,
        state: body.estado !== undefined ? String(body.estado) : existing.state,
        zip: body.cep !== undefined ? String(body.cep) : existing.zip,
        latitude: nextLat,
        longitude: nextLng,
        geoAddressKey: buildGeoAddressKey({
          street: mergedAddr.street,
          number: mergedAddr.number,
          neighborhood: mergedAddr.neighborhood,
          city: mergedAddr.city,
          state: mergedAddr.state,
          zip: mergedAddr.zip,
        }),
        builder: body.construtora !== undefined ? (body.construtora != null && String(body.construtora).trim() !== '' ? String(body.construtora).trim() : null) : existing.builder,
        comodidades: body.comodidades !== undefined ? (Array.isArray(body.comodidades) ? JSON.stringify(body.comodidades) : (typeof body.comodidades === 'string' ? body.comodidades : null)) : existing.comodidades,
        mobiliado: body.mobiliado !== undefined ? (body.mobiliado === true || body.mobiliado === '1') : existing.mobiliado,
        aceita_pets: body.aceita_pets !== undefined ? (body.aceita_pets === true || body.aceita_pets === '1') : existing.aceita_pets,
        aceita_permuta: body.aceita_permuta !== undefined ? (body.aceita_permuta === true || body.aceita_permuta === '1') : existing.aceita_permuta,
        em_construcao: body.em_construcao !== undefined ? (body.em_construcao === true || body.em_construcao === '1') : existing.em_construcao,
        parceria: body.parceria !== undefined ? (body.parceria === true || body.parceria === '1') : existing.parceria,
        dataPrevistaEntrega: body.data_prevista_entrega !== undefined ? (body.data_prevista_entrega != null && String(body.data_prevista_entrega).trim() !== '' ? new Date(body.data_prevista_entrega as string) : null) : existing.dataPrevistaEntrega,
        tagImovel: body.tag_imovel !== undefined ? (Array.isArray(body.tag_imovel) ? JSON.stringify(body.tag_imovel) : (typeof body.tag_imovel === 'string' ? body.tag_imovel : null)) : existing.tagImovel,
        ownerSubmissionStatus: 'pending',
      },
    });

    const sectionIdsPut = (body.section_ids ?? body.exibir_nas_secoes) as string[] | undefined;
    if (Array.isArray(sectionIdsPut)) {
      await prisma.propertySection.deleteMany({ where: { propertyId: id } });
      if (sectionIdsPut.length > 0) {
        await prisma.propertySection.createMany({
          data: sectionIdsPut.map((sectionId, i) => ({
            propertyId: id,
            sectionId: String(sectionId),
            sortOrder: i,
          })),
          skipDuplicates: true,
        });
      }
    }

    const mediaList = body.media as Array<{ url: string; sortOrder?: number } | string> | undefined;
    if (Array.isArray(mediaList)) {
      const currentMedia = await prisma.propertyMedia.findMany({ where: { propertyId: id }, select: { url: true } });
      const newUrls = new Set(mediaList.map((item) => (typeof item === 'string' ? item : (item as { url: string }).url)));
      await Promise.all(
        currentMedia
          .filter((m) => !newUrls.has(m.url))
          .map((m) => deleteObject(keyFromCdnUrl(m.url)))
      );
      await prisma.propertyMedia.deleteMany({ where: { propertyId: id } });
      if (mediaList.length > 0) {
        const toInsert = mediaList.map((item, i) => {
          const url = typeof item === 'string' ? item : (item as { url: string }).url;
          const sortOrder = typeof item === 'object' && item != null && typeof (item as { sortOrder?: number }).sortOrder === 'number'
            ? (item as { sortOrder: number }).sortOrder
            : i;
          return {
            propertyId: id,
            url: resolvePropertyMediaPublicUrl(String(url).trim()),
            type: 'image',
            sortOrder,
          };
        }).filter((row) => row.url.length > 0);
        if (toInsert.length > 0) {
          await prisma.propertyMedia.createMany({ data: toInsert });
        }
      }
    }

    const updated = await prisma.property.findUnique({ where: { id }, include: { media: { orderBy: { sortOrder: 'asc' } } } });
    const out = updated ? formatPropriedade(updated) as Record<string, unknown> : {};
    if (updated?.media) {
      (out as Record<string, unknown>).media = updated.media.map((m) => ({
        id: m.id,
        url: resolvePropertyMediaPublicUrl(m.url),
        sortOrder: m.sortOrder,
      }));
      (out as Record<string, unknown>).anexos = updated.media.map((m) => resolvePropertyMediaPublicUrl(m.url));
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.put('/properties/:id/', (req, res, next) => {
  req.url = req.url.replace(/\/$/, '');
  (router as any).handle(req, res, next);
});

attachHelpdeskOwnerRoutes(router);

export default router;
