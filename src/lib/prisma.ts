import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Em dev, o singleton global pode ficar preso a um PrismaClient gerado *antes* de
 * `prisma generate` (ex.: novos models). Delegates em falta ficam `undefined` e as rotas /api/kanban rebentam com findMany/findUnique.
 */
function isClientStale(client: PrismaClient | undefined): boolean {
  if (!client) return true;
  const d = client as unknown as {
    kanbanBoard?: { findUnique?: unknown };
    kanbanWorkspace?: { findMany?: unknown };
  };
  return (
    typeof d.kanbanBoard?.findUnique !== 'function' ||
    typeof d.kanbanWorkspace?.findMany !== 'function'
  );
}

let cached = globalForPrisma.prisma;
if (cached && isClientStale(cached)) {
  void cached.$disconnect();
  cached = undefined;
  globalForPrisma.prisma = undefined;
}

export const prisma = cached ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/** Falha rápida com mensagem útil em vez de `undefined.findMany` nas rotas. */
const p = prisma as unknown as { kanbanWorkspace?: { findMany?: unknown } };
if (typeof p.kanbanWorkspace?.findMany !== 'function') {
  throw new Error(
    '[prisma] Cliente desatualizado: na pasta sax-backend execute `npx prisma generate` e reinicie o servidor (pare o `tsx watch` se der EPERM no Windows).'
  );
}
