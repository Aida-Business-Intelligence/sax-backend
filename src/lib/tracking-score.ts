import { prisma } from './prisma.js';

/** Pontos por tipo de evento (intenção de compra) — mesma regra de `tracking.ts`. */
export const TRACKING_SCORE_RULES: Record<string, number> = {
  PAGE_VIEW: 1,
  VIEW_PROPERTY: 5,
  CLICK_WHATSAPP: 20,
  RETURN_VISIT: 10,
};

/**
 * Soma pontos de todos os eventos de tracking do visitante (score de intenção).
 */
export async function calculateVisitorIntentScore(visitorId: string): Promise<number> {
  const events = await prisma.trackingEvent.findMany({
    where: { visitorId },
    select: { type: true },
  });
  let total = 0;
  for (const e of events) {
    const points = TRACKING_SCORE_RULES[e.type];
    if (typeof points === 'number') total += points;
  }
  return total;
}

/** Temperatura: score > 50 → hot, > 20 → warm, senão cold */
export function getLeadTemperature(score: number): 'cold' | 'warm' | 'hot' {
  if (score > 50) return 'hot';
  if (score > 20) return 'warm';
  return 'cold';
}
