import multer from 'multer';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import {
  getWarehousePdvSettings,
  mergeWarehousePdvSettings,
} from '../lib/pdv-warehouse-settings.js';
import { uploadPublic, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

/**
 * GET /api/settings/options — legado do template PDV (listas de opções por categoria).
 */
router.get('/options', (_req: Request, res: Response) => {
  res.json([]);
});

/**
 * GET /api/settings/config — config por warehouse (Prisma).
 * Inclui integrations_settings, helpdesk_webrtc_settings, etc. (merge via POST update_config).
 */
router.get('/config', async (req: Request, res: Response) => {
  const warehouseId =
    typeof req.query.warehouse_id === 'string' ? req.query.warehouse_id.trim() : '';
  if (!warehouseId) {
    res.json({});
    return;
  }
  try {
    const row = await prisma.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true },
    });
    if (!row) {
      res.status(404).json({ message: 'Loja não encontrada' });
      return;
    }
    const cfg = await getWarehousePdvSettings(warehouseId);
    res.json(cfg);
  } catch (e) {
    console.error('[settings/config GET]', e);
    res.status(500).json({ message: 'Erro ao carregar configurações' });
  }
});

/**
 * POST /api/settings/update_config — merge de chaves por warehouse (persistido em Warehouse.pdvSettingsJson).
 */
router.post('/update_config', async (req: Request, res: Response) => {
  const warehouseId = req.body?.warehouse_id as string | undefined;
  if (!warehouseId || typeof warehouseId !== 'string') {
    res.status(400).json({ message: 'warehouse_id é obrigatório' });
    return;
  }
  try {
    const row = await prisma.warehouse.findUnique({
      where: { id: warehouseId.trim() },
      select: { id: true },
    });
    if (!row) {
      res.status(404).json({ message: 'Loja não encontrada' });
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      if (k === 'warehouse_id') continue;
      if (v !== undefined) patch[k] = v;
    }
    await mergeWarehousePdvSettings(warehouseId.trim(), patch);
    res.json({ ok: true });
  } catch (e) {
    console.error('[settings/update_config]', e);
    res.status(500).json({ message: 'Erro ao salvar configurações' });
  }
});

const settingsImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.SETTINGS_LOGO },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

/**
 * PUT /api/settings/upload/:type/:warehouseId
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
