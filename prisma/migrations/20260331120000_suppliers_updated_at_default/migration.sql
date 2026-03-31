-- Alinha com Prisma @updatedAt: coluna era NOT NULL sem DEFAULT (INSERT sem updated_at falhava com 23502).
ALTER TABLE "suppliers" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
