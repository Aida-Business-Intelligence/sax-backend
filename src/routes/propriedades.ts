import multer from 'multer';
import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  getNextRef,
  lockWarehouseForRefAllocation,
  assertRefAvailableInWarehouse,
  buildPropertySlugBase,
} from '../lib/property-ref.js';
import { buildGeoAddressKey, geocodeBrazilAddress } from '../lib/geocode.js';
import { buildPropertyListWhere } from '../lib/property-list-filters.js';
import { uploadPublic, deleteObject, keyFromCdnUrl, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

const propertyImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.PROPERTY_IMAGE },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

export { getNextRef } from '../lib/property-ref.js';

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseTransactionTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function formatPropriedade(p: {
  id: string;
  ref: string | null;
  slug: string;
  title: string;
  description: string | null;
  type: string;
  transactionTypes?: string | null;
  status: string;
  propertyType: string | null;
  price: Prisma.Decimal | null;
  priceVenda?: Prisma.Decimal | null;
  priceAluguel?: Prisma.Decimal | null;
  priceCrowdfunding?: Prisma.Decimal | null;
  area: Prisma.Decimal | null;
  bedrooms: number | null;
  suites?: number | null;
  demiSuites?: number | null;
  bathrooms: number | null;
  garage: number | null;
  address: string | null;
  numero?: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  builder?: string | null;
  warehouseId: string;
  proprietarioId?: string | null;
  comodidades?: string | null;
  mobiliado?: boolean | null;
  aceita_pets?: boolean | null;
  aceita_permuta?: boolean | null;
  em_construcao?: boolean | null;
  parceria?: boolean | null;
  dataPrevistaEntrega?: Date | null;
  tagImovel?: string | null;
  latitude?: Prisma.Decimal | null;
  longitude?: Prisma.Decimal | null;
  ownerSubmissionStatus?: string | null;
}) {
  const tipoTransacao = parseTransactionTypes(p.transactionTypes);
  const types = tipoTransacao.length > 0 ? tipoTransacao : (p.type ? [p.type] : []);
  /** Valor exibido na lista: prioridade Venda → Locação → Crowdfunding → price legado */
  const mainPrice =
    p.priceVenda != null
      ? p.priceVenda
      : p.priceAluguel != null
        ? p.priceAluguel
        : p.priceCrowdfunding != null
          ? p.priceCrowdfunding
          : p.price ?? null;
  return {
    id: p.id,
    ref: p.ref ?? '',
    titulo: p.title,
    tipo_imovel: p.propertyType ?? '',
    tipo_imovel_nome: p.propertyType ?? '',
    tipo_transacao: types,
    status: p.status === 'published' ? 'ativo' : p.status === 'draft' ? 'ativo' : p.status,
    ativo: p.status === 'published' || p.status === 'draft',
    valor: mainPrice != null ? Number(mainPrice) : null,
    preco: mainPrice != null ? Number(mainPrice) : null,
    preco_venda: p.priceVenda != null ? Number(p.priceVenda) : null,
    preco_aluguel: p.priceAluguel != null ? Number(p.priceAluguel) : null,
    preco_crowdfunding: p.priceCrowdfunding != null ? Number(p.priceCrowdfunding) : null,
    area_m2: p.area != null ? Number(p.area) : null,
    area_total: p.area != null ? Number(p.area) : null,
    quartos: p.bedrooms ?? null,
    suites: p.suites ?? null,
    demi_suites: p.demiSuites ?? null,
    banheiros: p.bathrooms ?? null,
    vagas_garagem: p.garage ?? null,
    endereco: p.address ?? '',
    numero: p.numero ?? '',
    bairro: p.neighborhood ?? '',
    cidade: p.city ?? '',
    estado: p.state ?? '',
    cep: p.zip ?? '',
    descricao: p.description ?? '',
    construtora: p.builder ?? '',
    warehouse_id: p.warehouseId,
    proprietario: p.proprietarioId ?? null,
    comodidades: parseJsonArray(p.comodidades),
    mobiliado: p.mobiliado ?? false,
    aceita_pets: p.aceita_pets ?? false,
    aceita_permuta: p.aceita_permuta ?? false,
    em_construcao: p.em_construcao ?? false,
    parceria: p.parceria ?? false,
    data_prevista_entrega: p.dataPrevistaEntrega ? p.dataPrevistaEntrega.toISOString().slice(0, 10) : null,
    tag_imovel: parseJsonArray(p.tagImovel),
    latitude: p.latitude != null ? Number(p.latitude) : null,
    longitude: p.longitude != null ? Number(p.longitude) : null,
    owner_submission_status: p.ownerSubmissionStatus ?? null,
  };
}

