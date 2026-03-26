import { randomUUID } from 'crypto';
import type { Router } from 'express';
import type { Request } from 'express';
import multer from 'multer';
import type { Prisma } from '@prisma/client';
import { uploadPublic, keys } from '../lib/storage.js';
import { validateImage, safeExtFromMime, SIZE } from '../lib/file-validation.js';
import { generateUniqueProtocol } from '../lib/helpdesk-protocol.js';
import { getScreenShareState, postScreenShareSignal } from '../lib/helpdesk-screen-share.js';
import { prisma } from '../lib/prisma.js';
import type { OwnerRequest } from '../middleware/ownerAuth.js';

const PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

const helpdeskOwnerImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SIZE.HELPDESK_IMAGE },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype);
    if (!ok) return cb(new Error('Apenas imagens (JPEG, PNG, GIF ou WebP)'));
    cb(null, true);
  },
});

async function nextTicketNumber(tx: Prisma.TransactionClient) {
  const agg = await tx.helpDeskTicket.aggregate({ _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

function formatUser(u: { id: string; name: string | null; email: string } | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email };
}

function formatTicket(t: {
  id: string;
  number: number;
  protocol: string;
  title: string;
  status: string;
  priority: string;
  queue: string;
  createdByStaff: boolean;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  proprietario: { id: string; nome: string; email: string | null };
  warehouse: { id: string; warehouseName: string } | null;
  assignedUser: { id: string; name: string | null; email: string } | null;
  _count?: { messages: number };
}) {
  return {
    id: t.id,
    number: t.number,
    protocol: t.protocol,
    title: t.title,
    status: t.status,
    priority: t.priority,
    queue: t.queue,
    createdByStaff: t.createdByStaff,
    firstMessageAt: t.firstMessageAt,
    lastMessageAt: t.lastMessageAt,
    closedAt: t.closedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    proprietario: { id: t.proprietario.id, nome: t.proprietario.nome, email: t.proprietario.email },
    warehouse: t.warehouse ? { id: t.warehouse.id, warehouse_name: t.warehouse.warehouseName } : null,
    assigned_user: formatUser(t.assignedUser),
    message_count: t._count?.messages,
  };
}

/**
 * Rotas do proprietário (já sob /api/proprietarios/portal e ownerAuth).
 * GET/POST /helpdesk/tickets etc.
 */
export function attachHelpdeskOwnerRoutes(router: Router) {
  router.get('/helpdesk/tickets', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
      const skip = (page - 1) * pageSize;

      const where: Prisma.HelpDeskTicketWhereInput = { proprietarioId: ownerId };

      const [total, rows] = await Promise.all([
        prisma.helpDeskTicket.count({ where }),
        prisma.helpDeskTicket.findMany({
          where,
          skip,
          take: pageSize,
          orderBy: { updatedAt: 'desc' },
          include: {
            proprietario: { select: { id: true, nome: true, email: true } },
            warehouse: { select: { id: true, warehouseName: true } },
            assignedUser: { select: { id: true, name: true, email: true } },
            _count: { select: { messages: true } },
          },
        }),
      ]);

      res.json({
        data: rows.map((r) => formatTicket(r)),
        total,
        page,
        pageSize,
      });
    } catch (e) {
      next(e);
    }
  });

  router.post('/helpdesk/tickets', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const body = req.body as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const queue = typeof body.queue === 'string' && body.queue.trim() ? body.queue.trim() : 'geral';
      const priority =
        typeof body.priority === 'string' && PRIORITIES.has(body.priority) ? body.priority : 'NORMAL';

      if (!title || !message) {
        res.status(400).json({ message: 'title e message são obrigatórios' });
        return;
      }

      const prop = await prisma.proprietario.findUnique({
        where: { id: ownerId },
        select: { id: true, warehouse_id: true },
      });
      if (!prop) {
        res.status(404).json({ message: 'Proprietário não encontrado' });
        return;
      }

      const ticket = await prisma.$transaction(async (tx) => {
        const number = await nextTicketNumber(tx);
        const protocol = await generateUniqueProtocol(tx);
        const now = new Date();
        const t = await tx.helpDeskTicket.create({
          data: {
            number,
            protocol,
            title,
            status: 'OPEN',
            priority,
            queue,
            proprietarioId: prop.id,
            warehouseId: prop.warehouse_id,
            createdByStaff: false,
            firstMessageAt: now,
            lastMessageAt: now,
          },
          include: {
            proprietario: { select: { id: true, nome: true, email: true } },
            warehouse: { select: { id: true, warehouseName: true } },
            assignedUser: { select: { id: true, name: true, email: true } },
            _count: { select: { messages: true } },
          },
        });

        await tx.helpDeskMessage.create({
          data: {
            ticketId: t.id,
            body: message,
            authorType: 'owner',
            readByOwnerAt: now,
          },
        });

        await tx.helpDeskTicketEvent.create({
          data: {
            ticketId: t.id,
            type: 'created',
            payload: JSON.stringify({ by: 'owner' }),
            actorUserId: null,
          },
        });

        return t;
      });

      res.status(201).json(formatTicket(ticket));
    } catch (e) {
      next(e);
    }
  });

  router.get('/helpdesk/tickets/:id', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const { id } = req.params;
      const row = await prisma.helpDeskTicket.findFirst({
        where: { id, proprietarioId: ownerId },
        include: {
          proprietario: { select: { id: true, nome: true, email: true } },
          warehouse: { select: { id: true, warehouseName: true } },
          assignedUser: { select: { id: true, name: true, email: true } },
          _count: { select: { messages: true } },
        },
      });
      if (!row) {
        res.status(404).json({ message: 'Ticket não encontrado' });
        return;
      }
      const firstStaff = await prisma.helpDeskMessage.findFirst({
        where: { ticketId: id, authorType: 'staff' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      res.json({
        ...formatTicket(row),
        first_staff_reply_at: firstStaff?.createdAt ?? null,
      });
    } catch (e) {
      next(e);
    }
  });

  router.get('/helpdesk/tickets/:id/messages', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const { id } = req.params;
      const ticket = await prisma.helpDeskTicket.findFirst({
        where: { id, proprietarioId: ownerId },
      });
      if (!ticket) {
        res.status(404).json({ message: 'Ticket não encontrado' });
        return;
      }

      const now = new Date();
      await prisma.helpDeskMessage.updateMany({
        where: { ticketId: id, authorType: 'staff', readByOwnerAt: null },
        data: { readByOwnerAt: now },
      });

      const messages = await prisma.helpDeskMessage.findMany({
        where: { ticketId: id },
        orderBy: { createdAt: 'asc' },
        include: { authorUser: { select: { id: true, name: true, email: true } } },
      });

      res.json({
        data: messages.map((m) => ({
          id: m.id,
          body: m.body,
          image_url: m.imageUrl ?? null,
          author_type: m.authorType,
          author_user: formatUser(m.authorUser),
          read_by_owner_at: m.readByOwnerAt,
          read_by_staff_at: m.readByStaffAt,
          created_at: m.createdAt,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.post(
    '/helpdesk/tickets/:id/messages',
    (req, res, next) => {
      const ct = String(req.headers['content-type'] ?? '');
      if (ct.includes('multipart/form-data')) {
        return helpdeskOwnerImageUpload.single('file')(req, res, (err) => {
          if (err) {
            res.status(400).json({ message: err instanceof Error ? err.message : 'Arquivo inválido' });
            return;
          }
          next();
        });
      }
      next();
    },
    async (req, res, next) => {
      try {
        const ownerId = String((req as OwnerRequest).ownerId ?? '');
        const { id } = req.params;
        const body = req.body as Record<string, unknown>;
        const text = typeof body.body === 'string' ? body.body.trim() : '';
        const uploaded = (req as Request & { file?: Express.Multer.File | undefined }).file;

        if (!text && !uploaded) {
          res.status(400).json({ message: 'Envie texto ou imagem' });
          return;
        }

        const ticket = await prisma.helpDeskTicket.findFirst({
          where: { id, proprietarioId: ownerId },
        });
        if (!ticket) {
          res.status(404).json({ message: 'Ticket não encontrado' });
          return;
        }
        if (ticket.status === 'CLOSED') {
          res.status(400).json({ message: 'Ticket encerrado' });
          return;
        }

        let imageUrl: string | null = null;
        if (uploaded) {
          const v = validateImage(uploaded.buffer, SIZE.HELPDESK_IMAGE);
          if (!v.ok) {
            res.status(422).json({ message: v.error });
            return;
          }
          const ext = safeExtFromMime(v.mime!);
          const key = keys.helpdeskImage(id, `${Date.now()}-${randomUUID()}${ext}`);
          imageUrl = await uploadPublic(key, uploaded.buffer, v.mime!);
        }

        const now = new Date();
        const msg = await prisma.$transaction(async (tx) => {
          const m = await tx.helpDeskMessage.create({
            data: {
              ticketId: id,
              body: text,
              imageUrl,
              authorType: 'owner',
              readByOwnerAt: now,
            },
          });
          await tx.helpDeskTicket.update({
            where: { id },
            data: {
              lastMessageAt: now,
            },
          });
          await tx.helpDeskTicketEvent.create({
            data: {
              ticketId: id,
              type: 'message',
              payload: JSON.stringify({ messageId: m.id, by: 'owner' }),
              actorUserId: null,
            },
          });
          return m;
        });

        res.status(201).json({
          id: msg.id,
          body: msg.body,
          image_url: msg.imageUrl ?? null,
          author_type: msg.authorType,
          created_at: msg.createdAt,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  /** GET /helpdesk/tickets/:id/screen-share/state — sinalização WebRTC (proprietário) */
  router.get('/helpdesk/tickets/:id/screen-share/state', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const { id } = req.params;
      const ticket = await prisma.helpDeskTicket.findFirst({
        where: { id, proprietarioId: ownerId },
      });
      if (!ticket) {
        res.status(404).json({ message: 'Ticket não encontrado' });
        return;
      }
      res.json(getScreenShareState(id));
    } catch (e) {
      next(e);
    }
  });

  /** POST /helpdesk/tickets/:id/screen-share/signal — oferta e ICE do proprietário */
  router.post('/helpdesk/tickets/:id/screen-share/signal', async (req, res, next) => {
    try {
      const ownerId = String((req as OwnerRequest).ownerId ?? '');
      const { id } = req.params;
      const ticket = await prisma.helpDeskTicket.findFirst({
        where: { id, proprietarioId: ownerId },
      });
      if (!ticket) {
        res.status(404).json({ message: 'Ticket não encontrado' });
        return;
      }
      const r = postScreenShareSignal(id, 'owner', req.body);
      if (!r.ok) {
        res.status(400).json({ message: r.error });
        return;
      }
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
}
