ALTER TABLE "Proprietario" ADD COLUMN IF NOT EXISTS "credential_notify_email" TEXT;
ALTER TABLE "Proprietario" ADD COLUMN IF NOT EXISTS "credential_notify_whatsapp" TEXT;
ALTER TABLE "Proprietario" ADD COLUMN IF NOT EXISTS "credential_portal_base_url" TEXT;
