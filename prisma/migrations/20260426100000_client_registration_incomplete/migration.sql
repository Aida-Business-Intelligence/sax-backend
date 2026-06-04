-- Cadastro parcial (ex.: cliente criado a partir de lead no CRM)
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "registration_incomplete" BOOLEAN NOT NULL DEFAULT false;
