import { Router, Request, Response } from 'express';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, decrypt } from '../lib/encrypt.js';
import { config } from '../config.js';

const router = Router();
router.use(authMiddleware);

const ENCRYPT_SECRET = process.env.JWT_SECRET || config.jwtSecret || 'dev-secret-change-in-production';

// ----------------------------------------------------------------------
// Contas: listar, criar, remover
// ----------------------------------------------------------------------

/**
 * GET /api/mail/accounts
 * Lista contas de e-mail do usuário (sem expor senha).
 */
router.get('/accounts', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ accounts: [] });
      return;
    }
    const accounts = await prisma.emailAccount.findMany({
      where: { userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        provider: true,
        imapHost: true,
        imapPort: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ accounts });
  } catch (e) {
    console.error('mail accounts list', e);
    res.status(500).json({ accounts: [] });
  }
});

/**
 * POST /api/mail/accounts
 * Conecta uma nova conta (IMAP). Body: email, password, displayName?, imapHost, imapPort?, imapSecure?, smtpHost?, smtpPort?
 */
router.post('/accounts', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: 'Não autorizado' });
      return;
    }
    const body = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
      imapHost?: string;
      imapPort?: number;
      imapSecure?: boolean;
      smtpHost?: string;
      smtpPort?: number;
    };
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password;
    if (!email || !password || !body.imapHost) {
      res.status(400).json({ success: false, message: 'E-mail, senha e servidor IMAP são obrigatórios.' });
      return;
    }
    const host = body.imapHost.trim();
    const port = body.imapPort ?? 993;
    const secure = body.imapSecure !== false;
    const testClient = new ImapFlow({
      host,
      port,
      secure,
      auth: { user: email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    try {
      await testClient.connect();
      await testClient.logout();
    } catch (imapErr: unknown) {
      const err = imapErr as Error & { responseText?: string };
      const imapMessage = err?.responseText || (err instanceof Error ? err.message : String(imapErr));
      console.error('mail accounts create IMAP test', imapErr);
      res.status(422).json({
        success: false,
        message: imapMessage || 'Não foi possível conectar ao servidor de e-mail. Verifique usuário, senha e IMAP.',
      });
      return;
    }
    const encrypted = encrypt(password, ENCRYPT_SECRET);
    const account = await prisma.emailAccount.create({
      data: {
        userId,
        email,
        displayName: (body.displayName || email).trim() || email,
        provider: 'imap',
        imapHost: host,
        imapPort: port,
        imapSecure: body.imapSecure !== false,
        smtpHost: body.smtpHost?.trim() || null,
        smtpPort: body.smtpPort ?? null,
        credentials: encrypted,
      },
    });
    res.json({
      success: true,
      account: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        provider: account.provider,
        imapHost: account.imapHost,
        imapPort: account.imapPort,
        createdAt: account.createdAt,
      },
    });
  } catch (e: unknown) {
    console.error('mail accounts create', e);
    const msg = e instanceof Error ? e.message : String(e);
    const isPrisma = msg.includes('Prisma') || msg.includes('Unknown arg') || msg.includes('does not exist');
    const isCrypto = msg.includes('crypto') || msg.includes('scrypt') || msg.includes('Cipher');
    let userMessage = msg || 'Erro ao conectar conta.';
    if (isPrisma) {
      userMessage = 'Tabela de e-mail não configurada. Execute a migração do banco (prisma migrate).';
    } else if (isCrypto) {
      userMessage = 'Erro ao salvar credenciais. Verifique JWT_SECRET no servidor.';
    }
    res.status(500).json({ success: false, message: userMessage });
  }
});

/**
 * DELETE /api/mail/accounts/:id
 */
router.delete('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    const id = req.params.id;
    if (!userId || !id) {
      res.status(400).json({ success: false });
      return;
    }
    await prisma.emailAccount.deleteMany({
      where: { id, userId },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('mail accounts delete', e);
    res.status(500).json({ success: false });
  }
});

// ----------------------------------------------------------------------
// Helpers IMAP: obter cliente e credenciais para uma conta
// ----------------------------------------------------------------------

async function getAccountAndPassword(accountId: string, userId: string) {
  const account = await prisma.emailAccount.findFirst({
    where: { id: accountId, userId },
  });
  if (!account) return null;
  const password = decrypt(account.credentials, ENCRYPT_SECRET);
  return { account, password };
}

