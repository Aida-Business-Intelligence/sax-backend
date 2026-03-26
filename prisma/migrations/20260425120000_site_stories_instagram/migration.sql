-- Stories do feed (PDV / sax-site) + colunas Instagram em SiteConfig
-- Antes só existiam no schema.prisma sem migração — aplicar com: npx prisma migrate deploy

-- Instagram (Graph API) na configuração do site
ALTER TABLE "SiteConfig" ADD COLUMN IF NOT EXISTS "instagram_business_account_id" TEXT;
ALTER TABLE "SiteConfig" ADD COLUMN IF NOT EXISTS "instagram_access_token" TEXT;

-- Tabela site_stories (mapeada em @@map("site_stories"))
CREATE TABLE IF NOT EXISTS "site_stories" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "image_url" TEXT NOT NULL,
    "caption" TEXT,
    "overlays" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_stories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "site_stories_published_sort_order_idx" ON "site_stories"("published", "sort_order");
CREATE INDEX IF NOT EXISTS "site_stories_warehouse_id_idx" ON "site_stories"("warehouse_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_stories_warehouse_id_fkey'
  ) THEN
    ALTER TABLE "site_stories" ADD CONSTRAINT "site_stories_warehouse_id_fkey"
      FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'site_stories_created_by_user_id_fkey'
  ) THEN
    ALTER TABLE "site_stories" ADD CONSTRAINT "site_stories_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
