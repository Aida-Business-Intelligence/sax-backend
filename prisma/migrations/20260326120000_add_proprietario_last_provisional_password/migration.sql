-- Última senha provisória salva pelo PDV (exibição na edição; login continua usando password_hash).
ALTER TABLE "Proprietario" ADD COLUMN IF NOT EXISTS "last_provisional_password" TEXT;
