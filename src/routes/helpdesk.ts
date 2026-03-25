import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { generateUniqueProtocol } from '../lib/helpdesk-protocol.js';
import { getScreenShareState, postScreenShareSignal } from '../lib/helpdesk-screen-share.js';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

const STATUSES = new Set(['OPEN', 'PENDING', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
const PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

router.use(authMiddleware);

async function nextTicketNumber(tx: Prisma.TransactionClient) {
  const agg = await tx.helpDeskTicket.aggregate({ _max: { number: true } });
  return (agg._max.number ?? 0) + 1;
}

function formatUser(u: { id: string; name: string | null; email: string } | null) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email };
}

function formatTicket(
  t: {
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
    createdByUser: { id: string; name: string | null; email: string } | null;
    _count?: { messages: number };
  },
  opts?: { messageCount?: boolean },
) {
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
    created_by_user: formatUser(t.createdByUser),
    message_count: opts?.messageCount !== false && t._count ? t._count.messages : undefined,
  };
}

async function appendEvent(
  ticketId: string,
  type: string,
  payload: Record<string, unknown>,
  actorUserId: string | null,
) {
  await prisma.helpDeskTicketEvent.create({
    data: {
      ticketId,
      type,
      payload: JSON.stringify(payload),
      actorUserId,
    },
  });
}

/** GET /api/helpdesk/meta */
router.get('/meta', async (_req, res, next) => {
  try {
    const queues = await prisma.helpDeskTicket.findMany({
      select: { queue: true },
      distinct: ['queue'],
      orderBy: { queue: 'asc' },
    });
    const byStatus = await prisma.helpDeskTicket.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    res.json({
      queues: queues.map((q) => q.queue),
      countsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/helpdesk/tickets */
router.get('/tickets', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const skip = (page - 1) * pageSize;
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const priority = typeof req.query.priority === 'string' ? req.query.priority.trim() : '';
    const queue = typeof req.query.queue === 'string' ? req.query.queue.trim() : '';
    const assignedUserId = typeof req.query.assigned_user_id === 'string' ? req.query.assigned_user_id.trim() : '';
    const proprietarioId = typeof req.query.proprietario_id === 'string' ? req.query.proprietario_id.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where: Prisma.HelpDeskTicketWhereInput = {};
    if (status && STATUSES.has(status)) where.status = status;
    if (priority && PRIORITIES.has(priority)) where.priority = priority;
    if (queue) where.queue = queue;
    if (assignedUserId) where.assignedUserId = assignedUserId;
    if (proprietarioId) where.proprietarioId = proprietarioId;
    if (search) {
      const term = search.trim();
      const n = Number(term);
      const or: Prisma.HelpDeskTicketWhereInput[] = [
        { title: { contains: term, mode: 'insensitive' } },
        { protocol: { contains: term, mode: 'insensitive' } },
      ];
      if (Number.isFinite(n) && String(n) === term) {
        or.push({ number: n });
      }
      where.OR = or;
    }

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
          createdByUser: { select: { id: true, name: true, email: true } },
          _count: { select: { messages: true } },
        },
      }),
    ]);

    res.json({
      data: rows.map((r) => formatTicket(r, { messageCount: true })),
      total,
      page,
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

/** POST /api/helpdesk/tickets — abertura manual pelo staff */
router.post('/tickets', async (req, res, next) => {
  try {
    const user = (req as unknown as { user: { id: string } }).user;
    const body = req.body as Record<string, unknown>;
    const proprietarioId = typeof body.proprietario_id === 'string' ? body.proprietario_id.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const queue = typeof body.queue === 'string' && body.queue.trim() ? body.queue.trim() : 'geral';
    const priority = typeof body.priority === 'string' && PRIORITIES.has(body.priority) ? body.priority : 'NORMAL';
    const firstMessage = typeof body.message === 'string' ? body.message.trim() : '';

    if (!proprietarioId || !title) {
      res.status(400).json({ message: 'proprietario_id e title são obrigatórios' });
      return;
    }

    const prop = await prisma.proprietario.findUnique({
      where: { id: proprietarioId },
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
          createdByStaff: true,
          createdByUserId: user.id,
          firstMessageAt: firstMessage ? now : null,
          lastMessageAt: firstMessage ? now : null,
        },
        include: {
          proprietario: { select: { id: true, nome: true, email: true } },
          warehouse: { select: { id: true, warehouseName: true } },
          assignedUser: { select: { id: true, name: true, email: true } },
          createdByUser: { select: { id: true, name: true, email: true } },
          _count: { select: { messages: true } },
        },
      });

      await tx.helpDeskTicketEvent.create({
        data: {
          ticketId: t.id,
          type: 'created',
          payload: JSON.stringify({ manual: true, by: user.id }),
          actorUserId: user.id,
        },
      });

      if (firstMessage) {
        await tx.helpDeskMessage.create({
          data: {
            ticketId: t.id,
            body: firstMessage,
            authorType: 'staff',
            authorUserId: user.id,
            readByStaffAt: now,
          },
        });
      }

      return t;
    });

    res.status(201).json(formatTicket(ticket, { messageCount: true }));
  } catch (e) {
    next(e);
  }
});

