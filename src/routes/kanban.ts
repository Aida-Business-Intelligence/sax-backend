import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

type BoardState = {
  columns: { id: string; name: string }[];
  tasks: Record<string, unknown[]>;
  meta?: { nextTaskSeq?: number };
};

const EMPTY_BOARD: BoardState = { columns: [], tasks: {} };

function parseBoard(raw: string | null | undefined): BoardState {
  if (!raw || !String(raw).trim()) {
    return { columns: [], tasks: {} };
  }
  try {
    const parsed = JSON.parse(raw) as { columns?: unknown; tasks?: unknown };
    const columns = Array.isArray(parsed.columns)
      ? parsed.columns
          .filter((c): c is { id: string; name: string } => c != null && typeof c === 'object' && 'id' in c && 'name' in c)
          .map((c) => ({ id: String((c as { id: unknown }).id), name: String((c as { name: unknown }).name) }))
      : [];
    const tasks: Record<string, unknown[]> = {};
    if (parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks)) {
      for (const [k, v] of Object.entries(parsed.tasks as Record<string, unknown>)) {
        tasks[k] = Array.isArray(v) ? v : [];
      }
    }
    let meta: { nextTaskSeq?: number } | undefined;
    if (parsed && typeof parsed === 'object' && 'meta' in parsed) {
      const m = (parsed as { meta?: unknown }).meta;
      if (m && typeof m === 'object' && !Array.isArray(m) && 'nextTaskSeq' in m) {
        const n = Number((m as { nextTaskSeq: unknown }).nextTaskSeq);
        if (Number.isFinite(n)) meta = { nextTaskSeq: n };
      }
    }
    return { columns, tasks, ...(meta ? { meta } : {}) };
  } catch {
    return { columns: [], tasks: {} };
  }
}

function validateBoardPayload(body: unknown): BoardState | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { columns?: unknown; tasks?: unknown };
  if (!Array.isArray(b.columns)) return null;
  if (!b.tasks || typeof b.tasks !== 'object' || Array.isArray(b.tasks)) return null;
  const columns = b.columns
    .filter((c): c is { id: unknown; name: unknown } => c != null && typeof c === 'object' && 'id' in c && 'name' in c)
    .map((c) => ({ id: String(c.id), name: String(c.name) }));
  const rawTasks = b.tasks as Record<string, unknown>;
  const tasks: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(rawTasks)) {
    tasks[k] = Array.isArray(v) ? v : [];
  }
  let meta: { nextTaskSeq: number } | undefined;
  const rawMeta = (b as { meta?: unknown }).meta;
  if (rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) && 'nextTaskSeq' in rawMeta) {
    const n = Number((rawMeta as { nextTaskSeq: unknown }).nextTaskSeq);
    if (Number.isFinite(n)) meta = { nextTaskSeq: n };
  }
  return { columns, tasks, ...(meta ? { meta } : {}) };
}

function normalizeTaskName(name: unknown): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function validateUniqueTaskNames(board: BoardState): string | null {
  const seen = new Map<string, string>();
  for (const col of board.columns) {
    const list = board.tasks[col.id] ?? [];
    for (const raw of list) {
      if (raw == null || typeof raw !== 'object') continue;
      const t = raw as { id?: unknown; name?: unknown };
      const id = String(t.id ?? '');
      const nm = normalizeTaskName(t.name);
      if (!nm) continue;
      const prevId = seen.get(nm);
      if (prevId !== undefined && prevId !== id) {
        return 'Já existe uma tarefa com este nome.';
      }
      seen.set(nm, id);
    }
  }
  return null;
}

type Authed = Request & { user: { id: string; warehouseId: string | null } };

async function assertWorkspaceMember(workspaceId: string, userId: string) {
  return prisma.kanbanWorkspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
}

async function assertWorkspaceAdmin(workspaceId: string, userId: string) {
  const m = await prisma.kanbanWorkspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return m?.role === 'admin' ? m : null;
}

