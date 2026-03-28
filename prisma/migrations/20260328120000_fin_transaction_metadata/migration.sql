-- Campos extras (parcelas, cliente, anexos) em lançamentos financeiros
ALTER TABLE "fin_transactions" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
