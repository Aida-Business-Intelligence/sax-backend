-- Negócios, interações e eventos (tarefas) do pipeline do lead no PDV (após crm_leads)

CREATE TABLE "crm_lead_deals" (
    "id" TEXT NOT NULL,
    "crm_lead_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "value" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "stage" TEXT NOT NULL DEFAULT 'prospeccao',
    "expected_close_at" TIMESTAMP(3),
    "description" TEXT,
    "internal_notes" TEXT,
    "probability" INTEGER,
    "transaction_type" TEXT,
    "property_ref" TEXT,
    "responsible" TEXT,
    "commission_pct" DECIMAL(5,2),
    "payment_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_lead_deals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_lead_interactions" (
    "id" TEXT NOT NULL,
    "crm_lead_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'nota',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "author_name" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_lead_interactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_lead_tasks" (
    "id" TEXT NOT NULL,
    "crm_lead_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'reuniao',
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "local" TEXT,
    "reminder_minutes" INTEGER,
    "negocio_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_lead_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crm_lead_deals_crm_lead_id_idx" ON "crm_lead_deals"("crm_lead_id");
CREATE INDEX "crm_lead_interactions_crm_lead_id_idx" ON "crm_lead_interactions"("crm_lead_id");
CREATE INDEX "crm_lead_interactions_created_at_idx" ON "crm_lead_interactions"("created_at");
CREATE INDEX "crm_lead_tasks_crm_lead_id_idx" ON "crm_lead_tasks"("crm_lead_id");
CREATE INDEX "crm_lead_tasks_scheduled_at_idx" ON "crm_lead_tasks"("scheduled_at");

ALTER TABLE "crm_lead_deals" ADD CONSTRAINT "crm_lead_deals_crm_lead_id_fkey" FOREIGN KEY ("crm_lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_lead_interactions" ADD CONSTRAINT "crm_lead_interactions_crm_lead_id_fkey" FOREIGN KEY ("crm_lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_lead_interactions" ADD CONSTRAINT "crm_lead_interactions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_lead_tasks" ADD CONSTRAINT "crm_lead_tasks_crm_lead_id_fkey" FOREIGN KEY ("crm_lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
