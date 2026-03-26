/**
 * File validation using magic bytes (file signatures).
 * Never trust file extension or Content-Type header alone — always check the buffer.
 */

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

/**
 * Validates that a buffer is a genuine raster image.
 * Accepted formats: JPEG, PNG, GIF, WebP.
 * Set `allowIco=true` to also accept ICO (for favicon uploads).
 */
export function validateImage(
  buf: Buffer,
  maxBytes: number,
  allowIco = false
): ImageValidationResult {
  if (buf.length === 0) {
    return { ok: false, mime: '', error: 'Arquivo vazio' };
  }
  if (buf.length > maxBytes) {
    const maxMb = (maxBytes / 1024 / 1024).toFixed(0);
    return { ok: false, mime: '', error: `Arquivo muito grande (máx. ${maxMb} MB)` };
  }

  if (isJpeg(buf)) return { ok: true, mime: 'image/jpeg' };
  if (isPng(buf)) return { ok: true, mime: 'image/png' };
  if (isGif(buf)) return { ok: true, mime: 'image/gif' };
  if (isWebp(buf)) return { ok: true, mime: 'image/webp' };
  if (allowIco && isIco(buf)) return { ok: true, mime: 'image/x-icon' };

  return {
    ok: false,
    mime: '',
    error: 'Formato de imagem inválido. Use JPEG, PNG, GIF ou WebP.',
  };
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
