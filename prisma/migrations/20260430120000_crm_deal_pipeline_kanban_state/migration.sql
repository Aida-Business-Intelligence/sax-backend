-- Kanban pós-ganho (contrato, financeiro, documentos) no negócio CRM
ALTER TABLE "crm_lead_deals" ADD COLUMN IF NOT EXISTS "pipeline_kanban_state" JSONB;
