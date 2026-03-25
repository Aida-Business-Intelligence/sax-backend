/**
 * Geocodificação (Mapbox) para endereços de imóveis no Brasil.
 * Use MAPBOX_ACCESS_TOKEN ou MAPBOX_TOKEN no .env do sax-backend (mesmo token do site).
 */

export type AddressParts = {
  street?: string | null;
  /** Número do imóvel (ex.: 150, S/N) — compõe a linha de logradouro na geocodificação */
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

/** Chave estável para saber se o endereço (incl. número) mudou e o pin precisa ser recalculado */
export function buildGeoAddressKey(parts: AddressParts): string {
  const norm = (s: string | null | undefined) =>
    String(s ?? '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  return [
    norm(parts.street),
    norm(parts.number),
    norm(parts.neighborhood),
    norm(parts.city),
    norm(parts.state),
    norm(parts.zip),
  ].join('|');
}

function getMapboxToken(): string | null {
  const t =
    process.env.MAPBOX_ACCESS_TOKEN ||
    process.env.MAPBOX_TOKEN ||
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  return typeof t === 'string' && t.trim() !== '' ? t.trim() : null;
}

/**
 * Retorna lat/lng aproximados a partir do endereço cadastrado (PDV).
 */
export async function geocodeBrazilAddress(parts: AddressParts): Promise<{ lat: number; lng: number } | null> {
  const token = getMapboxToken();
  if (!token) return null;

  const streetRaw = parts.street?.trim() ?? '';
  const numberRaw = parts.number?.trim() ?? '';
  const streetLine = [streetRaw, numberRaw].filter((p) => p.length > 0).join(', ');
  const neighborhood = parts.neighborhood?.trim() ?? '';
  const city = parts.city?.trim() ?? '';
  const state = parts.state?.trim() ?? '';
  const zip = parts.zip?.trim() ?? '';

  // Precisa de pelo menos cidade + UF (ou CEP) para resultado útil
  if (!city && !state && !zip && !streetLine) return null;
  if (!city && !state && zip.length < 5) return null;

  const pieces = [streetLine, neighborhood, city, state, zip, 'Brasil'].filter((p) => p.length > 0);
  if (pieces.length < 2) return null;

  const q = pieces.join(', ');
  const base = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${encodeURIComponent(token)}&country=br&limit=1`;

  const parseCenter = (data: { features?: Array<{ center?: [number, number] }> }) => {
    const center = data.features?.[0]?.center;
    if (!center || center.length < 2) return null;
    const [lng, lat] = center;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  };

  try {
    // 1) types=address: melhor precisão em rua + número (ponteiro no imóvel)
    let res = await fetch(`${base}&types=address`);
    if (res.ok) {
      const data = (await res.json()) as { features?: Array<{ center?: [number, number] }> };
      const pt = parseCenter(data);
      if (pt) return pt;
    }
    // 2) sem filtro de tipo — interior / CEPs fracos ainda retornam ponto
    res = await fetch(base);
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: Array<{ center?: [number, number] }> };
    return parseCenter(data);
  } catch {
    return null;
  }
}