/**
 * GET /api/kanban/workspaces
 * Lista espaços onde o usuário é membro.
 */
router.get('/workspaces', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaces = await prisma.kanbanWorkspace.findMany({
      where: { members: { some: { userId: user.id } } },
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
      },
    });
    res.json({ workspaces });
  } catch (e) {
    console.error('[kanban workspaces list]', e);
    res.status(500).json({ message: 'Erro ao listar espaços de trabalho.' });
  }
});

/**
 * POST /api/kanban/workspaces
 * Cria espaço + quadro vazio + criador como admin.
 */
router.post('/workspaces', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const body = (req.body || {}) as { name?: string; key?: string | null; warehouseId?: string | null };
    const name = String(body.name ?? '').trim();
    if (!name) {
      res.status(400).json({ message: 'Nome do espaço é obrigatório.' });
      return;
    }
    const warehouseId = body.warehouseId != null && String(body.warehouseId).trim()
      ? String(body.warehouseId).trim()
      : user.warehouseId;

    const keyRaw = body.key != null ? String(body.key).trim().slice(0, 16) : '';
    const key = keyRaw.length > 0 ? keyRaw : null;

    const workspace = await prisma.$transaction(async (tx) => {
      const w = await tx.kanbanWorkspace.create({
        data: {
          name,
          key,
          createdById: user.id,
          warehouseId,
          members: {
            create: { userId: user.id, role: 'admin' },
          },
          board: {
            create: { stateJson: JSON.stringify(EMPTY_BOARD) },
          },
        },
        include: {
          members: {
            include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
          },
        },
      });
      return w;
    });

    res.json({ workspace });
  } catch (e) {
    console.error('[kanban workspace create]', e);
    res.status(500).json({ message: 'Erro ao criar espaço de trabalho.' });
  }
});

/**
 * PATCH /api/kanban/workspaces/:id
 * Atualiza nome/chave (apenas admin).
 */
router.patch('/workspaces/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    if (!workspaceId) {
      res.status(400).json({ message: 'ID inválido.' });
      return;
    }
    const admin = await assertWorkspaceAdmin(workspaceId, user.id);
    if (!admin) {
      res.status(403).json({ message: 'Apenas administradores do espaço podem editá-lo.' });
      return;
    }
    const body = (req.body || {}) as { name?: string; key?: string | null };
    const name = body.name != null ? String(body.name).trim() : undefined;
    const key =
      body.key === null
        ? null
        : body.key !== undefined
          ? String(body.key).trim().slice(0, 16) || null
          : undefined;
    if (name === '') {
      res.status(400).json({ message: 'Nome inválido.' });
      return;
    }
    const updated = await prisma.kanbanWorkspace.update({
      where: { id: workspaceId },
      data: {
        ...(name !== undefined && { name }),
        ...(key !== undefined && { key }),
      },
    });
    res.json({ workspace: updated });
  } catch (e) {
    console.error('[kanban workspace patch]', e);
    res.status(500).json({ message: 'Erro ao atualizar espaço.' });
  }
});

/**
 * DELETE /api/kanban/workspaces/:id
 * Remove espaço (apenas admin). Cascade apaga quadro e membros.
 */
router.delete('/workspaces/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const admin = await assertWorkspaceAdmin(workspaceId, user.id);
    if (!admin) {
      res.status(403).json({ message: 'Apenas administradores podem excluir o espaço.' });
      return;
    }
    await prisma.kanbanWorkspace.delete({ where: { id: workspaceId } });
    res.json({ success: true });
  } catch (e) {
    console.error('[kanban workspace delete]', e);
    res.status(500).json({ message: 'Erro ao excluir espaço.' });
  }
});

/**
 * GET /api/kanban/workspaces/:id/board
 */
