-- Adiciona campos de conteúdo editável que estavam no schema mas sem migration correspondente
-- imoveisContent: JSON com CTA WhatsApp na página de detalhe do imóvel, etc.
-- proprietariosContent: JSON com textos da página /para-proprietarios (sax-site)
ALTER TABLE "SiteConfig" ADD COLUMN "imoveisContent" TEXT;
ALTER TABLE "SiteConfig" ADD COLUMN "proprietariosContent" TEXT;
