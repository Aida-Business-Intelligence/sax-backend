import multer from 'multer';
import { Router, Request, Response } from 'express';
import { uploadPublic, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

const settingsImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.SETTINGS_LOGO },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

/**
 * PUT /api/settings/upload/:type/:warehouseId
 * Recebe multipart/form-data com campo "file" (logo ou icon).
 * type: 'logo' | 'icon'
 */
router.put(
  '/upload/:type/:warehouseId',
  settingsImageUpload.single('file'),
  async (req: Request, res: Response) => {
    const { type, warehouseId } = req.params;
    if (!type || !warehouseId) {
      res.status(400).json({ status: false, message: 'type e warehouse_id são obrigatórios' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ status: false, message: 'Nenhum arquivo enviado no campo "file"' });
      return;
    }

    const validation = validateImage(req.file.buffer, SIZE.SETTINGS_LOGO);
    if (!validation.ok) {
      res.status(422).json({ status: false, message: validation.error });
      return;
    }

    const ext = safeExtFromMime(validation.mime!);
    const key = keys.settingsImage(warehouseId, type, `${Date.now()}${ext}`);
    const url = await uploadPublic(key, req.file.buffer, validation.mime!);

    res.json({ status: true, file: url, message: 'Imagem enviada com sucesso' });
  },
);

export default router;
