import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { buildGeoAddressKey, geocodeBrazilAddress } from '../lib/geocode.js';
import { resolvePropertyMediaPublicUrl } from '../lib/storage.js';

const router = Router();

/**
 * GET /api/properties - lista imóveis publicados (para o site).
 * Query: sectionId (opcional) - filtra por seção.
 */
router.get('/', async (req, res, next) => {
  try {
    const { sectionId } = req.query;
    const where: { status: string; sections?: { some: { sectionId: string } } } = {
      status: 'published',
    };
    if (typeof sectionId === 'string' && sectionId) {
      where.sections = { some: { sectionId } };
    }
    const list = await prisma.property.findMany({
      where,
      include: { media: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    const formatted = list.map((p) => {
      let tagImovel: string[] = [];
      if (p.tagImovel) {
        try {
          const arr = JSON.parse(p.tagImovel);
          tagImovel = Array.isArray(arr) ? arr.map(String) : [];
        } catch {
          tagImovel = [];
        }
      }
      const transactionTypes = parseJsonArray(p.transactionTypes);
      const priceVendaNum = p.priceVenda != null ? Number(p.priceVenda) : null;
      const priceAluguelNum = p.priceAluguel != null ? Number(p.priceAluguel) : null;
      const priceVenda = priceVendaNum != null && Number.isFinite(priceVendaNum) && priceVendaNum > 0 ? priceVendaNum : null;
      const priceAluguel = priceAluguelNum != null && Number.isFinite(priceAluguelNum) && priceAluguelNum > 0 ? priceAluguelNum : null;
      const price = p.price ? Number(p.price) : 0;
      return {
        id: p.id,
        slug: p.slug,
        title: p.title,
        description: p.description ?? '',
        price,
        priceVenda,
        priceAluguel,
        transactionTypes,
        bedrooms: p.bedrooms ?? 0,
        bathrooms: p.bathrooms ?? 0,
        area: p.area ? Number(p.area) : 0,
        type: (p.propertyType ?? 'apartamento') as string,
        address: {
          neighborhood: p.neighborhood ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          street: p.address ?? undefined,
          number: p.numero ?? undefined,
          zip: p.zip ?? undefined,
          lat: p.latitude ? Number(p.latitude) : undefined,
          lng: p.longitude ? Number(p.longitude) : undefined,
        },
        coverImage: p.media?.[0]
          ? {
              url: resolvePropertyMediaPublicUrl(p.media[0].url),
              alt: p.title,
              width: 1200,
              height: 800,
            }
          : { url: '', alt: p.title, width: 1200, height: 800 },
        images:
          p.media?.map((m) => ({
            url: resolvePropertyMediaPublicUrl(m.url),
            alt: p.title,
          })) ?? [],
        tagImovel,
        builder: p.builder ?? undefined,
      };
    });
    res.json(formatted);
  } catch (e) {
    next(e);
  }
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

/**
 * GET /api/properties/by-slug/:slug - um imóvel por slug (para a página do imóvel no site).
 * Retorna todos os campos do cadastro para exibir na página de detalhe.
 */
router.get('/by-slug/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const p = await prisma.property.findFirst({
      where: { slug, status: 'published' },
      include: { media: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!p) {
      res.status(404).json({ success: false, message: 'Imóvel não encontrado' });
      return;
    }
    const areaNum = p.area ? Number(p.area) : 0;
    const transactionTypes = parseJsonArray(p.transactionTypes);
    const priceVenda = p.priceVenda != null ? Number(p.priceVenda) : null;
    const priceAluguel = p.priceAluguel != null ? Number(p.priceAluguel) : null;
    const priceCrowdfunding = p.priceCrowdfunding != null ? Number(p.priceCrowdfunding) : null;

    let latOut = p.latitude != null ? Number(p.latitude) : undefined;
    let lngOut = p.longitude != null ? Number(p.longitude) : undefined;
    const hasCoords =
      latOut != null &&
      lngOut != null &&
      Number.isFinite(latOut) &&
      Number.isFinite(lngOut);

    const addrParts = {
      street: p.address,
      number: p.numero,
      neighborhood: p.neighborhood,
      city: p.city,
      state: p.state,
      zip: p.zip,
    };
    const currentKey = buildGeoAddressKey(addrParts);
    const canTryGeo = Boolean(p.city || p.state || p.address || p.numero);
    /** Sem coordenadas, ou endereço/número mudou desde a última geocodificação → recalcula o pin (inclui número no texto enviado ao Mapbox) */
    const needsGeo = canTryGeo && (!hasCoords || p.geoAddressKey !== currentKey);

    if (needsGeo) {
      const geo = await geocodeBrazilAddress(addrParts);
      if (geo) {
        latOut = geo.lat;
        lngOut = geo.lng;
        try {
          await prisma.property.update({
            where: { id: p.id },
            data: {
              latitude: new Prisma.Decimal(geo.lat),
              longitude: new Prisma.Decimal(geo.lng),
              geoAddressKey: currentKey,
            },
          });
        } catch {
          // ignora falha ao persistir; resposta já leva lat/lng
        }
      }
    }

    res.json({
      id: p.id,
      ref: p.ref ?? null,
      slug: p.slug,
      title: p.title,
      description: p.description ?? '',
      price: p.price ? Number(p.price) : 0,
      priceVenda,
      priceAluguel,
      priceCrowdfunding,
      transactionTypes,
      bedrooms: p.bedrooms ?? 0,
      bathrooms: p.bathrooms ?? 0,
      suites: p.suites ?? null,
      demiSuites: p.demiSuites ?? null,
      garage: p.garage ?? null,
      area: areaNum,
      type: (p.propertyType ?? 'apartamento') as string,
      address: {
        neighborhood: p.neighborhood ?? '',
        city: p.city ?? '',
        state: p.state ?? '',
        street: p.address ?? undefined,
        number: p.numero ?? undefined,
        zip: p.zip ?? undefined,
        lat: latOut,
        lng: lngOut,
      },
      coverImage: p.media?.[0]
        ? {
            url: resolvePropertyMediaPublicUrl(p.media[0].url),
            alt: p.title,
            width: 1200,
            height: 800,
          }
        : { url: '', alt: p.title, width: 1200, height: 800 },
      images:
        p.media?.map((m) => ({
          url: resolvePropertyMediaPublicUrl(m.url),
          alt: p.title,
        })) ?? [],
      comodidades: parseJsonArray(p.comodidades),
      builder: p.builder ?? undefined,
      mobiliado: p.mobiliado ?? false,
      aceita_pets: p.aceita_pets ?? false,
      aceita_permuta: p.aceita_permuta ?? false,
      em_construcao: p.em_construcao ?? false,
      parceria: p.parceria ?? false,
      dataPrevistaEntrega: p.dataPrevistaEntrega ? p.dataPrevistaEntrega.toISOString().slice(0, 10) : null,
      tagImovel: parseJsonArray(p.tagImovel),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
