import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

const REF_PREFIX = 'REF-';
const REF_PAD = 5;

type DbLike = PrismaClient | Prisma.TransactionClient;

/**
 * Trava transacional por loja: serializa alocação de REF e criação do imóvel
 * para a mesma warehouse (evita REF duplicada sob concorrência).
 */
export async function lockWarehouseForRefAllocation(
  tx: Prisma.TransactionClient,
  warehouseId: string,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${warehouseId}::text))`);
}

/**
 * Próxima REF no formato REF-00001 (por imobiliária). Deve ser chamada dentro da mesma
 * transação em que {@link lockWarehouseForRefAllocation} foi aplicada, ou sozinha
 * para leitura aproximada (ex.: preview no formulário).
 */
export async function getNextRef(warehouseId: string, tx?: Prisma.TransactionClient): Promise<string> {
  const db: DbLike = tx ?? prisma;
  const list = await db.property.findMany({
    where: {
      warehouseId,
      ref: { not: null, startsWith: REF_PREFIX },
    },
    select: { ref: true },
    orderBy: { ref: 'desc' },
    take: 1,
  });

  let nextNum = 1;
  if (list.length > 0 && list[0].ref) {
    const match = list[0].ref.match(/^REF-0*(\d+)$/);
    if (match) {
      nextNum = parseInt(match[1], 10) + 1;
    }
  }

  return `${REF_PREFIX}${String(nextNum).padStart(REF_PAD, '0')}`;
}

/**
 * REF informada manualmente não pode colidir com outra da mesma loja.
 */
export async function assertRefAvailableInWarehouse(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  ref: string,
): Promise<void> {
  const existing = await tx.property.findFirst({
    where: { warehouseId, ref },
    select: { id: true },
  });
  if (existing) {
    const err = new Error('Esta referência já está em uso nesta imobiliária.');
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }
}

export function buildPropertySlugBase(title: string, slugifyFn: (s: string) => string): string {
  const base = slugifyFn(title) || 'imovel';
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${base}-${suffix}`;
}
