import path from 'path';
import fs from 'fs';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();
const UPLOAD_SITE_DIR = path.join(process.cwd(), 'uploads', 'site');

/** Divide um Buffer pelo delimitador (Buffer não tem .split() nativo). */
function bufferSplit(buf: Buffer, delim: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(delim, start);
    if (idx === -1) {
      if (start < buf.length) result.push(buf.subarray(start));
      break;
    }
    if (idx > start) result.push(buf.subarray(start, idx));
    start = idx + delim.length;
  }
  return result.filter((p) => p.length > 0 && !p.toString().endsWith('--\r\n'));
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_SITE_DIR)) {
    fs.mkdirSync(UPLOAD_SITE_DIR, { recursive: true });
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
    res.json({
      featuredPropertyIds,
      logoUrl: row?.logoUrl ?? null,
      faviconUrl: row?.faviconUrl ?? null,
      menuItems: row?.menuItems ?? null,
      heroContent: parseHeroContent(row?.heroContent ?? null),
      partnerLogos: parsePartnerLogos((row as { partnerLogos?: string | null })?.partnerLogos ?? null),
      aboutContent: parseAboutContent(aboutContentRaw),
      footerContent: parseFooterContent(footerContentRaw),
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

    const rowData = await prisma.siteConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    type SiteConfigRow = typeof rowData & { partnerLogos?: string | null; aboutContent?: string | null; footerContent?: string | null };
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
    res.json({
      featuredPropertyIds: outFeatured,
      logoUrl: row.logoUrl ?? null,
      faviconUrl: row.faviconUrl ?? null,
      menuItems: row.menuItems ?? null,
      heroContent: parseHeroContent(row.heroContent),
      partnerLogos: outPartnerLogos,
      aboutContent: outAboutContent,
      footerContent: parseFooterContent(footerContentJson !== undefined ? footerContentJson : outFooterContentRaw),
    });
  } catch (e) {
    console.error('[site-config PUT]', e);
    next(e);
  }
});

/**
 * POST /api/site-config/upload-logo - Upload da logo do site (multipart/form-data, campo "file").
 * Salva em uploads/site/ e retorna a URL para gravar em site-config (logoUrl).
 */
router.post('/upload-logo', (req: Request, res: Response) => {
  if (!req.is('multipart/form-data')) {
    res.status(400).json({ success: false, message: 'Content-Type deve ser multipart/form-data' });
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.split('boundary=')[1]?.trim().replace(/^["']|["']$/g, '');
    const boundary = boundaryMatch ?? '';

    if (!boundary) {
      res.status(400).json({ success: false, message: 'Boundary não encontrado' });
      return;
    }

    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = bufferSplit(buffer, boundaryBuf);
    let fileBuffer: Buffer | null = null;
    let filename = '';

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.subarray(0, headerEnd).toString();
      const body = part.subarray(headerEnd + 4);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);
      if (nameMatch && nameMatch[1] === 'file' && fileMatch) {
        filename = fileMatch[1];
        fileBuffer = body.subarray(0, body.length - 2);
        break;
      }
    }

    if (!fileBuffer || !filename) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }

    const ext = path.extname(filename) || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];
    if (!allowed.includes(ext.toLowerCase())) {
      res.status(400).json({ success: false, message: 'Tipo de arquivo não permitido. Use: png, jpg, jpeg, svg, gif ou webp.' });
      return;
    }

    ensureUploadDir();
    const safeName = `logo${ext}`;
    const filePath = path.join(UPLOAD_SITE_DIR, safeName);
    fs.writeFileSync(filePath, fileBuffer);

    const logoUrl = `/uploads/site/${safeName}`;
    res.json({ success: true, logoUrl, message: 'Logo enviada com sucesso' });
  });
  req.on('error', () => {
    res.status(500).json({ success: false, message: 'Erro ao receber o arquivo' });
  });
});

/**
 * POST /api/site-config/upload-favicon - Upload do favicon do site (multipart/form-data, campo "file").
 * Salva em uploads/site/ e retorna a URL para gravar em site-config (faviconUrl).
 */
