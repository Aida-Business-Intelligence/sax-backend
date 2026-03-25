/**
 * Monta URL absoluta para arquivos em /uploads, para o browser carregar a imagem
 * mesmo quando o front (Next) não é o mesmo host do sax-backend.
 * Defina SAX_API_URL no backend (ex.: http://localhost:4000).
 */
export function publicUploadUrl(relative: string | null | undefined): string {
  if (relative == null || relative === '') return '';
  const s = String(relative).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  const base = (process.env.SAX_API_URL || '').replace(/\/$/, '');
  if (!base) return s;
  return `${base}${s.startsWith('/') ? '' : '/'}${s}`;
}
