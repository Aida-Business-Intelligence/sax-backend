-- Persistência de configurações do PDV por loja (integrações, helpdesk, etc.)
ALTER TABLE "Warehouse" ADD COLUMN "pdv_settings_json" TEXT;
