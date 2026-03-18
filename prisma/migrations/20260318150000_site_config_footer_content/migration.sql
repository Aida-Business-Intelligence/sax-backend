-- Add footerContent to SiteConfig (rodapé e redes sociais)
ALTER TABLE "SiteConfig"
  ADD COLUMN IF NOT EXISTS "footerContent" TEXT;
