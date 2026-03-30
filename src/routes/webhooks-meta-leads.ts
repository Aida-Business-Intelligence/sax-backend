/**
 * Webhook Meta (Facebook / Instagram Lead Ads) -> crm_leads.
 * Callback: GET|POST /api/webhooks/meta-leads/:warehouseId
 */
import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getWarehousePdvSettings } from '../lib/pdv-warehouse-settings.js';
import { maybeAssignLeadFromRules } from '../lib/lead-distribution.js';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

export const metaLeadsWebhookRouter = Router();

function parseIntegrationsPayload(cfg: Record<string, unknown>): Record<string, unknown> | null {
  const raw = cfg.integrations_settings;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

function metaBlock(integrations: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!integrations?.meta || typeof integrations.meta !== 'object') return null;
  return integrations.meta as Record<string, unknown>;
}

function verifyMetaSignature(
  appSecret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const received = signatureHeader.slice('sha256='.length).trim();
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

type FieldDataRow = { name?: string; values?: string[] };

function mapLeadgenFields(fieldData: FieldDataRow[]): {
  name: string | null;
  email: string | null;
  phone: string | null;
  cpf: string | null;
  extra: Record<string, string>;
} {
  const extra: Record<string, string> = {};
  let name: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  let cpf: string | null = null;

  for (const row of fieldData) {
    const key = String(row.name ?? '').toLowerCase().replace(/\s+/g, '_');
    const val = Array.isArray(row.values) ? row.values[0] : undefined;
    const s = val != null ? String(val).trim() : '';
    if (!s) continue;
    extra[String(row.name ?? key)] = s;

    if (
      key.includes('full_name') ||
      key === 'nome_completo' ||
      key === 'nome' ||
      key === 'name' ||
      key === 'full_name'
    ) {
      if (!name) name = s;
    }
    if (key.includes('first_name') && !name) name = s;
    if (key.includes('last_name') && name) name = `${name} ${s}`.trim();
    if (key.includes('email') || key === 'e-mail') email = email || s;
    if (
      key.includes('phone') ||
      key.includes('telefone') ||
      key.includes('mobile') ||
      key === 'celular'
    ) {
      phone = phone || s;
    }
    if (key === 'cpf' || key.includes('document')) cpf = cpf || s;
  }

  if (!name) {
    const first = fieldData.find((f) => String(f.name ?? '').toLowerCase().includes('first'));
    const last = fieldData.find((f) => String(f.name ?? '').toLowerCase().includes('last'));
    const f = first?.values?.[0];
    const l = last?.values?.[0];
    if (f || l) name = [f, l].filter(Boolean).join(' ').trim() || null;
  }

  return { name, email, phone, cpf, extra };
}

async function fetchLeadgenFromGraph(
  leadgenId: string,
  pageAccessToken: string
): Promise<{
  field_data?: FieldDataRow[];
  created_time?: string;
  id?: string;
  ad_id?: string;
  form_id?: string;
} | null> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`);
  url.searchParams.set('access_token', pageAccessToken);
  url.searchParams.set('fields', 'created_time,id,ad_id,form_id,field_data');
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = (await res.json().catch(() => ({}))) as {
    field_data?: FieldDataRow[];
    error?: { message?: string };
    created_time?: string;
    id?: string;
    ad_id?: string;
    form_id?: string;
  };
  if (!res.ok) {
    console.error('[meta-leads] graph error', leadgenId, data?.error?.message ?? res.status);
    return null;
  }
  return data;
}

metaLeadsWebhookRouter.get('/:warehouseId', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode !== 'subscribe' || typeof challenge !== 'string') {
    res.status(400).send('Bad Request');
    return;
  }

  const warehouseId = req.params.warehouseId?.trim();
  if (!warehouseId) {
    res.status(400).send('Missing warehouse');
    return;
  }

  const wh = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true },
  });
  if (!wh) {
    res.status(404).send('Unknown warehouse');
    return;
  }

  const cfg = await getWarehousePdvSettings(warehouseId);
  const integrations = parseIntegrationsPayload(cfg);
  const meta = metaBlock(integrations);
  const expectedToken =
    (typeof meta?.webhookVerifyToken === 'string' && meta.webhookVerifyToken.trim()) ||
    process.env.META_LEADS_VERIFY_TOKEN?.trim() ||
    '';

  if (!expectedToken || token !== expectedToken) {
    res.status(403).send('Forbidden');
    return;
  }

  res.status(200).type('text/plain').send(challenge);
});

metaLeadsWebhookRouter.post('/:warehouseId', async (req: Request, res: Response) => {
  const warehouseId = req.params.warehouseId?.trim();
  if (!warehouseId) {
    res.status(400).json({ ok: false, message: 'Missing warehouse' });
    return;
  }

  const wh = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true },
  });
  if (!wh) {
    res.status(404).json({ ok: false, message: 'Unknown warehouse' });
    return;
  }

  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    res.status(400).json({ ok: false, message: 'Expected raw JSON body' });
    return;
  }

  const cfg = await getWarehousePdvSettings(warehouseId);
  const integrations = parseIntegrationsPayload(cfg);
  const meta = metaBlock(integrations);

  if (meta && meta.enabled === false) {
    res.status(200).json({ ok: true, ignored: 'meta_disabled' });
    return;
  }

  const appSecret =
    (typeof meta?.facebookAppSecret === 'string' && meta.facebookAppSecret.trim()) ||
    process.env.META_APP_SECRET?.trim() ||
    '';

  if (!appSecret) {
    console.error('[meta-leads] missing app secret', warehouseId);
    res.status(200).json({ ok: false, message: 'app secret not configured' });
    return;
  }

  const signature = req.get('x-hub-signature-256');
  if (!verifyMetaSignature(appSecret, raw, signature)) {
    res.status(401).json({ ok: false, message: 'invalid signature' });
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ ok: false, message: 'invalid json' });
    return;
  }

  const payload = body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        field?: string;
        value?: {
          leadgen_id?: string;
          page_id?: string;
          form_id?: string;
          adgroup_id?: string;
          ad_id?: string;
        };
      }>;
    }>;
  };

  if (payload.object !== 'page') {
    res.status(200).json({ ok: true, ignored: 'not_page' });
    return;
  }

  const pageAccessToken =
    (typeof meta?.pageAccessToken === 'string' && meta.pageAccessToken.trim()) ||
    process.env.META_PAGE_ACCESS_TOKEN?.trim() ||
    '';

  if (!pageAccessToken) {
    console.error('[meta-leads] missing page access token', warehouseId);
    res.status(200).json({ ok: false, message: 'page access token not configured' });
    return;
  }

  const crm = prisma as unknown as {
    crmLead: {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
      create: (args: unknown) => Promise<{ id: string }>;
    };
  };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      const leadgenId = change.value?.leadgen_id;
      if (!leadgenId) continue;

      const existing = await crm.crmLead.findFirst({
        where: { warehouseId, metaLeadId: leadgenId },
        select: { id: true },
      });
      if (existing) continue;

      const graph = await fetchLeadgenFromGraph(leadgenId, pageAccessToken);
      const rows = graph?.field_data ?? [];
      const mapped = mapLeadgenFields(rows);

      if (!mapped.email && !mapped.phone) {
        console.warn('[meta-leads] lead without email/phone', leadgenId);
      }

      const formId = graph?.form_id ?? change.value?.form_id ?? null;
      const adId = graph?.ad_id ?? change.value?.ad_id ?? null;
      const notes = [
        mapped.cpf ? `CPF: ${mapped.cpf}` : null,
        `form_id: ${formId ?? ''}`,
        `ad_id: ${adId ?? ''}`,
        Object.keys(mapped.extra).length
          ? `campos: ${JSON.stringify(mapped.extra).slice(0, 2000)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');

      const created = await crm.crmLead.create({
        data: {
          warehouseId,
          name: mapped.name,
          email: mapped.email,
          phone: mapped.phone,
          cpf: mapped.cpf,
          pipelineStage: 'novo',
          source: 'meta_ads',
          sourceDetail: formId ? `form:${formId}` : 'leadgen',
          adTitle: adId ? `Meta Ads · anúncio ${adId}` : 'Meta Lead Ads',
          notes: notes || null,
          metaLeadId: leadgenId,
          metaFormId: formId,
          lastInteractionAt: new Date(),
        },
      });
      await maybeAssignLeadFromRules(created.id);
    }
  }

  res.status(200).json({ ok: true });
});