/**
 * GET /api/propriedades/next-ref?warehouse_id=xxx - Retorna a próxima referência (ex: REF-00001) para exibir no formulário de nova propriedade.
 */
router.get('/next-ref', async (req, res, next) => {
  try {
    const warehouseId = (req.query.warehouse_id ?? req.query.warehouseId) as string | undefined;
    if (!warehouseId) {
      res.status(400).json({ message: 'warehouse_id é obrigatório' });
      return;
    }
    const ref = await getNextRef(warehouseId);
    res.json({ ref });
  } catch (e) {
    next(e);
  }
});

router.get('/next-ref/', (req, res, next) => {
  req.url = '/next-ref';
  (router as any).handle(req, res, next);
});

/**
 * POST /api/propriedades/list/ - Lista propriedades (body: warehouse_id, page, pageSize, search).
 */
router.post('/list', async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const warehouseId = body.warehouse_id ?? body.warehouseId;
    if (!warehouseId || typeof warehouseId !== 'string') {
      res.status(400).json({ message: 'warehouse_id é obrigatório' });
      return;
    }
    const page = Math.max(1, Number(body.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 25));

    const where = buildPropertyListWhere(
      { warehouseId },
      {
        search: typeof body.search === 'string' ? body.search : undefined,
        ref: typeof body.ref === 'string' ? body.ref : undefined,
        transactionType:
          typeof body.transactionType === 'string' ? body.transactionType : undefined,
        propertyType: typeof body.propertyType === 'string' ? body.propertyType : undefined,
        state: typeof body.state === 'string' ? body.state : undefined,
      },
    );

    const [list, total] = await Promise.all([
      prisma.property.findMany({
        where,
        orderBy: [{ ref: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.property.count({ where }),
    ]);

    const ownerIds = [...new Set(list.map((p) => p.proprietarioId).filter((id): id is string => Boolean(id)))];
    const owners =
      ownerIds.length > 0
        ? await prisma.proprietario.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, nome: true },
          })
        : [];
    const ownerNomeById = new Map(owners.map((o) => [o.id, o.nome]));

    res.json({
      data: list.map((p) => ({
        ...formatPropriedade(p),
        proprietario_nome: p.proprietarioId ? ownerNomeById.get(p.proprietarioId) ?? null : null,
      })),
      total,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/list/', (req, res, next) => {
  req.url = '/list';
  (router as any).handle(req, res, next);
});

/**
 * GET /api/propriedades/get/:id - Obtém uma propriedade para edição.
 */
async function getOne(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: 'ID é obrigatório' });
      return;
    }
    const p = await prisma.property.findUnique({
      where: { id },
      include: {
        sections: { select: { sectionId: true } },
        media: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!p) {
      res.status(404).json({ message: 'Propriedade não encontrada' });
      return;
    }
    const formatted = formatPropriedade(p) as Record<string, unknown>;
    formatted.section_ids = p.sections?.map((s) => s.sectionId) ?? [];
    formatted.media = (p.media ?? []).map((m) => ({ id: m.id, url: m.url, sortOrder: m.sortOrder }));
    formatted.anexos = (p.media ?? []).map((m) => m.url);
    formatted.imagem_capa_index = 0;
    res.json(formatted);
  } catch (e) {
    next(e);
  }
}

router.get('/get/:id', getOne);
router.get('/get/:id/', getOne);

/**
 * POST /api/propriedades/upload/:propertyId - Envia uma ou mais imagens para a propriedade.
 * Multipart/form-data com campo(s) "file". Cria PropertyMedia e faz upload para DO Spaces.
 */
