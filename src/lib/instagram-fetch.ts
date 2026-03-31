/**
 * Busca mídias recentes da conta Instagram Business via Graph API.
 * Requer token com permissões instagram_basic / pages_read_engagement conforme app Meta.
 */

/** Evita encher o console a cada hit em /api/public/feed quando o token está inválido. */
let warnedInvalidInstagramToken = false;

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
    logInstagramHttpError(res.status, errText);
    return [];
  }

  const data = (await res.json()) as {
    data?: GraphMediaNode[];
    error?: { message?: string; code?: number; type?: string };
  };
  if (data.error?.message) {
    logInstagramGraphError(data.error);
    return [];
  }

  const list = Array.isArray(data.data) ? data.data : [];
  const out = list.map((n) => ({
    id: n.id,
    caption: n.caption,
    mediaType: n.media_type ?? 'IMAGE',
    mediaUrl: n.media_url,
    thumbnailUrl: n.thumbnail_url,
    permalink: n.permalink,
    timestamp: n.timestamp,
  }));
  if (out.length > 0) warnedInvalidInstagramToken = false;
  return out;
}

function parseGraphErrorBody(text: string): { code?: number; message?: string; type?: string } | null {
  try {
    const j = JSON.parse(text) as { error?: { code?: number; message?: string; type?: string } };
    return j?.error ?? null;
  } catch {
    return null;
  }
}

/** Códigos Meta comuns: 190 token inválido/expirado, 102 sessão inválida. */
function isInvalidOAuthError(err: { code?: number; message?: string; type?: string } | null): boolean {
  if (!err) return false;
  if (err.code === 190 || err.code === 102) return true;
  const m = String(err.message ?? '').toLowerCase();
  return (
    err.type === 'OAuthException' ||
    /invalid oauth|cannot parse access token|session has been invalidated/i.test(m)
  );
}

function logInstagramHttpError(status: number, errText: string): void {
  const parsed = parseGraphErrorBody(errText);
  if (isInvalidOAuthError(parsed)) {
    if (!warnedInvalidInstagramToken) {
      warnedInvalidInstagramToken = true;
      console.warn(
        '[instagram-fetch] Token do Instagram inválido ou expirado (Meta OAuth). ' +
          'Gere um token de longa duração no Meta for Developers e atualize no PDV: Gestão do site → Stories / feed Instagram. ' +
          'Enquanto isso o feed do site segue sem mídias do Instagram.'
      );
    }
    return;
  }
  console.warn('[instagram-fetch]', status, errText.slice(0, 280));
}

function logInstagramGraphError(error: { message?: string; code?: number; type?: string }): void {
  if (isInvalidOAuthError(error)) {
    if (!warnedInvalidInstagramToken) {
      warnedInvalidInstagramToken = true;
      console.warn(
        '[instagram-fetch] Token do Instagram inválido ou expirado. Atualize o token no PDV (Gestão do site → Instagram).'
      );
    }
    return;
  }
  console.warn('[instagram-fetch] graph error', error.message);
}
