-- Geolocalização no painel ao vivo (GPS do navegador ou centro aproximado por IP)
ALTER TABLE "SiteVisitor" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "SiteVisitor" ADD COLUMN "longitude" DOUBLE PRECISION;
