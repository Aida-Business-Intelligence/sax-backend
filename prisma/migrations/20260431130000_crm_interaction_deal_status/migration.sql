-- Opcional: vínculo com negócio + status Kanban nas interações do lead
ALTER TABLE "crm_lead_interactions" ADD COLUMN IF NOT EXISTS "crm_lead_deal_id" TEXT;
ALTER TABLE "crm_lead_interactions" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'registrada';

CREATE INDEX IF NOT EXISTS "crm_lead_interactions_crm_lead_deal_id_idx" ON "crm_lead_interactions"("crm_lead_deal_id");
CREATE INDEX IF NOT EXISTS "crm_lead_interactions_status_idx" ON "crm_lead_interactions"("status");

ALTER TABLE "crm_lead_interactions" DROP CONSTRAINT IF EXISTS "crm_lead_interactions_crm_lead_deal_id_fkey";
ALTER TABLE "crm_lead_interactions"
  ADD CONSTRAINT "crm_lead_interactions_crm_lead_deal_id_fkey"
  FOREIGN KEY ("crm_lead_deal_id") REFERENCES "crm_lead_deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
