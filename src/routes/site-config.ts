import multer from 'multer';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { uploadPublic, deleteObject, keyFromCdnUrl, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

const siteAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.SITE_ASSET },
  fileFilter: (_req, file, cb) => {
    // Accept any image MIME; magic bytes are verified after upload
    cb(null, file.mimetype.startsWith('image/'));
  },
});

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function parseHeroContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

type PartnerLogo = { url: string; name?: string };

function parsePartnerLogos(raw: string | null | undefined): PartnerLogo[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((item): item is PartnerLogo => item != null && typeof item === 'object' && typeof (item as PartnerLogo).url === 'string').map((item) => ({
      url: (item as PartnerLogo).url,
      name: typeof (item as PartnerLogo).name === 'string' ? (item as PartnerLogo).name : undefined,
    }));
  } catch {
    return [];
  }
}

function parseAboutContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function parseFooterContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function parseExclusiveProjectsContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseImoveisContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseProprietariosContent(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type TransactionTypeOption = { value: string; label: string };

const DEFAULT_TRANSACTION_TYPES: TransactionTypeOption[] = [
  { value: 'venda', label: 'Venda' },
  { value: 'aluguel', label: 'Aluguel' },
  { value: 'crowdfunding', label: 'Crowdfunding' },
];

function parseTransactionTypes(raw: string | null | undefined): TransactionTypeOption[] {
  if (!raw || typeof raw !== 'string') return DEFAULT_TRANSACTION_TYPES;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_TRANSACTION_TYPES;
    return arr.filter((item): item is TransactionTypeOption => item != null && typeof item === 'object' && typeof (item as TransactionTypeOption).value === 'string').map((item) => ({
      value: String((item as TransactionTypeOption).value).trim(),
      label: typeof (item as TransactionTypeOption).label === 'string' ? String((item as TransactionTypeOption).label).trim() : String((item as TransactionTypeOption).value),
    })).filter((item) => item.value.length > 0);
  } catch {
    return DEFAULT_TRANSACTION_TYPES;
  }
}

function emptyResponse() {
  return {
    featuredPropertyIds: [] as string[],
    logoUrl: null as string | null,
    faviconUrl: null as string | null,
    menuItems: null as string | null,
    heroContent: null as Record<string, unknown> | null,
    partnerLogos: [] as PartnerLogo[],
    aboutContent: null as Record<string, unknown> | null,
    footerContent: null as Record<string, unknown> | null,
    transactionTypes: DEFAULT_TRANSACTION_TYPES,
    exclusiveProjectsContent: null as Record<string, unknown> | null,
    imoveisContent: null as Record<string, unknown> | null,
    proprietariosContent: null as Record<string, unknown> | null,
  };
}

/** Garante que o model SiteConfig existe (Prisma client gerado e tabela criada). */
function hasSiteConfig(): boolean {
  return typeof (prisma as unknown as { siteConfig?: unknown }).siteConfig !== 'undefined';
}

/**
 * GET /api/site-config - Configuração do site (público, usado pelo sax-site).
 * aboutContent é lido via raw query para garantir que a coluna seja retornada mesmo
 * se o cliente Prisma tiver sido gerado antes da coluna existir no schema.
 */
