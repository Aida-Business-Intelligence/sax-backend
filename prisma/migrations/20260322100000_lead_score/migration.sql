-- AlterTable Lead: add score (intenção de compra)
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "score" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Lead_score_idx" ON "Lead"("score");
