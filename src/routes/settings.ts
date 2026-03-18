import path from 'path';
import fs from 'fs';
import { Router, Request, Response } from 'express';

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'settings');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * PUT /api/settings/upload/:type/:warehouseId
 * Recebe multipart/form-data com campo "file" (logo ou icon).
 * type: 'logo' | 'icon'
 */
router.put('/upload/:type/:warehouseId', (req: Request, res: Response) => {
  const { type, warehouseId } = req.params;
  if (!type || !warehouseId) {
    res.status(400).json({ status: false, message: 'type e warehouse_id são obrigatórios' });
    return;
  }
  if (!req.is('multipart/form-data')) {
    res.status(400).json({ status: false, message: 'Content-Type deve ser multipart/form-data' });
    return;
  }

  // Parse multipart manualmente (sem multer) para não adicionar dependência
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const boundary = req.headers['content-type']?.split('boundary=')[1]?.trim().replace(/^["']|["']$/g, '');
    if (!boundary) {
      res.status(400).json({ status: false, message: 'Boundary não encontrado' });
      return;
    }

    const parts = buffer.split(`--${boundary}`).filter((p) => p.length > 0 && !p.toString().endsWith('--\r\n'));
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
        fileBuffer = body.subarray(0, body.length - 2); // remove trailing \r\n
        break;
      }
    }

    if (!fileBuffer || !filename) {
      res.status(400).json({ status: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }

    const ext = path.extname(filename) || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];
    if (!allowed.includes(ext.toLowerCase())) {
      res.status(400).json({ status: false, message: 'Tipo de arquivo não permitido' });
      return;
    }

    ensureUploadDir();
    const warehouseDir = path.join(UPLOAD_DIR, warehouseId);
    if (!fs.existsSync(warehouseDir)) {
      fs.mkdirSync(warehouseDir, { recursive: true });
    }
    const safeName = `${type}${ext}`;
    const filePath = path.join(warehouseDir, safeName);
    fs.writeFileSync(filePath, fileBuffer);

    const relativeUrl = `/uploads/settings/${warehouseId}/${safeName}`;
    res.json({ status: true, file: relativeUrl, message: 'Imagem enviada com sucesso' });
  });
  req.on('error', () => {
    res.status(500).json({ status: false, message: 'Erro ao receber o arquivo' });
  });
});

export default router;
