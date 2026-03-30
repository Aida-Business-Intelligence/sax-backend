import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Em dev, o singleton global pode ficar preso a um PrismaClient gerado *antes* de
 * `prisma generate` (ex.: novo model). Nesse caso `prisma.kanbanBoard` fica undefined e as rotas /api/kanban retornam 500.
 */
function isClientMissingKanbanDelegate(client: PrismaClient | undefined): boolean {
  if (!client) return true;
  const d = client as unknown as { kanbanBoard?: { findUnique?: unknown } };
  return typeof d.kanbanBoard?.findUnique !== 'function';
}

let cached = globalForPrisma.prisma;
if (cached && isClientMissingKanbanDelegate(cached)) {
  void cached.$disconnect();
  cached = undefined;
  globalForPrisma.prisma = undefined;
}

export const prisma = cached ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
