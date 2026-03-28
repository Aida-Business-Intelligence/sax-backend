-- Prioridade e participantes (usuários PDV) nos eventos do pipeline
ALTER TABLE "crm_lead_tasks" ADD COLUMN IF NOT EXISTS "priority" TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE "crm_lead_tasks" ADD COLUMN IF NOT EXISTS "participant_user_ids" JSONB;
