import { randomBytes } from 'node:crypto';

import type { Prisma } from '@prisma/client';

/** Gera código tipo SAX-A1B2C3D4E5F6 (12 hex após o prefixo). */
export function randomProtocolCode(): string {
  return `SAX-${randomBytes(6).toString('hex').toUpperCase()}`;
}

export async function generateUniqueProtocol(tx: Prisma.TransactionClient): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    const protocol = randomProtocolCode();
    const exists = await tx.helpDeskTicket.findUnique({
      where: { protocol },
      select: { id: true },
    });
    if (!exists) return protocol;
  }
  throw new Error('Não foi possível gerar protocolo único');
}