router.post('/upload/:propertyId', propertyImageUpload.array('file', 20), async (req, res) => {
  try {
    const propertyId = req.params.propertyId;
    if (!propertyId) {
      res.status(400).json({ success: false, message: 'propertyId é obrigatório' });
      return;
    }
    const multerFiles = (req.files ?? []) as Express.Multer.File[];
    if (multerFiles.length === 0) {
      // Also accept field name "files[]"
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }
    const existing = await prisma.property.findUnique({ where: { id: propertyId }, include: { media: true } });
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

/**
 * POST /api/propriedades/create/ - Cria propriedade. Gera ref automaticamente se não informado.
 */
router.post('/create', async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const warehouseId = (body.warehouse_id ?? body.warehouseId) as string | undefined;
    if (!warehouseId) {
      res.status(400).json({ message: 'warehouse_id é obrigatório' });
      return;
    }

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
            status: (body.status as string) === 'inativo' ? 'archived' : 'published',
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
            clientId: (body.clientId as string) || null,
            proprietarioId: (body.proprietario as string) || null,
            comodidades: Array.isArray(body.comodidades) ? JSON.stringify(body.comodidades) : (typeof body.comodidades === 'string' ? body.comodidades : null),
            mobiliado: body.mobiliado === true || body.mobiliado === '1',
            aceita_pets: body.aceita_pets === true || body.aceita_pets === '1',
            aceita_permuta: body.aceita_permuta === true || body.aceita_permuta === '1',
            em_construcao: body.em_construcao === true || body.em_construcao === '1',
            parceria: body.parceria === true || body.parceria === '1',
            dataPrevistaEntrega: body.data_prevista_entrega != null && String(body.data_prevista_entrega).trim() !== '' ? new Date(body.data_prevista_entrega as string) : null,
            tagImovel: Array.isArray(body.tag_imovel) ? JSON.stringify(body.tag_imovel) : (typeof body.tag_imovel === 'string' ? body.tag_imovel : null),
            ownerSubmissionStatus: null,
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
      const msg =
        target.some((t) => String(t).includes('ref'))
          ? 'Referência (REF) já em uso nesta imobiliária.'
          : 'Registro duplicado. Tente novamente.';
      res.status(409).json({ message: msg });
      return;
    }
    next(e);
  }
});

router.post('/create/', (req, res, next) => {
  req.url = '/create';
  (router as any).handle(req, res, next);
});

/**
 * PUT /api/propriedades/update/:id - Atualiza propriedade (ref não é alterado se já existir).
 */
