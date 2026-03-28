-- Agenda CRM: próxima ação obrigatória no lead + check-in / WhatsApp / lembrete nos eventos
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "next_action_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "next_action_note" TEXT;

ALTER TABLE "crm_lead_tasks" ADD COLUMN IF NOT EXISTS "checked_in_at" TIMESTAMPTZ;
ALTER TABLE "crm_lead_tasks" ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMPTZ;
ALTER TABLE "crm_lead_tasks" ADD COLUMN IF NOT EXISTS "whatsapp_confirmation_sent_at" TIMESTAMPTZ;
