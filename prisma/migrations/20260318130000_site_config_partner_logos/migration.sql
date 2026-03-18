-- Add partnerLogos to SiteConfig (logos da seção Nossos Parceiros na página Imóveis)
ALTER TABLE "SiteConfig"
  ADD COLUMN IF NOT EXISTS "partnerLogos" TEXT;
