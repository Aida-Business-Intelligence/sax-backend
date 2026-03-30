import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { getWarehousePdvSettings, mergeWarehousePdvSettings } from './pdv-warehouse-settings.js';

/** Configuração persistida em Warehouse.pdv_settings_json → lead_distribution_settings */
export type LeadDistributionRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** Menor número = avaliado primeiro */
  priority: number;
  match: {
    /** Vazio = qualquer origem (site, meta_ads, manual, google_ads, …) */
    sources: string[];
    /** Substring em adLocation, notes, sourceDetail (sem case) */
    regionContains: string;
    /** UF 2 letras, ex.: SC */
    stateUf: string;
    minScore: number | null;
    maxScore: number | null;
  };
  assign: {
    /** Rodízio na ordem do array ou menor carga */
    mode: 'round_robin' | 'least_loaded';
    /** Usuários elegíveis nesta regra (ordem importa no round-robin) */
    userIds: string[];
  };
};

export type LeadDistributionConfig = {
  enabled: boolean;
  /** Funções (Role.id) que podem receber leads automaticamente. Vazio = todos os usuários ativos da loja. */
  eligibleRoleIds: string[];
  /** Estratégia quando nenhuma regra específica casa (fallback interno) */
  defaultStrategy: 'round_robin' | 'least_loaded' | 'weighted_avg_ticket';
  rules: LeadDistributionRule[];
  fallback: {
    type: 'unassigned' | 'users' | 'role_pool';
    userIds: string[];
    roleId: string | null;
  };
  /** Índice por chave (ex.: rule id ou "default") para round-robin */
  roundRobinState: Record<string, number>;
};

export const DEFAULT_LEAD_DISTRIBUTION: LeadDistributionConfig = {
  enabled: false,
  eligibleRoleIds: [],
  defaultStrategy: 'least_loaded',
  rules: [],
  fallback: { type: 'unassigned', userIds: [], roleId: null },
  roundRobinState: {},
};

export function parseLeadDistributionConfig(raw: unknown): LeadDistributionConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LEAD_DISTRIBUTION, roundRobinState: {} };
  const o = raw as Record<string, unknown>;
  const rules = Array.isArray(o.rules)
    ? (o.rules as LeadDistributionRule[]).filter((r) => r && typeof r.id === 'string')
    : [];
  return {
    enabled: Boolean(o.enabled),
    eligibleRoleIds: Array.isArray(o.eligibleRoleIds)
      ? (o.eligibleRoleIds as string[]).filter((x) => typeof x === 'string')
      : [],
    defaultStrategy:
      o.defaultStrategy === 'round_robin' ||
      o.defaultStrategy === 'least_loaded' ||
      o.defaultStrategy === 'weighted_avg_ticket'
        ? o.defaultStrategy
        : 'least_loaded',
    rules,
    fallback:
      o.fallback && typeof o.fallback === 'object'
        ? {
            type:
              (o.fallback as { type?: string }).type === 'users' ||
              (o.fallback as { type?: string }).type === 'role_pool'
                ? ((o.fallback as { type: 'users' | 'role_pool' }).type)
                : 'unassigned',
            userIds: Array.isArray((o.fallback as { userIds?: unknown }).userIds)
              ? ((o.fallback as { userIds: string[] }).userIds as string[]).filter(
                  (x) => typeof x === 'string'
                )
              : [],
            roleId:
              typeof (o.fallback as { roleId?: unknown }).roleId === 'string'
                ? ((o.fallback as { roleId: string }).roleId as string)
                : null,
          }
        : { type: 'unassigned', userIds: [], roleId: null },
    roundRobinState:
      o.roundRobinState && typeof o.roundRobinState === 'object' && !Array.isArray(o.roundRobinState)
        ? { ...(o.roundRobinState as Record<string, number>) }
        : {},
  };
}

export async function getLeadDistributionConfig(
  warehouseId: string
): Promise<LeadDistributionConfig> {
  const pdv = await getWarehousePdvSettings(warehouseId);
  const raw = pdv.lead_distribution_settings;
  return parseLeadDistributionConfig(raw);
}

type LeadLike = {
  id: string;
  warehouseId: string | null;
  source: string;
  sourceDetail: string | null;
  adLocation: string | null;
  notes: string | null;
  score: number;
};

