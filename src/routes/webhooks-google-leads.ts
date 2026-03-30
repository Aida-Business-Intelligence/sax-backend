/**
 * Webhook genérico para leads vindos de Google Ads (Instant forms / parceiros) ou Zapier/Make.
 * POST /api/webhooks/google-leads/:warehouseId
 * Header: X-Sax-Webhook-Secret: <mesmo valor configurado em Integrações → Google>
 * Body JSON: { name?, email?, phone?, telefone?, cpf?, source?, notes? }
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { getWarehousePdvSettings } from '../lib/pdv-warehouse-settings.js';
import { maybeAssignLeadFromRules } from '../lib/lead-distribution.js';

export const googleLeadsWebhookRouter = Router();

function parseIntegrationsPayload(
  cfg: Record<string, unknown>
): Record<string, unknown> | null {
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

googleLeadsWebhookRouter.post('/:warehouseId', async (req: Request, res: Response) => {
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

  const cfg = await getWarehousePdvSettings(warehouseId);
  const integrations = parseIntegrationsPayload(cfg);
  const google =
    integrations?.google && typeof integrations.google === 'object'
      ? (integrations.google as Record<string, unknown>)
      : null;

  if (google && google.enabled === false) {
    res.status(200).json({ ok: true, ignored: 'google_disabled' });
    return;
  }

  const expectedSecret =
    (typeof google?.webhookSecret === 'string' && google.webhookSecret.trim()) ||
    process.env.GOOGLE_LEADS_WEBHOOK_SECRET?.trim() ||
    '';

  if (!expectedSecret) {
    console.error('[google-leads] webhook secret not configured', warehouseId);
    res.status(503).json({ ok: false, message: 'webhook not configured' });
    return;
  }

  const sent = req.get('x-sax-webhook-secret')?.trim();
  if (!sent || sent !== expectedSecret) {
    res.status(401).json({ ok: false, message: 'invalid secret' });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const name = String(body.name ?? body.nome ?? '').trim() || null;
  const email = String(body.email ?? '').trim() || null;
  const phone = String(body.phone ?? body.telefone ?? body.phone_number ?? '').trim() || null;
  const cpf = String(body.cpf ?? '').trim() || null;
  const sourceRaw = String(body.source ?? 'google_ads').trim() || 'google_ads';
  const notes = String(body.notes ?? body.observacoes ?? '').trim() || null;

  if (!email && !phone) {
    res.status(400).json({ ok: false, message: 'email or phone required' });
    return;
  }

  const crm = prisma as unknown as {
    crmLead: { create: (args: unknown) => Promise<{ id: string }> };
  };

  const lead = await crm.crmLead.create({
    data: {
      warehouseId,
      name,
      email,
      phone,
      cpf,
      pipelineStage: 'novo',
      source: sourceRaw.slice(0, 64),
      sourceDetail: 'webhook',
      adTitle: 'Google Ads / formulário',
      notes,
      lastInteractionAt: new Date(),
    },
  });

  await maybeAssignLeadFromRules(lead.id);

  res.status(201).json({ ok: true, id: lead.id });
});
