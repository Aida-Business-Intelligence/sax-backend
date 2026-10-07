/**
 * File validation using magic bytes (file signatures).
 * Never trust file extension or Content-Type header alone — always check the buffer.
 */

import sharp from 'sharp';

export interface ImageValidationResult {
  ok: boolean;
  /** Detected MIME type when ok=true */
  mime: string;
  error?: string;
}

export interface FileValidationResult {
  ok: boolean;
  error?: string;
}

// ─── Magic byte signatures ────────────────────────────────────────────────────

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isPng(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function isGif(buf: Buffer): boolean {
  return (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    (buf[3] === 0x38) &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  );
}

function isWebp(buf: Buffer): boolean {
  // RIFF????WEBP
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  );
}

function isIco(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── Compressão no upload ──────────────────────────────────────────────────
// Pedido de 15/09 (Tiago): fotos de celular vinham gigantes (dezenas de MB)
// e batiam no limite de tamanho ("File too large"), sem opção de comprimir
// na hora. Agora toda imagem passa por aqui antes de checar o limite: reduz
// dimensão (lado maior até COMPRESS_MAX_DIMENSION) e reencoda com qualidade
// alta -- perda visual desprezível, mas corta bastante peso de foto de
// câmera/celular que normalmente vem com compressão mínima.

/**
 * Recusa upload absurdo antes mesmo de tentar decodificar (abuso/decompression
 * bomb). O limite de verdade (SIZE.*) é conferido DEPOIS de comprimir.
 * Exportado porque o multer (`limits.fileSize`) precisa do MESMO teto —
 * senão ele rejeita o arquivo bruto (foto de celular grande) antes mesmo da
 * imagem chegar na rota pra ser comprimida.
 */
export const UPLOAD_HARD_CEILING = 60 * 1024 * 1024; // 60 MB brutos

const COMPRESS_MAX_DIMENSION = 2400; // px no lado maior — de sobra pra qualquer uso no site/PDV
const COMPRESS_QUALITY = 88; // quase sem perda visível

/**
 * Recomprime a imagem (reduz dimensão gigante + reencoda com qualidade alta).
 * GIF e ICO passam direto (comprimir GIF perderia a animação; ICO já é
 * sempre pequeno). Se a "compressão" sair maior que o original (imagem já
 * bem otimizada) ou o sharp não conseguir decodificar, mantém o original.
 */
async function compressImage(buf: Buffer, mime: string): Promise<Buffer> {
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return buf;
  try {
    let pipeline = sharp(buf, { failOn: 'none' }).rotate();
    const { width = 0, height = 0 } = await pipeline.metadata();
    if (width > COMPRESS_MAX_DIMENSION || height > COMPRESS_MAX_DIMENSION) {
      pipeline = pipeline.resize({
        width: COMPRESS_MAX_DIMENSION,
        height: COMPRESS_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const out =
      mime === 'image/png'
        ? await pipeline.png({ quality: COMPRESS_QUALITY, compressionLevel: 9 }).toBuffer()
        : mime === 'image/webp'
          ? await pipeline.webp({ quality: COMPRESS_QUALITY }).toBuffer()
          : await pipeline.jpeg({ quality: COMPRESS_QUALITY, mozjpeg: true }).toBuffer();
    return out.length < buf.length ? out : buf;
  } catch {
    return buf;
  }
}

/**
 * Valida a imagem (magic bytes) e recomprime ANTES de checar o limite de
 * tamanho — por isso uma foto de celular de 30 MB normalmente passa: depois
 * de comprimida cai bem abaixo de qualquer SIZE.*. Substitui `validateImage`
 * em toda rota de upload de imagem.
 */
export async function validateAndCompressImage(
  buf: Buffer,
  maxBytes: number,
  allowIco = false
): Promise<ImageValidationResult & { buffer?: Buffer }> {
  if (buf.length === 0) {
    return { ok: false, mime: '', error: 'Arquivo vazio' };
  }
  if (buf.length > UPLOAD_HARD_CEILING) {
    const maxMb = (UPLOAD_HARD_CEILING / 1024 / 1024).toFixed(0);
    return { ok: false, mime: '', error: `Arquivo muito grande (máx. ${maxMb} MB antes de comprimir)` };
  }

  let mime = '';
  if (isJpeg(buf)) mime = 'image/jpeg';
  else if (isPng(buf)) mime = 'image/png';
  else if (isGif(buf)) mime = 'image/gif';
  else if (isWebp(buf)) mime = 'image/webp';
  else if (allowIco && isIco(buf)) mime = 'image/x-icon';

  if (!mime) {
    return { ok: false, mime: '', error: 'Formato de imagem inválido. Use JPEG, PNG, GIF ou WebP.' };
  }

  const compressed = await compressImage(buf, mime);

  if (compressed.length > maxBytes) {
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, mime: '', error: `Arquivo muito grande mesmo após compressão (máx. ${maxMb} MB)` };
  }

  return { ok: true, mime, buffer: compressed };
}

/** Validates any file for PDV file manager (size only — any type is accepted). */
export function validateFile(buf: Buffer, maxBytes: number): FileValidationResult {
  if (buf.length === 0) return { ok: false, error: 'Arquivo vazio' };
  if (buf.length > maxBytes) {
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, error: `Arquivo muito grande (máx. ${maxMb} MB)` };
  }
  return { ok: true };
}

/** Returns a safe file extension from a detected MIME type. */
export function safeExtFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    case 'image/x-icon': return '.ico';
    default: return '.bin';
  }
}

// ─── Size limit constants ─────────────────────────────────────────────────────
export const SIZE = {
  PROPERTY_IMAGE: 10 * 1024 * 1024,   // 10 MB
  SITE_ASSET:      5 * 1024 * 1024,   //  5 MB
  SETTINGS_LOGO:   5 * 1024 * 1024,   //  5 MB
  AVATAR:          3 * 1024 * 1024,   //  3 MB
  HELPDESK_IMAGE:  8 * 1024 * 1024,   //  8 MB
  PDV_FILE:      100 * 1024 * 1024,   // 100 MB
};