function haystackForRegion(lead: LeadLike): string {
  return [lead.adLocation, lead.notes, lead.sourceDetail, '']
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function ruleMatches(lead: LeadLike, rule: LeadDistributionRule): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (m.sources.length > 0 && !m.sources.includes(lead.source)) return false;
  if (m.minScore != null && lead.score < m.minScore) return false;
  if (m.maxScore != null && lead.score > m.maxScore) return false;
  const hay = haystackForRegion(lead);
  if (m.regionContains.trim()) {
    if (!hay.includes(m.regionContains.trim().toLowerCase())) return false;
  }
  if (m.stateUf.trim()) {
    const uf = m.stateUf.trim().toUpperCase().slice(0, 2);
    const re = new RegExp(`\\b${uf}\\b|${uf}\\b`, 'i');
    if (!re.test(hay) && !hay.includes(uf.toLowerCase())) return false;
  }
  return true;
}

async function loadEligibleUsers(
  warehouseId: string,
  config: LeadDistributionConfig
): Promise<{ id: string; roleId: string }[]> {
  const where: { warehouseId: string; active: boolean; roleId?: { in: string[] } } = {
    warehouseId,
    active: true,
  };
  if (config.eligibleRoleIds.length > 0) {
    where.roleId = { in: config.eligibleRoleIds };
  }
  const users = await prisma.user.findMany({
    where,
    select: { id: true, roleId: true },
  });
  return users;
}

async function countActiveLeadsForUser(userId: string, warehouseId: string): Promise<number> {
  const crm = prisma as unknown as {
    crmLead: { count: (args: unknown) => Promise<number> };
  };
  return crm.crmLead.count({
    where: { warehouseId, assignedUserId: userId },
  });
}

async function avgWonDealValueForUser(userId: string, warehouseId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ avg: unknown }[]>`
    SELECT AVG(d.value)::float AS avg
    FROM crm_lead_deals d
    INNER JOIN crm_leads l ON l.id = d.crm_lead_id
    WHERE l.warehouse_id = ${warehouseId}
      AND l.assigned_user_id = ${userId}
      AND d.stage = 'fechado_ganho'
      AND d.value IS NOT NULL
  `;
  const v = rows[0]?.avg;
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function filterUserIdsByEligible(
  userIds: string[],
  eligible: Set<string>
): string[] {
  return userIds.filter((id) => eligible.has(id));
}

async function pickByRoundRobin(
  userIds: string[],
  stateKey: string,
  warehouseId: string
): Promise<string | null> {
  const valid = userIds.filter(Boolean);
  if (valid.length === 0) return null;
  const cfg = await getLeadDistributionConfig(warehouseId);
  let idx = cfg.roundRobinState[stateKey] ?? 0;
  if (idx >= valid.length) idx = 0;
  const userId = valid[idx] ?? null;
  const nextState = { ...cfg.roundRobinState, [stateKey]: (idx + 1) % valid.length };
  await persistRoundRobinState(warehouseId, nextState);
  return userId;
}

async function persistRoundRobinState(
  warehouseId: string,
  nextState: Record<string, number>
): Promise<void> {
  const pdv = await getWarehousePdvSettings(warehouseId);
  const cur = parseLeadDistributionConfig(pdv.lead_distribution_settings);
  cur.roundRobinState = nextState;
  await mergeWarehousePdvSettings(warehouseId, {
    lead_distribution_settings: cur as unknown as Record<string, unknown>,
  });
}

async function pickLeastLoaded(
  userIds: string[],
  warehouseId: string
): Promise<string | null> {
  if (userIds.length === 0) return null;
  let best: string | null = null;
  let bestCount = Infinity;
  for (const uid of userIds) {
    const c = await countActiveLeadsForUser(uid, warehouseId);
    if (c < bestCount) {
      bestCount = c;
      best = uid;
    }
  }
  return best;
}

async function pickWeightedAvgTicket(
  userIds: string[],
  warehouseId: string
): Promise<string | null> {
  if (userIds.length === 0) return null;
  let best: string | null = null;
  let bestAvg = -1;
  for (const uid of userIds) {
    const avg = await avgWonDealValueForUser(uid, warehouseId);
    if (avg > bestAvg) {
      bestAvg = avg;
      best = uid;
    }
  }
  if (best) return best;
  return userIds[0] ?? null;
}

