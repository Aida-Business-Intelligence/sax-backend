-- Soft delete / inativação: não apagar linha quando existir negócio CRM (CrmLeadDeal) ligado a imóvel do cliente.
ALTER TABLE "Client" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Client" ADD COLUMN "deleted_at" TIMESTAMP(3);
