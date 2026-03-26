import multer from 'multer';
import { Router, Request, Response } from 'express';
import { uploadPublic, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';

const router = Router();

/**
 * Config por warehouse em memória (reinício do servidor perde os dados).
 * Substituir por persistência em banco quando existir modelo adequado.
 */
const warehouseConfigById = new Map<string, Record<string, unknown>>();

/**
 * GET /api/settings/options — legado do template PDV (listas de opções por categoria).
 * sax-backend não persiste isso ainda; resposta vazia evita 404 no dashboard (blog, etc.).
 */
router.get('/options', (_req: Request, res: Response) => {
  res.json([]);
});

/**
 * GET /api/settings/config — legado do template (config por warehouse).
 * Com ?warehouse_id= devolve chaves salvas via POST /update_config (ex.: helpdesk_webrtc_settings).
 */
router.get('/config', (req: Request, res: Response) => {
  const warehouseId =
    typeof req.query.warehouse_id === 'string' ? req.query.warehouse_id : undefined;
  if (!warehouseId) {
    res.json({});
    return;
  }
  res.json(warehouseConfigById.get(warehouseId) ?? {});
});

/**
 * POST /api/settings/update_config — legado do PDV (merge de chaves por warehouse).
 */
router.post('/update_config', (req: Request, res: Response) => {
  const warehouseId = req.body?.warehouse_id as string | undefined;
  if (!warehouseId || typeof warehouseId !== 'string') {
    res.status(400).json({ message: 'warehouse_id é obrigatório' });
    return;
  }
  const prev = warehouseConfigById.get(warehouseId) ?? {};
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (k === 'warehouse_id') continue;
    if (v !== undefined) next[k] = v;
  }
  warehouseConfigById.set(warehouseId, next);
  res.json({ ok: true });
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
