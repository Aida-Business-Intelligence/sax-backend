/**
 * Posição aproximada a partir do fuso IANA do navegador (útil quando o IP é local/privado).
 * Não substitui GPS nem geolocalização por IP público.
 */

export type RoughGeo = { lat: number; lng: number; city: string | null };

const BR_MAJOR: Record<string, RoughGeo> = {
  'America/Sao_Paulo': { lat: -23.5505, lng: -46.6333, city: 'São Paulo (fuso)' },
  'America/Manaus': { lat: -3.119, lng: -60.0217, city: 'Manaus (fuso)' },
  'America/Fortaleza': { lat: -3.7172, lng: -38.5433, city: 'Fortaleza (fuso)' },
  'America/Recife': { lat: -8.0476, lng: -34.877, city: 'Recife (fuso)' },
  'America/Maceio': { lat: -9.6497, lng: -35.7089, city: 'Maceió (fuso)' },
  'America/Bahia': { lat: -12.9777, lng: -38.5016, city: 'Salvador (fuso)' },
  'America/Belem': { lat: -1.4558, lng: -48.5039, city: 'Belém (fuso)' },
  'America/Cuiaba': { lat: -15.6014, lng: -56.0979, city: 'Cuiabá (fuso)' },
  'America/Campo_Grande': { lat: -20.4697, lng: -54.6201, city: 'Campo Grande (fuso)' },
  'America/Araguaina': { lat: -7.1922, lng: -48.2079, city: 'Palmas (fuso)' },
  'America/Rio_Branco': { lat: -9.9754, lng: -67.8243, city: 'Rio Branco (fuso)' },
  'America/Porto_Velho': { lat: -8.7612, lng: -63.9039, city: 'Porto Velho (fuso)' },
  'America/Boa_Vista': { lat: 2.8235, lng: -60.6758, city: 'Boa Vista (fuso)' },
  'America/Noronha': { lat: -3.8544, lng: -32.4231, city: 'Fernando de Noronha (fuso)' },
  'America/Santarem': { lat: -2.4431, lng: -54.7083, city: 'Santarém (fuso)' },
};

/** Centro aproximado do Brasil (Brasília) para fusos Americanos não mapeados. */
const AMERICA_BR_FALLBACK: RoughGeo = {
  lat: -15.7801,
  lng: -47.9292,
  city: 'Brasil (aprox. pelo fuso)',
};

export function roughCoordsFromTimeZone(tz: string | null | undefined): RoughGeo | null {
  if (!tz || typeof tz !== 'string') return null;
  const t = tz.trim();
  if (t === 'UTC' || t === 'Etc/UTC' || t === 'Etc/GMT') return null;
  if (BR_MAJOR[t]) return BR_MAJOR[t];
  if (t.startsWith('America/')) return AMERICA_BR_FALLBACK;
  return null;
}