router.get('/', async (_req, res, next) => {
  try {
    if (!hasSiteConfig()) {
      res.json(emptyResponse());
      return;
    }
    const row = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    const featuredPropertyIds = parseJsonArray(row?.featuredPropertyIds ?? null);
    let aboutContentRaw: string | null | undefined = (row as { aboutContent?: string | null })?.aboutContent;
    if (aboutContentRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ aboutContent: string | null }]>`
        SELECT "aboutContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      aboutContentRaw = rawRows?.[0]?.aboutContent ?? null;
    }
    if (aboutContentRaw === undefined) aboutContentRaw = null;

    let footerContentRaw: string | null | undefined = (row as { footerContent?: string | null })?.footerContent;
    if (footerContentRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ footerContent: string | null }]>`
        SELECT "footerContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      footerContentRaw = rawRows?.[0]?.footerContent ?? null;
    }
    if (footerContentRaw === undefined) footerContentRaw = null;
    let transactionTypesRaw: string | null | undefined = (row as { transactionTypes?: string | null })?.transactionTypes;
    if (transactionTypesRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ transactionTypes: string | null }]>`
        SELECT "transactionTypes" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      transactionTypesRaw = rawRows?.[0]?.transactionTypes ?? null;
    }
    let exclusiveProjectsRaw: string | null | undefined = (row as { exclusiveProjectsContent?: string | null })
      ?.exclusiveProjectsContent;
    if (exclusiveProjectsRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ exclusiveProjectsContent: string | null }]>`
        SELECT "exclusiveProjectsContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      exclusiveProjectsRaw = rawRows?.[0]?.exclusiveProjectsContent ?? null;
    }
    if (exclusiveProjectsRaw === undefined) exclusiveProjectsRaw = null;

    let imoveisContentRaw: string | null | undefined = (row as { imoveisContent?: string | null })
      ?.imoveisContent;
    if (imoveisContentRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ imoveisContent: string | null }]>`
        SELECT "imoveisContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      imoveisContentRaw = rawRows?.[0]?.imoveisContent ?? null;
    }
    if (imoveisContentRaw === undefined) imoveisContentRaw = null;

    let proprietariosContentRaw: string | null | undefined = (row as { proprietariosContent?: string | null })
      ?.proprietariosContent;
    if (proprietariosContentRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ proprietariosContent: string | null }]>`
        SELECT "proprietariosContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      proprietariosContentRaw = rawRows?.[0]?.proprietariosContent ?? null;
    }
    if (proprietariosContentRaw === undefined) proprietariosContentRaw = null;

    res.json({
      featuredPropertyIds,
      logoUrl: row?.logoUrl ?? null,
      faviconUrl: row?.faviconUrl ?? null,
      menuItems: row?.menuItems ?? null,
      heroContent: parseHeroContent(row?.heroContent ?? null),
      partnerLogos: parsePartnerLogos((row as { partnerLogos?: string | null })?.partnerLogos ?? null),
      aboutContent: parseAboutContent(aboutContentRaw),
      footerContent: parseFooterContent(footerContentRaw),
      transactionTypes: parseTransactionTypes(transactionTypesRaw ?? null),
      exclusiveProjectsContent: parseExclusiveProjectsContent(exclusiveProjectsRaw),
      imoveisContent: parseImoveisContent(imoveisContentRaw),
      proprietariosContent: parseProprietariosContent(proprietariosContentRaw),
    });
  } catch (e) {
    console.error('[site-config GET]', e);
    res.status(200).json(emptyResponse());
  }
});

/**
 * PUT /api/site-config - Atualiza configuração (chamado pelo PDV).
 * Body: { featuredPropertyIds?: string[], logoUrl?: string, faviconUrl?: string, menuItems?: string, heroContent?: object }
 */
