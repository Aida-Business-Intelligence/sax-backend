import type { Prisma } from '@prisma/client';

export type PropertyListFilterInput = {
  search?: string;
  ref?: string;
  transactionType?: string;
  propertyType?: string;
  /** UF (select); cidade/bairro entram na busca geral (`search`). */
  state?: string;
};

/**
 * Monta o `where` do Prisma para listagem de imóveis (PDV + portal proprietário).
 */
export function buildPropertyListWhere(
  base: Prisma.PropertyWhereInput,
  filters: PropertyListFilterInput,
): Prisma.PropertyWhereInput {
  const parts: Prisma.PropertyWhereInput[] = [];

  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  if (search) {
    parts.push({
      OR: [
        { title: { contains: search, mode: 'insensitive' } },
        { ref: { contains: search, mode: 'insensitive' } },
        { address: { contains: search, mode: 'insensitive' } },
        { numero: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
        { neighborhood: { contains: search, mode: 'insensitive' } },
        { state: { contains: search, mode: 'insensitive' } },
      ],
    });
  }

  const refOnly = typeof filters.ref === 'string' ? filters.ref.trim() : '';
  if (refOnly) {
    parts.push({ ref: { contains: refOnly, mode: 'insensitive' } });
  }

  const propertyType = typeof filters.propertyType === 'string' ? filters.propertyType.trim() : '';
  if (propertyType) {
    parts.push({ propertyType });
  }

  const state = typeof filters.state === 'string' ? filters.state.trim() : '';
  if (state) {
    parts.push(
      state.length <= 2
        ? { state: { equals: state.toUpperCase(), mode: 'insensitive' } }
        : { state: { contains: state, mode: 'insensitive' } },
    );
  }

  const transactionType =
    typeof filters.transactionType === 'string' ? filters.transactionType.trim() : '';
  if (transactionType) {
    parts.push({
      OR: [{ type: transactionType }, { transactionTypes: { contains: transactionType } }],
    });
  }

  if (parts.length === 0) return base;
  return { AND: [base, ...parts] };
}
