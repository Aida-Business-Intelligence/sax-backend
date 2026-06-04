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
    finOrigin?: { findMany?: unknown };
    liveVisitorMessage?: { create?: unknown };
    visitorChatReply?: { create?: unknown };
  };
  return (
    typeof d.kanbanBoard?.findUnique !== 'function' ||
    typeof d.kanbanWorkspace?.findMany !== 'function' ||
    typeof d.finOrigin?.findMany !== 'function' ||
    typeof d.liveVisitorMessage?.create !== 'function' ||
    typeof d.visitorChatReply?.create !== 'function'
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

/** Falha rápida com mensagem útil em vez de `undefined.findMany` / `undefined.create` nas rotas. */
const p = prisma as unknown as {
  kanbanWorkspace?: { findMany?: unknown };
  liveVisitorMessage?: { create?: unknown };
};
if (typeof p.kanbanWorkspace?.findMany !== 'function') {
  throw new Error(
    '[prisma] Cliente desatualizado: na pasta sax-backend execute `npx prisma generate` e reinicie o servidor (pare o `tsx watch` se der EPERM no Windows).'
  );
}
if (typeof p.liveVisitorMessage?.create !== 'function') {
  throw new Error(
    '[prisma] Mensagens ao vivo: o Prisma Client não tem o modelo LiveVisitorMessage. Execute `npx prisma generate` na pasta sax-backend, aplique a migration `live_visitor_messages` (`npx prisma migrate deploy`) e reinicie a API.'
  );
}
const q = prisma as unknown as { visitorChatReply?: { create?: unknown } };
if (typeof q.visitorChatReply?.create !== 'function') {
  throw new Error(
    '[prisma] Chat visitante: o Prisma Client não tem VisitorChatReply. Execute `npx prisma generate` e a migration `visitor_chat_replies`.'
  );
}