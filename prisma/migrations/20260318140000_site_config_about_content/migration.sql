-- Add aboutContent to SiteConfig (conteúdo editável da página Sobre nós)
ALTER TABLE "SiteConfig"
  ADD COLUMN IF NOT EXISTS "aboutContent" TEXT;
