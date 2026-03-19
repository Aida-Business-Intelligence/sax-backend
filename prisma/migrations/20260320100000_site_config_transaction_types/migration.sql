-- Add transactionTypes to SiteConfig (tipos de transação do PDV para o site)
ALTER TABLE "SiteConfig" ADD COLUMN "transactionTypes" TEXT;