router.put('/', async (req, res, next) => {
  try {
    if (!hasSiteConfig()) {
      res.status(503).json({
        message:
          'Modelo SiteConfig não disponível. No backend execute: npx prisma generate e npx prisma db push, depois reinicie o servidor.',
      });
      return;
    }
    const body = req.body as {
      featuredPropertyIds?: string[];
      logoUrl?: string;
      faviconUrl?: string;
      menuItems?: string;
      heroContent?: Record<string, unknown> | null;
      partnerLogos?: PartnerLogo[] | null;
      aboutContent?: Record<string, unknown> | null;
      footerContent?: Record<string, unknown> | null;
      transactionTypes?: TransactionTypeOption[] | null;
      exclusiveProjectsContent?: Record<string, unknown> | null;
      imoveisContent?: Record<string, unknown> | null;
      proprietariosContent?: Record<string, unknown> | null;
    };
    const featuredPropertyIdsJson =
      body.featuredPropertyIds !== undefined
        ? (Array.isArray(body.featuredPropertyIds)
            ? JSON.stringify(body.featuredPropertyIds)
            : null)
        : undefined;
    const logoUrl =
      body.logoUrl !== undefined
        ? (body.logoUrl != null && String(body.logoUrl).trim() !== ''
            ? String(body.logoUrl).trim()
            : null)
        : undefined;
    const faviconUrl =
      body.faviconUrl !== undefined
        ? (body.faviconUrl != null && String(body.faviconUrl).trim() !== ''
            ? String(body.faviconUrl).trim()
            : null)
        : undefined;
    const menuItems =
      body.menuItems !== undefined
        ? (body.menuItems != null && String(body.menuItems).trim() !== ''
            ? String(body.menuItems)
            : null)
        : undefined;
    const heroContentJson =
      body.heroContent !== undefined
        ? (body.heroContent != null && typeof body.heroContent === 'object'
            ? JSON.stringify(body.heroContent)
            : null)
        : undefined;
    const partnerLogosJson =
      body.partnerLogos !== undefined
        ? (Array.isArray(body.partnerLogos)
            ? JSON.stringify(body.partnerLogos)
            : null)
        : undefined;
    const aboutContentJson =
      body.aboutContent !== undefined
        ? (body.aboutContent != null && typeof body.aboutContent === 'object'
            ? JSON.stringify(body.aboutContent)
            : null)
        : undefined;
    const footerContentJson =
      body.footerContent !== undefined
        ? (body.footerContent != null && typeof body.footerContent === 'object'
            ? JSON.stringify(body.footerContent)
            : null)
        : undefined;
    const transactionTypesJson =
      body.transactionTypes !== undefined
        ? (Array.isArray(body.transactionTypes) && body.transactionTypes.length > 0
            ? JSON.stringify(body.transactionTypes.filter((t) => t && typeof t.value === 'string'))
            : null)
        : undefined;
    const exclusiveProjectsContentJson =
      body.exclusiveProjectsContent !== undefined
        ? (body.exclusiveProjectsContent != null && typeof body.exclusiveProjectsContent === 'object'
            ? JSON.stringify(body.exclusiveProjectsContent)
            : null)
        : undefined;
    const imoveisContentJson =
      body.imoveisContent !== undefined
        ? (body.imoveisContent != null && typeof body.imoveisContent === 'object'
            ? JSON.stringify(body.imoveisContent)
            : null)
        : undefined;
    const proprietariosContentJson =
      body.proprietariosContent !== undefined
        ? (body.proprietariosContent != null && typeof body.proprietariosContent === 'object'
            ? JSON.stringify(body.proprietariosContent)
            : null)
        : undefined;

    const rowData = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    type SiteConfigRow = typeof rowData & {
      partnerLogos?: string | null;
      aboutContent?: string | null;
      footerContent?: string | null;
      transactionTypes?: string | null;
      exclusiveProjectsContent?: string | null;
      imoveisContent?: string | null;
      proprietariosContent?: string | null;
    };
    const prismaRaw = prisma as { $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };
    let row = rowData as SiteConfigRow | null;
    if (!row) {
      const createData: Record<string, unknown> = {
        featuredPropertyIds: featuredPropertyIdsJson ?? null,
        logoUrl: logoUrl ?? null,
        faviconUrl: faviconUrl ?? null,
        menuItems: menuItems ?? null,
        heroContent: heroContentJson ?? null,
      };
      row = (await prisma.siteConfig.create({ data: createData as never })) as SiteConfigRow;
      if (partnerLogosJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "partnerLogos" = ${partnerLogosJson} WHERE id = ${row.id}`;
      }
      if (aboutContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "aboutContent" = ${aboutContentJson} WHERE id = ${row.id}`;
      }
      if (footerContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "footerContent" = ${footerContentJson} WHERE id = ${row.id}`;
      }
      if (transactionTypesJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "transactionTypes" = ${transactionTypesJson} WHERE id = ${row.id}`;
      }
      if (exclusiveProjectsContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "exclusiveProjectsContent" = ${exclusiveProjectsContentJson} WHERE id = ${row.id}`;
      }
      if (imoveisContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "imoveisContent" = ${imoveisContentJson} WHERE id = ${row.id}`;
      }
      if (proprietariosContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "proprietariosContent" = ${proprietariosContentJson} WHERE id = ${row.id}`;
      }
    } else {
      const data: Record<string, unknown> = {};
      if (featuredPropertyIdsJson !== undefined) data.featuredPropertyIds = featuredPropertyIdsJson;
      if (logoUrl !== undefined) data.logoUrl = logoUrl;
      if (faviconUrl !== undefined) data.faviconUrl = faviconUrl;
      if (menuItems !== undefined) data.menuItems = menuItems;
      if (heroContentJson !== undefined) data.heroContent = heroContentJson;
      row = (await prisma.siteConfig.update({
        where: { id: row.id },
        data: data as never,
      })) as SiteConfigRow;
      if (partnerLogosJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "partnerLogos" = ${partnerLogosJson} WHERE id = ${row.id}`;
      }
      if (aboutContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "aboutContent" = ${aboutContentJson} WHERE id = ${row.id}`;
      }
      if (footerContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "footerContent" = ${footerContentJson} WHERE id = ${row.id}`;
      }
      if (transactionTypesJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "transactionTypes" = ${transactionTypesJson} WHERE id = ${row.id}`;
      }
      if (exclusiveProjectsContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "exclusiveProjectsContent" = ${exclusiveProjectsContentJson} WHERE id = ${row.id}`;
      }
      if (imoveisContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "imoveisContent" = ${imoveisContentJson} WHERE id = ${row.id}`;
      }
      if (proprietariosContentJson !== undefined) {
        await prismaRaw.$executeRaw`UPDATE "SiteConfig" SET "proprietariosContent" = ${proprietariosContentJson} WHERE id = ${row.id}`;
      }
    }
    let outFooterContentRaw: string | null = (row as { footerContent?: string | null })?.footerContent ?? null;
    if (outFooterContentRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ footerContent: string | null }]>`
        SELECT "footerContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      outFooterContentRaw = rawRows?.[0]?.footerContent ?? null;
    }
    const outFeatured = parseJsonArray(row.featuredPropertyIds);
    const outPartnerLogos = parsePartnerLogos(partnerLogosJson !== undefined ? partnerLogosJson : (row.partnerLogos ?? null));
    const outAboutContent = parseAboutContent(aboutContentJson !== undefined ? aboutContentJson : (row.aboutContent ?? null));
    let outTransactionTypesRaw: string | null | undefined = (row as { transactionTypes?: string | null }).transactionTypes;
    if (outTransactionTypesRaw === undefined && row?.id && transactionTypesJson !== undefined) {
      outTransactionTypesRaw = transactionTypesJson;
    } else if (outTransactionTypesRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ transactionTypes: string | null }]>`
        SELECT "transactionTypes" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      outTransactionTypesRaw = rawRows?.[0]?.transactionTypes ?? null;
    }
    let outExclusiveRaw: string | null | undefined = (row as SiteConfigRow).exclusiveProjectsContent;
    if (exclusiveProjectsContentJson !== undefined) {
      outExclusiveRaw = exclusiveProjectsContentJson;
    } else if (outExclusiveRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ exclusiveProjectsContent: string | null }]>`
        SELECT "exclusiveProjectsContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      outExclusiveRaw = rawRows?.[0]?.exclusiveProjectsContent ?? null;
    }
    if (outExclusiveRaw === undefined) outExclusiveRaw = null;

    let outImoveisRaw: string | null | undefined = (row as SiteConfigRow).imoveisContent;
    if (imoveisContentJson !== undefined) {
      outImoveisRaw = imoveisContentJson;
    } else if (outImoveisRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ imoveisContent: string | null }]>`
        SELECT "imoveisContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      outImoveisRaw = rawRows?.[0]?.imoveisContent ?? null;
    }
    if (outImoveisRaw === undefined) outImoveisRaw = null;

    let outProprietariosRaw: string | null | undefined = (row as SiteConfigRow).proprietariosContent;
    if (proprietariosContentJson !== undefined) {
      outProprietariosRaw = proprietariosContentJson;
    } else if (outProprietariosRaw === undefined && row?.id) {
      const rawRows = await prisma.$queryRaw<[{ proprietariosContent: string | null }]>`
        SELECT "proprietariosContent" FROM "SiteConfig" WHERE id = ${row.id} LIMIT 1
      `;
      outProprietariosRaw = rawRows?.[0]?.proprietariosContent ?? null;
    }
    if (outProprietariosRaw === undefined) outProprietariosRaw = null;

    res.json({
      featuredPropertyIds: outFeatured,
      logoUrl: row.logoUrl ?? null,
      faviconUrl: row.faviconUrl ?? null,
      menuItems: row.menuItems ?? null,
      heroContent: parseHeroContent(row.heroContent),
      partnerLogos: outPartnerLogos,
      aboutContent: outAboutContent,
      footerContent: parseFooterContent(footerContentJson !== undefined ? footerContentJson : outFooterContentRaw),
      transactionTypes: parseTransactionTypes(outTransactionTypesRaw ?? null),
      exclusiveProjectsContent: parseExclusiveProjectsContent(outExclusiveRaw),
      imoveisContent: parseImoveisContent(outImoveisRaw),
      proprietariosContent: parseProprietariosContent(outProprietariosRaw),
    });
  } catch (e) {
    console.error('[site-config PUT]', e);
    next(e);
  }
});

/**
 * POST /api/site-config/upload-logo - Upload da logo do site (multipart/form-data, campo "file").
 * Faz upload para DO Spaces e retorna a URL CDN para gravar em site-config (logoUrl).
 */
router.post('/upload-logo', siteAssetUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }
    const validation = validateImage(req.file.buffer, SIZE.SITE_ASSET);
    if (!validation.ok) {
      res.status(400).json({ success: false, message: validation.error });
      return;
    }
    // Delete old logo from Space if one exists
    const current = hasSiteConfig() ? await prisma.siteConfig.findFirst({ select: { logoUrl: true } }) : null;
    await deleteObject(keyFromCdnUrl(current?.logoUrl));
    const ext = safeExtFromMime(validation.mime);
    const objectKey = keys.siteImage('logo', `${Date.now()}${ext}`);
    const logoUrl = await uploadPublic(objectKey, req.file.buffer, validation.mime);
    res.json({ success: true, logoUrl, message: 'Logo enviada com sucesso' });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

/**
 * POST /api/site-config/upload-favicon - Upload do favicon do site (multipart/form-data, campo "file").
 * Faz upload para DO Spaces e retorna a URL CDN para gravar em site-config (faviconUrl).
 */
router.post('/upload-favicon', siteAssetUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }
    // ICO files are not raster images so we allow them as a special case
    const validation = validateImage(req.file.buffer, SIZE.SITE_ASSET, /* allowIco */ true);
    if (!validation.ok) {
      res.status(400).json({ success: false, message: validation.error });
      return;
    }
    const current = hasSiteConfig() ? await prisma.siteConfig.findFirst({ select: { faviconUrl: true } }) : null;
    await deleteObject(keyFromCdnUrl(current?.faviconUrl));
    const ext = safeExtFromMime(validation.mime);
    const objectKey = keys.siteImage('favicon', `${Date.now()}${ext}`);
    const faviconUrl = await uploadPublic(objectKey, req.file.buffer, validation.mime);
    res.json({ success: true, faviconUrl, message: 'Favicon enviado com sucesso' });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

/**
 * POST /api/site-config/upload-partner-logo - Upload de logo de parceiro (multipart, campo "file").
 * Faz upload para DO Spaces e retorna { url }.
 */
router.post('/upload-partner-logo', siteAssetUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }
    const validation = validateImage(req.file.buffer, SIZE.SITE_ASSET);
    if (!validation.ok) {
      res.status(400).json({ success: false, message: validation.error });
      return;
    }
    const ext = safeExtFromMime(validation.mime);
    const objectKey = keys.sitePartner(`${Date.now()}${ext}`);
    const url = await uploadPublic(objectKey, req.file.buffer, validation.mime);
    res.json({ success: true, url, message: 'Logo do parceiro enviada' });
  } catch (e) {
    res.status(500).json({ success: false, message: (e as Error).message });
  }
});

export default router;