router.get('/workspaces/:id/board', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const m = await assertWorkspaceMember(workspaceId, user.id);
    if (!m) {
      res.status(404).json({ message: 'Espaço não encontrado ou sem acesso.' });
      return;
    }
    const boardRow = await prisma.kanbanBoard.findUnique({ where: { workspaceId } });
    if (!boardRow) {
      res.json({ board: EMPTY_BOARD });
      return;
    }
    res.json({ board: parseBoard(boardRow.stateJson) });
  } catch (e) {
    console.error('[kanban GET board]', e);
    res.status(500).json({ message: 'Erro ao carregar o quadro Kanban.' });
  }
});

/**
 * PUT /api/kanban/workspaces/:id/board
 */
router.put('/workspaces/:id/board', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const m = await assertWorkspaceMember(workspaceId, user.id);
    if (!m) {
      res.status(404).json({ message: 'Espaço não encontrado ou sem acesso.' });
      return;
    }
    const board = (req.body as { board?: unknown })?.board;
    const valid = validateBoardPayload(board);
    if (!valid) {
      res.status(400).json({ message: 'Body inválido. Envie { board: { columns: [], tasks: {} } }.' });
      return;
    }
    const dup = validateUniqueTaskNames(valid);
    if (dup) {
      res.status(400).json({ message: dup });
      return;
    }
    const stateJson = JSON.stringify(valid);
    await prisma.kanbanBoard.upsert({
      where: { workspaceId },
      create: { workspaceId, stateJson },
      update: { stateJson },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[kanban PUT board]', e);
    res.status(500).json({ message: 'Erro ao salvar o quadro Kanban.' });
  }
});

/**
 * GET /api/kanban/workspaces/:id/members
 */
router.get('/workspaces/:id/members', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const m = await assertWorkspaceMember(workspaceId, user.id);
    if (!m) {
      res.status(404).json({ message: 'Espaço não encontrado ou sem acesso.' });
      return;
    }
    const members = await prisma.kanbanWorkspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    });
    res.json({ members });
  } catch (e) {
    console.error('[kanban members list]', e);
    res.status(500).json({ message: 'Erro ao listar membros.' });
  }
});

/**
 * POST /api/kanban/workspaces/:id/members
 * Body: { userId: string } — apenas admin. Utilizador deve existir e (idealmente) mesma warehouse.
 */
router.post('/workspaces/:id/members', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const admin = await assertWorkspaceAdmin(workspaceId, user.id);
    if (!admin) {
      res.status(403).json({ message: 'Apenas administradores podem adicionar membros.' });
      return;
    }
    const targetUserId = String((req.body as { userId?: string })?.userId ?? '').trim();
    if (!targetUserId) {
      res.status(400).json({ message: 'userId é obrigatório.' });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target || !target.active) {
      res.status(400).json({ message: 'Utilizador não encontrado ou inativo.' });
      return;
    }
    const ws = await prisma.kanbanWorkspace.findUnique({ where: { id: workspaceId } });
    if (ws?.warehouseId && target.warehouseId && ws.warehouseId !== target.warehouseId) {
      res.status(400).json({ message: 'O utilizador pertence a outra loja.' });
      return;
    }
    await prisma.kanbanWorkspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      create: { workspaceId, userId: targetUserId, role: 'member' },
      update: {},
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[kanban member add]', e);
    res.status(500).json({ message: 'Erro ao adicionar membro.' });
  }
});

/**
 * DELETE /api/kanban/workspaces/:id/members/:userId
 */
router.delete('/workspaces/:id/members/:userId', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Authed).user;
    const workspaceId = (req.params.id || '').trim();
    const targetUserId = (req.params.userId || '').trim();
    const admin = await assertWorkspaceAdmin(workspaceId, user.id);
    if (!admin) {
      res.status(403).json({ message: 'Apenas administradores podem remover membros.' });
      return;
    }
    if (targetUserId === user.id) {
      res.status(400).json({ message: 'Não é possível remover a si mesmo. Transfira o admin ou peça a outro admin.' });
      return;
    }
    await prisma.kanbanWorkspaceMember.deleteMany({
      where: { workspaceId, userId: targetUserId },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[kanban member remove]', e);
    res.status(500).json({ message: 'Erro ao remover membro.' });
  }
});

export default router;
