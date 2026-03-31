/**
 * Geolocalização aproximada por IP (ip-api.com, uso não comercial / limite de taxa).
 * Cache em memória para reduzir chamadas repetidas ao mesmo IP.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: IpGeoResult | null }>();

export type IpGeoResult = {
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  country: string | null;
};

/** Evita localhost e redes privadas comuns (IPv4). */
export function isLikelyPublicIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const t = ip.trim();
  if (t === '::1' || t === '127.0.0.1') return false;
  if (t.startsWith('::ffff:127.')) return false;
  if (/^10\./.test(t)) return false;
  if (/^192\.168\./.test(t)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(t)) return false;
  return true;
}

/**
 * Resolve IP → coordenadas aproximadas + cidade/região/país.
 * Retorna null se falhar ou IP inválido.
 */
export async function lookupIpGeo(ip: string): Promise<IpGeoResult | null> {
  if (!isLikelyPublicIp(ip)) return null;

  const cached = cache.get(ip);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,lat,lon`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      cache.set(ip, { at: Date.now(), value: null });
      return null;
    }
    const data = (await res.json()) as {
      status?: string;
      country?: string;
      regionName?: string;
      city?: string;
      lat?: number;
      lon?: number;
    };
    if (data.status !== 'success' || typeof data.lat !== 'number' || typeof data.lon !== 'number') {
      cache.set(ip, { at: Date.now(), value: null });
      return null;
    }
    const value: IpGeoResult = {
      lat: data.lat,
      lon: data.lon,
      city: data.city ?? null,
      region: data.regionName ?? null,
      country: data.country ?? null,
    };
    cache.set(ip, { at: Date.now(), value });
    return value;
  } catch {
    cache.set(ip, { at: Date.now(), value: null });
    return null;
  }
}