async function resolvePoolUserIds(
  warehouseId: string,
  config: LeadDistributionConfig,
  roleId: string | null,
  userIds: string[]
): Promise<string[]> {
  const eligible = await loadEligibleUsers(warehouseId, config);
  const set = new Set(eligible.map((u) => u.id));
  if (roleId) {
    const withRole = eligible.filter((u) => u.roleId === roleId).map((u) => u.id);
    return filterUserIdsByEligible(withRole, set);
  }
  return filterUserIdsByEligible(userIds, set);
}

/**
 * Resolve o próximo usuário para atribuir ao lead (ou null).
 */
export async function resolveLeadAssigneeUserId(
  lead: LeadLike,
  config: LeadDistributionConfig
): Promise<string | null> {
  if (!config.enabled || !lead.warehouseId) return null;

  const eligible = await loadEligibleUsers(lead.warehouseId, config);
  const eligibleSet = new Set(eligible.map((u) => u.id));
  if (eligibleSet.size === 0) return null;

  const sortedRules = [...config.rules].sort((a, b) => a.priority - b.priority);

  for (const rule of sortedRules) {
    if (!ruleMatches(lead, rule)) continue;
    let pool = filterUserIdsByEligible(rule.assign.userIds, eligibleSet);
    if (pool.length === 0) {
      pool = eligible.map((u) => u.id);
    }
    if (pool.length === 0) continue;

    if (rule.assign.mode === 'round_robin') {
      return pickByRoundRobin(pool, `rule:${rule.id}`, lead.warehouseId);
    }
    if (rule.assign.mode === 'least_loaded') {
      return pickLeastLoaded(pool, lead.warehouseId);
    }
  }

  const fb = config.fallback;
  if (fb.type === 'unassigned') return null;

  let pool: string[] = [];
  if (fb.type === 'users') {
    pool = filterUserIdsByEligible(fb.userIds, eligibleSet);
  } else if (fb.type === 'role_pool' && fb.roleId) {
    pool = await resolvePoolUserIds(lead.warehouseId, config, fb.roleId, []);
  }
  if (pool.length === 0) return null;

  if (config.defaultStrategy === 'round_robin') {
    return pickByRoundRobin(pool, 'fallback:default', lead.warehouseId);
  }
  if (config.defaultStrategy === 'weighted_avg_ticket') {
    return pickWeightedAvgTicket(pool, lead.warehouseId);
  }
  return pickLeastLoaded(pool, lead.warehouseId);
}

/** Corrige estado após pickByRoundRobin (persistência já feita em pickByRoundRobin). */
export async function maybeAssignLeadFromRules(leadId: string): Promise<void> {
  const crm = prisma as unknown as {
    crmLead: {
      findUnique: (args: unknown) => Promise<LeadLike & { assignedUserId: string | null } | null>;
      update: (args: unknown) => Promise<unknown>;
    };
  };

  const lead = await crm.crmLead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      warehouseId: true,
      source: true,
      sourceDetail: true,
      adLocation: true,
      notes: true,
      score: true,
      assignedUserId: true,
    },
  });
  if (!lead?.warehouseId || lead.assignedUserId) return;

  const config = await getLeadDistributionConfig(lead.warehouseId);
  if (!config.enabled) return;

  const userId = await resolveLeadAssigneeUserId(
    {
      id: lead.id,
      warehouseId: lead.warehouseId,
      source: lead.source,
      sourceDetail: lead.sourceDetail,
      adLocation: lead.adLocation,
      notes: lead.notes,
      score: lead.score ?? 0,
    },
    config
  );

  if (userId) {
    await crm.crmLead.update({
      where: { id: leadId },
      data: { assignedUserId: userId, lastInteractionAt: new Date() },
    });
  }
}

export function createEmptyRule(): LeadDistributionRule {
  return {
    id: `rule-${randomUUID().slice(0, 8)}`,
    name: 'Nova regra',
    enabled: true,
    priority: 10,
    match: {
      sources: [],
      regionContains: '',
      stateUf: '',
      minScore: null,
      maxScore: null,
    },
    assign: {
      mode: 'least_loaded',
      userIds: [],
    },
  };
}
