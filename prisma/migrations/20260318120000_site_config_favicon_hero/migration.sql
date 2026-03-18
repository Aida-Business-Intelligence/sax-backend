-- Add faviconUrl and heroContent to SiteConfig (Gestão de Site: logo/favicon e Hero da home)
ALTER TABLE "SiteConfig"
  ADD COLUMN IF NOT EXISTS "faviconUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "heroContent" TEXT;
