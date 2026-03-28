-- Vínculo formal do negócio (CRM) ao cadastro de imóvel
ALTER TABLE "crm_lead_deals" ADD COLUMN IF NOT EXISTS "property_id" TEXT;
CREATE INDEX IF NOT EXISTS "crm_lead_deals_property_id_idx" ON "crm_lead_deals"("property_id");
ALTER TABLE "crm_lead_deals"
  DROP CONSTRAINT IF EXISTS "crm_lead_deals_property_id_fkey";
ALTER TABLE "crm_lead_deals"
  ADD CONSTRAINT "crm_lead_deals_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