// ----------------------------------------------------------------------
// Labels (pastas IMAP)
// ----------------------------------------------------------------------

/**
 * GET /api/mail/labels?accountId=
 * Lista pastas (labels) da conta. Sem accountId usa a primeira conta do usuário.
 */
router.get('/labels', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    const accountId = (req.query.accountId as string) || undefined;
    if (!userId) {
      res.json({ labels: [] });
      return;
    }
    let account: { id: string; email: string; imapHost: string; imapPort: number; imapSecure: boolean } | null;
    let password: string;
    if (accountId) {
      const row = await getAccountAndPassword(accountId, userId);
      if (!row) {
        res.json({ labels: [] });
        return;
      }
      account = row.account;
      password = row.password;
    } else {
      const first = await prisma.emailAccount.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!first) {
        res.json({ labels: [] });
        return;
      }
      const row = await getAccountAndPassword(first.id, userId);
      if (!row) {
        res.json({ labels: [] });
        return;
      }
      account = row.account;
      password = row.password;
    }
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    const list = await client.list({ statusQuery: { unseen: true, messages: true } }).catch(() => client.list());
    await client.logout();
    const labelsMap = new Map<string, { id: string; name: string; path: string; type: string; unreadCount?: number }>();
    for (const mb of list) {
      if (mb.flags?.has('\\Noselect')) continue;
      const unreadCount = (mb as { status?: { unseen?: number } }).status?.unseen ?? 0;
      labelsMap.set(mb.path, {
        id: mb.path,
        name: mb.path,
        path: mb.path,
        type: mb.specialUse ? 'system' : 'custom',
        unreadCount: unreadCount > 0 ? unreadCount : undefined,
      });
    }
    if (!labelsMap.has('INBOX')) {
      labelsMap.set('INBOX', { id: 'INBOX', name: 'INBOX', path: 'INBOX', type: 'system', unreadCount: undefined });
    }
    const order = [
      'INBOX',
      '[Gmail]/Com Estrela',
      '[Gmail]/Starred',
      '[Gmail]/E-Mails Enviados',
      '[Gmail]/Sent Mail',
      '[Gmail]/Rascunhos',
      '[Gmail]/Drafts',
      '[Gmail]/Importante',
      '[Gmail]/Important',
      '[Gmail]/Todos Os E-Mails',
      '[Gmail]/All Mail',
      '[Gmail]/Spam',
      '[Gmail]/Lixeira',
      '[Gmail]/Trash',
    ];
    const rest = Array.from(labelsMap.keys()).filter((p) => !order.includes(p));
    const ordered = [...order.filter((p) => labelsMap.has(p)), ...rest.sort()];
    const labels = ordered.map((p) => labelsMap.get(p)!).filter(Boolean);
    res.json({ labels });
  } catch (e: unknown) {
    const err = e as Error & { responseText?: string };
    const message = err?.responseText || (err instanceof Error ? err.message : String(e));
    console.error('mail labels', e);
    res.status(200).json({ labels: [], error: message });
  }
});

