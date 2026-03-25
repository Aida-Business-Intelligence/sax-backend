-- AlterTable
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "owner_submission_status" TEXT;

-- AlterTable
ALTER TABLE "Proprietario" ADD COLUMN IF NOT EXISTS "privacy_json" TEXT;
