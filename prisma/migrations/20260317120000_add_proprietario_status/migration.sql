-- Add lifecycle and access columns to Proprietario
ALTER TABLE "Proprietario"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "origem" TEXT NOT NULL DEFAULT 'erp',
  ADD COLUMN IF NOT EXISTS "subdomain" TEXT,
  ADD COLUMN IF NOT EXISTS "access_email" TEXT,
  ADD COLUMN IF NOT EXISTS "password_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "Proprietario_subdomain_key"
  ON "Proprietario"("subdomain");

UPDATE "Proprietario"
SET
  "status" = COALESCE("status", 'active'),
  "origem" = COALESCE("origem", 'erp'),
  "approvedAt" = COALESCE("approvedAt", NOW())
WHERE COALESCE("origem", 'erp') <> 'web';

UPDATE "Proprietario"
SET
  "status" = COALESCE("status", 'pending'),
  "origem" = COALESCE("origem", 'web')
WHERE COALESCE("origem", 'erp') = 'web';