/**
 * GET /api/mail/list?accountId=&labelId=
 * Lista mensagens da pasta. labelId = nome da pasta IMAP (ex: INBOX).
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    const accountId = (req.query.accountId as string) || undefined;
    const labelId = (req.query.labelId as string) || 'INBOX';
    if (!userId) {
      res.json({ mails: [] });
      return;
    }
    let account: { id: string; email: string; imapHost: string; imapPort: number; imapSecure: boolean } | null;
    let password: string;
    if (accountId) {
      const row = await getAccountAndPassword(accountId, userId);
      if (!row) {
        res.json({ mails: [] });
        return;
      }
      account = row.account;
      password = row.password;
    } else {
      const first = await prisma.emailAccount.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!first) {
        res.json({ mails: [] });
        return;
      }
      const row = await getAccountAndPassword(first.id, userId);
      if (!row) {
        res.json({ mails: [] });
        return;
      }
      account = row.account;
      password = row.password;
    }
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    const mailbox = await client.mailboxOpen(labelId);
    const messages: Array<{
      id: string;
      from: { email: string; name: string };
      to: Array<{ email: string; name: string }>;
      subject: string;
      createdAt: string;
      isUnread: boolean;
      labelIds: string[];
    }> = [];
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const useFullFetch =
      /starred|com estrela|flagged|important|importante|drafts|rascunhos|trash|lixeira|spam/i.test(labelId);
    const maxFetch = useFullFetch ? Math.min(mailbox.exists, 500) : 3000;
    const fetchRange = useFullFetch
      ? '1:*'
      : { since: (() => {
          const d = new Date();
          d.setDate(d.getDate() - 90);
          return d;
        })() };
    let count = 0;
    for await (const msg of client.fetch(
      fetchRange,
      { envelope: true, uid: true, flags: true }
    )) {
      const env = msg.envelope;
      messages.push({
        id: String(msg.uid),
        from: {
          email: env.from?.[0]?.address || '',
          name: env.from?.[0]?.name || '',
        },
        to: (env.to || []).map((a) => ({ email: a.address || '', name: a.name || '' })),
        subject: env.subject || '(sem assunto)',
        createdAt: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
        isUnread: !msg.flags?.has('\\Seen'),
        labelIds: [labelId],
      });
      count++;
      if (count >= maxFetch) break;
    }
    await client.logout();
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const sorted = messages.slice(0, limit);
    res.json({ mails: sorted });
  } catch (e: unknown) {
    const err = e as Error & { responseText?: string };
    const message = err?.responseText || (err instanceof Error ? err.message : String(e));
    console.error('mail list', e);
    res.status(200).json({ mails: [], error: message });
  }
});

/**
 * GET /api/mail/details?accountId=&mailId=&labelId=
 * Retorna uma mensagem (corpo). mailId = UID IMAP.
 */
router.get('/details', async (req: Request, res: Response) => {
  try {
    const userId = (req as Request & { user: { id: string } }).user?.id;
    const accountId = (req.query.accountId as string) || undefined;
    const mailId = (req.query.mailId as string) || '';
    const labelId = (req.query.labelId as string) || 'INBOX';
    if (!userId || !mailId) {
      res.json({ mail: null });
      return;
    }
    let account: { id: string; email: string; imapHost: string; imapPort: number; imapSecure: boolean } | null;
    let password: string;
    if (accountId) {
      const row = await getAccountAndPassword(accountId, userId);
      if (!row) {
        res.json({ mail: null });
        return;
      }
      account = row.account;
      password = row.password;
    } else {
      const first = await prisma.emailAccount.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      if (!first) {
        res.json({ mail: null });
        return;
      }
      const row = await getAccountAndPassword(first.id, userId);
      if (!row) {
        res.json({ mail: null });
        return;
      }
      account = row.account;
      password = row.password;
    }
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.mailboxOpen(labelId);
    const uid = Number(mailId) || 0;
    let mail: {
      id: string;
      from: { email: string; name: string };
      to: Array<{ email: string; name: string }>;
      subject: string;
      createdAt: string;
      isUnread: boolean;
      labelIds: string[];
      text: string;
      html: string;
    } | null = null;
    let wasUnread = false;
    for await (const msg of client.fetch(
      { uid },
      { envelope: true, uid: true, flags: true, source: true }
    )) {
      wasUnread = !msg.flags?.has('\\Seen');
      const env = msg.envelope;
      let text = '';
      let html = '';
      if (msg.source) {
        const parsed = await simpleParser(msg.source);
        text = parsed.text || '';
        html = parsed.html || '';
      }
      mail = {
        id: String(msg.uid),
        from: {
          email: env.from?.[0]?.address || '',
          name: env.from?.[0]?.name || '',
        },
        to: (env.to || []).map((a) => ({ email: a.address || '', name: a.name || '' })),
        subject: env.subject || '(sem assunto)',
        createdAt: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
        isUnread: false,
        labelIds: [labelId],
        text,
        html,
      };
      break;
    }
    // STORE só depois do FETCH terminar — durante o fetch outro comando pode quebrar Gmail/outros.
    if (mail && wasUnread && uid > 0) {
      try {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } catch (e) {
        console.warn('mail details mark read', e);
      }
    }
    await client.logout();
    res.json({ mail });
  } catch (e) {
    console.error('mail details', e);
    res.json({ mail: null });
  }
});

export default router;
