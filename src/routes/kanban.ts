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
    if (parsed && typeof parsed === "object" && "meta" in parsed) {
      const m = (parsed as { meta?: unknown }).meta;
      if (m && typeof m === "object" && !Array.isArray(m) && "nextTaskSeq" in m) {
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
  if (rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta) && "nextTaskSeq" in rawMeta) {
    const n = Number((rawMeta as { nextTaskSeq: unknown }).nextTaskSeq);
    if (Number.isFinite(n)) meta = { nextTaskSeq: n };
  }
  return { columns, tasks, ...(meta ? { meta } : {}) };
}

function normalizeTaskName(name: unknown): string {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Nomes de tarefas principais únicos (subtarefas não entram). */
function validateUniqueTaskNames(board: BoardState): string | null {
  const seen = new Map<string, string>();
  for (const col of board.columns) {
    const list = board.tasks[col.id] ?? [];
    for (const raw of list) {
      if (raw == null || typeof raw !== "object") continue;
      const t = raw as { id?: unknown; name?: unknown };
      const id = String(t.id ?? "");
      const nm = normalizeTaskName(t.name);
      if (!nm) continue;
      const prevId = seen.get(nm);
      if (prevId !== undefined && prevId !== id) {
        return "Já existe uma tarefa com este nome.";
      }
      seen.set(nm, id);
    }
  }
  return null;
}

/**
 * GET /api/kanban/
 * Quadro do usuário logado (JWT).
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: { id: string } }).user;
    const row = await prisma.kanbanBoard.findUnique({
      where: { userId: user.id },
    });
    if (!row) {
      res.json({ board: EMPTY_BOARD });
      return;
    }
    res.json({ board: parseBoard(row.stateJson) });
  } catch (e) {
    const err = e as Error;
    console.error('[kanban GET]', err?.message ?? e);
    const hint =
      typeof (prisma as unknown as { kanbanBoard?: unknown }).kanbanBoard === 'undefined'
        ? ' Rode `npx prisma generate` e reinicie o servidor.'
        : '';
    res.status(500).json({ message: `Erro ao carregar o quadro Kanban.${hint}` });
  }
});

/**
 * PUT /api/kanban/
 * Salva o quadro completo. Body: { board: { columns, tasks } }
 */
router.put('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: { id: string } }).user;
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
      where: { userId: user.id },
      create: { userId: user.id, stateJson },
      update: { stateJson },
    });
    res.json({ success: true });
  } catch (e) {
    const err = e as Error;
    console.error('[kanban PUT]', err?.message ?? e);
    const hint =
      typeof (prisma as unknown as { kanbanBoard?: unknown }).kanbanBoard === 'undefined'
        ? ' Rode `npx prisma generate` e reinicie o servidor.'
        : '';
    res.status(500).json({ message: `Erro ao salvar o quadro Kanban.${hint}` });
  }
});

export default router;
