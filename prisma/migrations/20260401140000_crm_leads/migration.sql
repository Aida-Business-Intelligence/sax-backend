-- CreateTable
CREATE TABLE "crm_leads" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "tracking_visitor_id" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "cpf" TEXT,
    "pipeline_stage" TEXT NOT NULL DEFAULT 'novo',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_detail" TEXT,
    "ad_title" TEXT,
    "ad_image_url" TEXT,
    "ad_location" TEXT,
    "interest_property_type" TEXT,
    "interest_transaction_type" TEXT,
    "notes" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "last_interaction_at" TIMESTAMP(3),
    "assigned_user_id" TEXT,
    "meta_lead_id" TEXT,
    "meta_form_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crm_leads_tracking_visitor_id_key" ON "crm_leads"("tracking_visitor_id");

-- CreateIndex
CREATE INDEX "crm_leads_warehouse_id_idx" ON "crm_leads"("warehouse_id");

-- CreateIndex
CREATE INDEX "crm_leads_pipeline_stage_idx" ON "crm_leads"("pipeline_stage");

-- CreateIndex
CREATE INDEX "crm_leads_source_idx" ON "crm_leads"("source");

-- CreateIndex
CREATE INDEX "crm_leads_phone_idx" ON "crm_leads"("phone");

-- CreateIndex
CREATE INDEX "crm_leads_created_at_idx" ON "crm_leads"("created_at");

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
