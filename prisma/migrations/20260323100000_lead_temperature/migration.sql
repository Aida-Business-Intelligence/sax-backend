-- AlterTable Lead: temperature + lastActivityAt
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "temperature" TEXT NOT NULL DEFAULT 'cold';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "lastActivityAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Lead_temperature_idx" ON "Lead"("temperature");
