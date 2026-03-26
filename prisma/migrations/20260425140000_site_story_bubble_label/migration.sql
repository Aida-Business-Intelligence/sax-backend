-- Rótulo curto abaixo da bolha no sax-site (/feed)
ALTER TABLE "site_stories" ADD COLUMN IF NOT EXISTS "bubble_label" VARCHAR(80);