/** GET /api/helpdesk/tickets/:id */
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const row = await prisma.helpDeskTicket.findUnique({
      where: { id },
      include: {
        proprietario: { select: { id: true, nome: true, email: true, telefone: true } },
        warehouse: { select: { id: true, warehouseName: true } },
        assignedUser: { select: { id: true, name: true, email: true } },
        createdByUser: { select: { id: true, name: true, email: true } },
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
      ...formatTicket(row, { messageCount: true }),
      first_staff_reply_at: firstStaff?.createdAt ?? null,
    });
  } catch (e) {
    next(e);
  }
});

/** PATCH /api/helpdesk/tickets/:id */
router.patch('/tickets/:id', async (req, res, next) => {
  try {
    const user = (req as unknown as { user: { id: string } }).user;
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;

    const existing = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }

    const data: Prisma.HelpDeskTicketUncheckedUpdateInput = {};
    if (typeof body.status === 'string' && STATUSES.has(body.status) && body.status !== existing.status) {
      data.status = body.status;
      if (body.status === 'CLOSED' || body.status === 'RESOLVED') {
        data.closedAt = new Date();
      } else if (body.status === 'OPEN' || body.status === 'PENDING' || body.status === 'IN_PROGRESS') {
        data.closedAt = null;
      }
    }
    if (typeof body.priority === 'string' && PRIORITIES.has(body.priority) && body.priority !== existing.priority) {
      data.priority = body.priority;
    }
    if (typeof body.queue === 'string' && body.queue.trim() && body.queue.trim() !== existing.queue) {
      data.queue = body.queue.trim();
    }
    let assignFrom: string | null | undefined;
    let assignTo: string | null | undefined;
    if ('assigned_user_id' in body) {
      const raw = body.assigned_user_id;
      if (raw === null || raw === '') {
        if (existing.assignedUserId) {
          data.assignedUserId = null;
          assignFrom = existing.assignedUserId;
          assignTo = null;
        }
      } else if (typeof raw === 'string' && raw.trim()) {
        const assignee = await prisma.user.findUnique({ where: { id: raw.trim() } });
        if (!assignee) {
          res.status(400).json({ message: 'Usuário atribuído não encontrado' });
          return;
        }
        if (assignee.id !== existing.assignedUserId) {
          data.assignedUserId = assignee.id;
          assignFrom = existing.assignedUserId ?? null;
          assignTo = assignee.id;
        }
      }
    }

    if (Object.keys(data).length === 0) {
      res.status(400).json({ message: 'Nenhum campo para atualizar' });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.helpDeskTicket.update({
        where: { id },
        data,
        include: {
          proprietario: { select: { id: true, nome: true, email: true } },
          warehouse: { select: { id: true, warehouseName: true } },
          assignedUser: { select: { id: true, name: true, email: true } },
          createdByUser: { select: { id: true, name: true, email: true } },
          _count: { select: { messages: true } },
        },
      });

      if (body.status && body.status !== existing.status) {
        await tx.helpDeskTicketEvent.create({
          data: {
            ticketId: id,
            type: 'status_change',
            payload: JSON.stringify({ from: existing.status, to: body.status }),
            actorUserId: user.id,
          },
        });
      }
      if (body.priority && body.priority !== existing.priority) {
        await tx.helpDeskTicketEvent.create({
          data: {
            ticketId: id,
            type: 'priority_change',
            payload: JSON.stringify({ from: existing.priority, to: body.priority }),
            actorUserId: user.id,
          },
        });
      }
      if (body.queue && String(body.queue).trim() !== existing.queue) {
        await tx.helpDeskTicketEvent.create({
          data: {
            ticketId: id,
            type: 'queue_change',
            payload: JSON.stringify({ from: existing.queue, to: String(body.queue).trim() }),
            actorUserId: user.id,
          },
        });
      }
      if (assignFrom !== undefined) {
        await tx.helpDeskTicketEvent.create({
          data: {
            ticketId: id,
            type: 'assign',
            payload: JSON.stringify({ from: assignFrom, to: assignTo }),
            actorUserId: user.id,
          },
        });
      }

      return row;
    });

    const firstStaff = await prisma.helpDeskMessage.findFirst({
      where: { ticketId: id, authorType: 'staff' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    res.json({
      ...formatTicket(updated, { messageCount: true }),
      first_staff_reply_at: firstStaff?.createdAt ?? null,
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/helpdesk/tickets/:id/messages */
router.get('/tickets/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ticket = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }

    const now = new Date();
    await prisma.helpDeskMessage.updateMany({
      where: { ticketId: id, authorType: 'owner', readByStaffAt: null },
      data: { readByStaffAt: now },
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

/** POST /api/helpdesk/tickets/:id/messages */
router.post('/tickets/:id/messages', async (req, res, next) => {
  try {
    const user = (req as unknown as { user: { id: string } }).user;
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) {
      res.status(400).json({ message: 'Mensagem é obrigatória' });
      return;
    }

    const ticket = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }
    if (ticket.status === 'CLOSED') {
      res.status(400).json({ message: 'Ticket encerrado' });
      return;
    }

    const now = new Date();
    const msg = await prisma.$transaction(async (tx) => {
      const m = await tx.helpDeskMessage.create({
        data: {
          ticketId: id,
          body: text,
          authorType: 'staff',
          authorUserId: user.id,
          readByStaffAt: now,
        },
        include: {
          authorUser: { select: { id: true, name: true, email: true } },
        },
      });

      const ticketUpdate: Prisma.HelpDeskTicketUncheckedUpdateInput = {
        lastMessageAt: now,
        firstMessageAt: ticket.firstMessageAt ?? now,
      };
      if (ticket.status === 'OPEN') {
        ticketUpdate.status = 'IN_PROGRESS';
      }
      await tx.helpDeskTicket.update({
        where: { id },
        data: ticketUpdate,
      });

      await tx.helpDeskTicketEvent.create({
        data: {
          ticketId: id,
          type: 'message',
          payload: JSON.stringify({ messageId: m.id }),
          actorUserId: user.id,
        },
      });
      return m;
    });

    res.status(201).json({
      id: msg.id,
      body: msg.body,
      author_type: msg.authorType,
      author_user: formatUser(msg.authorUser),
      read_by_owner_at: msg.readByOwnerAt,
      read_by_staff_at: msg.readByStaffAt,
      created_at: msg.createdAt,
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/helpdesk/tickets/:id/events */
router.get('/tickets/:id/events', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ticket = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }
    const events = await prisma.helpDeskTicketEvent.findMany({
      where: { ticketId: id },
      orderBy: { createdAt: 'asc' },
    });
    const actorIds = [...new Set(events.map((e) => e.actorUserId).filter(Boolean))] as string[];
    const actors =
      actorIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    res.json({
      data: events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload ? JSON.parse(e.payload) : null,
        actor_user_id: e.actorUserId,
        actor_user: e.actorUserId ? actorMap.get(e.actorUserId) ?? null : null,
        created_at: e.createdAt,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/helpdesk/tickets/:id/screen-share/state — sinalização WebRTC (atendente) */
router.get('/tickets/:id/screen-share/state', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ticket = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }
    res.json(getScreenShareState(id));
  } catch (e) {
    next(e);
  }
});

/** POST /api/helpdesk/tickets/:id/screen-share/signal — resposta e ICE do atendente */
router.post('/tickets/:id/screen-share/signal', async (req, res, next) => {
  try {
    const { id } = req.params;
    const ticket = await prisma.helpDeskTicket.findUnique({ where: { id } });
    if (!ticket) {
      res.status(404).json({ message: 'Ticket não encontrado' });
      return;
    }
    const r = postScreenShareSignal(id, 'staff', req.body);
    if (!r.ok) {
      res.status(400).json({ message: r.error });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export default router;
