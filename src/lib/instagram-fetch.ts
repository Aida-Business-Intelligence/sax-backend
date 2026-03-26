/**
 * Busca mídias recentes da conta Instagram Business via Graph API.
 * Requer token com permissões instagram_basic / pages_read_engagement conforme app Meta.
 */

export type InstagramMediaItem = {
  id: string;
  caption?: string;
  mediaType: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  permalink?: string;
  timestamp?: string;
};

type GraphMediaNode = {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
};

export async function fetchInstagramMedia(
  instagramBusinessAccountId: string,
  accessToken: string,
  limit = 12
): Promise<InstagramMediaItem[]> {
  const id = String(instagramBusinessAccountId ?? '').trim();
  const token = String(accessToken ?? '').trim();
  if (!id || !token) return [];

  const fields = [
    'id',
    'caption',
    'media_type',
    'media_url',
    'thumbnail_url',
    'permalink',
    'timestamp',
  ].join(',');

  const url = new URL(`https://graph.facebook.com/v18.0/${encodeURIComponent(id)}/media`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 25)));

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.warn('[instagram-fetch]', res.status, errText.slice(0, 200));
    return [];
  }

  const data = (await res.json()) as { data?: GraphMediaNode[]; error?: { message?: string } };
  if (data.error?.message) {
    console.warn('[instagram-fetch] graph error', data.error.message);
    return [];
  }

  const list = Array.isArray(data.data) ? data.data : [];
  return list.map((n) => ({
    id: n.id,
    caption: n.caption,
    mediaType: n.media_type ?? 'IMAGE',
    mediaUrl: n.media_url,
    thumbnailUrl: n.thumbnail_url,
    permalink: n.permalink,
    timestamp: n.timestamp,
  }));
}