router.put('/update/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    if (!id) {
      res.status(400).json({ message: 'ID é obrigatório' });
      return;
    }

    const existing = await prisma.property.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Propriedade não encontrada' });
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

    const nextStatus =
      body.status !== undefined
        ? (body.status as string) === 'inativo'
          ? 'archived'
          : 'published'
        : existing.status;

    let nextOwnerSubmissionStatus =
      body.owner_submission_status !== undefined
        ? body.owner_submission_status === null || body.owner_submission_status === ''
          ? null
          : String(body.owner_submission_status)
        : existing.ownerSubmissionStatus;
    if (
      body.owner_submission_status === undefined &&
      nextStatus === 'published' &&
      existing.ownerSubmissionStatus === 'pending'
    ) {
      nextOwnerSubmissionStatus = 'approved';
    }

    const norm = (s: unknown) => String(s ?? '').trim();
    const mergedAddr = {
      street: body.endereco !== undefined ? String(body.endereco) : existing.address,
      number: body.numero !== undefined ? (body.numero != null && String(body.numero).trim() !== '' ? String(body.numero).trim() : null) : existing.numero,
      neighborhood: body.bairro !== undefined ? String(body.bairro) : existing.neighborhood,
      city: body.cidade !== undefined ? String(body.cidade) : existing.city,
      state: body.estado !== undefined ? String(body.estado) : existing.state,
      zip: body.cep !== undefined ? String(body.cep) : existing.zip,
    };
    const addrChanged =
      (body.endereco !== undefined && norm(body.endereco) !== norm(existing.address)) ||
      (body.numero !== undefined && norm(body.numero) !== norm(existing.numero)) ||
      (body.bairro !== undefined && norm(body.bairro) !== norm(existing.neighborhood)) ||
      (body.cidade !== undefined && norm(body.cidade) !== norm(existing.city)) ||
      (body.estado !== undefined && norm(body.estado) !== norm(existing.state)) ||
      (body.cep !== undefined && norm(body.cep) !== norm(existing.zip));

    let nextLat: Prisma.Decimal | null = existing.latitude;
    let nextLng: Prisma.Decimal | null = existing.longitude;
    const bLat = body.latitude !== undefined && body.latitude !== '' ? Number(body.latitude) : NaN;
    const bLng = body.longitude !== undefined && body.longitude !== '' ? Number(body.longitude) : NaN;
    if (body.latitude !== undefined && body.longitude !== undefined && Number.isFinite(bLat) && Number.isFinite(bLng)) {
      nextLat = new Prisma.Decimal(bLat);
      nextLng = new Prisma.Decimal(bLng);
    } else if (existing.latitude == null || existing.longitude == null || addrChanged) {
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
        status: nextStatus,
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
        proprietarioId: body.proprietario !== undefined ? ((body.proprietario as string) || null) : existing.proprietarioId,
        comodidades: body.comodidades !== undefined ? (Array.isArray(body.comodidades) ? JSON.stringify(body.comodidades) : (typeof body.comodidades === 'string' ? body.comodidades : null)) : existing.comodidades,
        mobiliado: body.mobiliado !== undefined ? (body.mobiliado === true || body.mobiliado === '1') : existing.mobiliado,
        aceita_pets: body.aceita_pets !== undefined ? (body.aceita_pets === true || body.aceita_pets === '1') : existing.aceita_pets,
        aceita_permuta: body.aceita_permuta !== undefined ? (body.aceita_permuta === true || body.aceita_permuta === '1') : existing.aceita_permuta,
        em_construcao: body.em_construcao !== undefined ? (body.em_construcao === true || body.em_construcao === '1') : existing.em_construcao,
        parceria: body.parceria !== undefined ? (body.parceria === true || body.parceria === '1') : existing.parceria,
        dataPrevistaEntrega: body.data_prevista_entrega !== undefined ? (body.data_prevista_entrega != null && String(body.data_prevista_entrega).trim() !== '' ? new Date(body.data_prevista_entrega as string) : null) : existing.dataPrevistaEntrega,
        tagImovel: body.tag_imovel !== undefined ? (Array.isArray(body.tag_imovel) ? JSON.stringify(body.tag_imovel) : (typeof body.tag_imovel === 'string' ? body.tag_imovel : null)) : existing.tagImovel,
        ownerSubmissionStatus: nextOwnerSubmissionStatus,
      },
    });

    const sectionIds = (body.section_ids ?? body.exibir_nas_secoes) as string[] | undefined;
    if (Array.isArray(sectionIds)) {
      await prisma.propertySection.deleteMany({ where: { propertyId: id } });
      if (sectionIds.length > 0) {
        await prisma.propertySection.createMany({
          data: sectionIds.map((sectionId, i) => ({
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
      // Delete removed media objects from Space before clearing DB records
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
          return { propertyId: id, url: String(url).trim(), type: 'image', sortOrder };
        }).filter((row) => row.url.length > 0);
        if (toInsert.length > 0) {
          await prisma.propertyMedia.createMany({ data: toInsert });
        }
      }
    }

    const updated = await prisma.property.findUnique({ where: { id }, include: { media: { orderBy: { sortOrder: 'asc' } } } });
    const out = updated ? formatPropriedade(updated) as Record<string, unknown> : {};
    if (updated?.media) {
      (out as Record<string, unknown>).media = updated.media.map((m) => ({ id: m.id, url: m.url, sortOrder: m.sortOrder }));
      (out as Record<string, unknown>).anexos = updated.media.map((m) => m.url);
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.put('/update/:id/', (req, res, next) => {
  req.url = req.url.replace(/\/$/, '');
  (router as any).handle(req, res, next);
});

/**
 * POST /api/propriedades/remove/ - Remove propriedades (body: rows = array de ids, warehouse_id).
 */
router.post('/remove', async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const rows = body.rows as string[] | undefined;
    const ids = Array.isArray(rows) ? rows : [];
    const warehouseId = body.warehouse_id ?? body.warehouseId;
    if (ids.length === 0) {
      res.status(400).json({ message: 'Nenhum ID informado' });
      return;
    }

    // Delete media objects from Space before removing DB records
    const mediaToDelete = await prisma.propertyMedia.findMany({
      where: { propertyId: { in: ids } },
      select: { url: true },
    });
    await Promise.all(mediaToDelete.map((m) => deleteObject(keyFromCdnUrl(m.url))));

    await prisma.property.deleteMany({
      where: {
        id: { in: ids },
        ...(warehouseId ? { warehouseId: String(warehouseId) } : {}),
      },
    });
    res.json({ success: true, deleted: ids.length });
  } catch (e) {
    next(e);
  }
});

router.post('/remove/', (req, res, next) => {
  req.url = '/remove';
  (router as any).handle(req, res, next);
});

export default router;
