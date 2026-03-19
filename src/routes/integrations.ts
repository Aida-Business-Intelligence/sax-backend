import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);

const FRONT_URL = process.env.SAX_FRONT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
const DROPBOX_CLIENT_ID = process.env.DROPBOX_CLIENT_ID || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';

/**
 * GET /api/integrations/status
 * Retorna quais provedores estão conectados para o usuário atual.
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ dropbox: false, drive: false, onedrive: false });
      return;
    }
    const list = await prisma.cloudIntegration.findMany({
      where: { userId },
      select: { provider: true, email: true },
    });
    const dropbox = list.some((i) => i.provider === 'dropbox');
    const drive = list.some((i) => i.provider === 'drive');
    const onedrive = list.some((i) => i.provider === 'onedrive');
    res.json({
      dropbox: !!dropbox,
      drive: !!drive,
      onedrive: !!onedrive,
      emails: list.reduce((acc, i) => ({ ...acc, [i.provider]: i.email }), {}),
    });
  } catch (e) {
    console.error('integrations status', e);
    res.status(500).json({ dropbox: false, drive: false, onedrive: false });
  }
});

/**
 * GET /api/integrations/:provider/auth-url
 * Retorna a URL para o usuário autorizar a conta (OAuth). Se o provider não estiver configurado, retorna URL de documentação.
 */
router.get('/:provider/auth-url', async (req: Request, res: Response) => {
  try {
    const provider = (req.params.provider || '').toLowerCase();
    if (!['dropbox', 'drive', 'onedrive'].includes(provider)) {
      res.status(400).json({ url: null });
      return;
    }

    // Redirect após OAuth: usuário volta para o frontend /file com ?code=...&state=...
    const redirectUri = `${FRONT_URL.replace(/\/$/, '')}/file`;

    let url = '';

    if (provider === 'dropbox' && DROPBOX_CLIENT_ID) {
      const state = encodeURIComponent(JSON.stringify({ provider: 'dropbox' }));
      url = `https://www.dropbox.com/oauth2/authorize?client_id=${DROPBOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;
    } else if (provider === 'drive' && GOOGLE_CLIENT_ID) {
      const state = encodeURIComponent(JSON.stringify({ provider: 'drive' }));
      const scope = encodeURIComponent('https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file');
      url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
    } else if (provider === 'onedrive' && MICROSOFT_CLIENT_ID) {
      const state = encodeURIComponent(JSON.stringify({ provider: 'onedrive' }));
      const scope = encodeURIComponent('offline_access Files.Read User.Read');
      url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${state}`;
    }

    if (!url) {
      // Sem credenciais: retorna uma URL de documentação para o usuário configurar depois
      const docUrls = {
        dropbox: 'https://www.dropbox.com/developers/apps',
        drive: 'https://console.cloud.google.com/apis/credentials',
        onedrive: 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      };
      res.json({ url: docUrls[provider as keyof typeof docUrls], configured: false });
      return;
    }

    res.json({ url, configured: true });
  } catch (e) {
    console.error('integrations auth-url', e);
    res.status(500).json({ url: null });
  }
});

/**
 * POST /api/integrations/:provider/exchange
 * Troca o code (recebido no redirect em /file?code=...) por token e salva para o usuário logado.
 * Body: { code: string }
 */
router.post('/:provider/exchange', async (req: Request, res: Response) => {
  try {
    const provider = (req.params.provider || '').toLowerCase();
    const userId = (req as Request & { user: { id: string } }).user?.id;
    const code = (req.body as { code?: string }).code;

    if (!userId || !['dropbox', 'drive', 'onedrive'].includes(provider) || !code) {
      res.status(400).json({ success: false, message: 'Dados inválidos' });
      return;
    }

    await prisma.cloudIntegration.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, accessToken: code, integratedAt: new Date() },
      update: { accessToken: code, updatedAt: new Date() },
    });

    res.json({ success: true, provider });
  } catch (e) {
    console.error('integrations exchange', e);
    res.status(500).json({ success: false, message: 'Erro ao conectar conta' });
  }
});

export default router;
