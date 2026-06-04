import { prisma } from './prisma.js';

export type ThreadMessage = {
  id: string;
  from: 'operator' | 'visitor';
  kind?: 'popup' | 'chat';
  body: string;
  createdAt: string;
};

/** Mescla mensagens do operador (live_visitor_messages) e respostas do visitante. */
export async function getLiveChatThread(sessionId: string): Promise<ThreadMessage[]> {
  const [fromOp, fromVisitor] = await Promise.all([
    prisma.liveVisitorMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: { id: true, kind: true, body: true, createdAt: true },
    }),
    prisma.visitorChatReply.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: { id: true, body: true, createdAt: true },
    }),
  ]);

  const merged: ThreadMessage[] = [];
  for (const m of fromOp) {
    const k = m.kind === 'chat' ? 'chat' : 'popup';
    merged.push({
      id: `op:${m.id}`,
      from: 'operator',
      kind: k,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    });
  }
  for (const v of fromVisitor) {
    merged.push({
      id: `vis:${v.id}`,
      from: 'visitor',
      body: v.body,
      createdAt: v.createdAt.toISOString(),
    });
  }
  merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return merged;
}