router.post('/upload-favicon', (req: Request, res: Response) => {
  if (!req.is('multipart/form-data')) {
    res.status(400).json({ success: false, message: 'Content-Type deve ser multipart/form-data' });
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.split('boundary=')[1]?.trim().replace(/^["']|["']$/g, '');
    const boundary = boundaryMatch ?? '';

    if (!boundary) {
      res.status(400).json({ success: false, message: 'Boundary não encontrado' });
      return;
    }

    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = bufferSplit(buffer, boundaryBuf);
    let fileBuffer: Buffer | null = null;
    let filename = '';

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.subarray(0, headerEnd).toString();
      const body = part.subarray(headerEnd + 4);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);
      if (nameMatch && nameMatch[1] === 'file' && fileMatch) {
        filename = fileMatch[1];
        fileBuffer = body.subarray(0, body.length - 2);
        break;
      }
    }

    if (!fileBuffer || !filename) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }

    const ext = path.extname(filename) || '.ico';
    const allowed = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico'];
    if (!allowed.includes(ext.toLowerCase())) {
      res.status(400).json({ success: false, message: 'Tipo de arquivo não permitido. Use: png, jpg, jpeg, svg, gif, webp ou ico.' });
      return;
    }

    ensureUploadDir();
    const safeName = `favicon${ext}`;
    const filePath = path.join(UPLOAD_SITE_DIR, safeName);
    fs.writeFileSync(filePath, fileBuffer);

    const faviconUrl = `/uploads/site/${safeName}`;
    res.json({ success: true, faviconUrl, message: 'Favicon enviado com sucesso' });
  });
  req.on('error', () => {
    res.status(500).json({ success: false, message: 'Erro ao receber o arquivo' });
  });
});

const UPLOAD_PARTNERS_DIR = path.join(process.cwd(), 'uploads', 'site', 'partners');

function ensurePartnersDir() {
  if (!fs.existsSync(UPLOAD_PARTNERS_DIR)) {
    fs.mkdirSync(UPLOAD_PARTNERS_DIR, { recursive: true });
  }
}

/**
 * POST /api/site-config/upload-partner-logo - Upload de logo de parceiro (multipart, campo "file").
 * Salva em uploads/site/partners/ com nome único e retorna { url }.
 */
router.post('/upload-partner-logo', (req: Request, res: Response) => {
  if (!req.is('multipart/form-data')) {
    res.status(400).json({ success: false, message: 'Content-Type deve ser multipart/form-data' });
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.split('boundary=')[1]?.trim().replace(/^["']|["']$/g, '');
    const boundary = boundaryMatch ?? '';

    if (!boundary) {
      res.status(400).json({ success: false, message: 'Boundary não encontrado' });
      return;
    }

    const boundaryBuf = Buffer.from(`--${boundary}`);
    const parts = bufferSplit(buffer, boundaryBuf);
    let fileBuffer: Buffer | null = null;
    let filename = '';

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.subarray(0, headerEnd).toString();
      const body = part.subarray(headerEnd + 4);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);
      if (nameMatch && nameMatch[1] === 'file' && fileMatch) {
        filename = fileMatch[1];
        fileBuffer = body.subarray(0, body.length - 2);
        break;
      }
    }

    if (!fileBuffer || !filename) {
      res.status(400).json({ success: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }

    const ext = path.extname(filename) || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];
    if (!allowed.includes(ext.toLowerCase())) {
      res.status(400).json({ success: false, message: 'Tipo não permitido. Use: png, jpg, jpeg, svg, gif ou webp.' });
      return;
    }

    ensurePartnersDir();
    const uniqueName = `partner-${Date.now()}${ext}`;
    const filePath = path.join(UPLOAD_PARTNERS_DIR, uniqueName);
    fs.writeFileSync(filePath, fileBuffer);

    const url = `/uploads/site/partners/${uniqueName}`;
    res.json({ success: true, url, message: 'Logo do parceiro enviada' });
  });
  req.on('error', () => {
    res.status(500).json({ success: false, message: 'Erro ao receber o arquivo' });
  });
});

export default router;
