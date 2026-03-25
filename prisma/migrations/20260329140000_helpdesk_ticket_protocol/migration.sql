-- AlterTable
ALTER TABLE "HelpDeskTicket" ADD COLUMN "protocol" TEXT;

-- Backfill determinístico por ticket (legado)
UPDATE "HelpDeskTicket" SET "protocol" = 'SAX-' || upper(substring(md5(id::text), 1, 12));

ALTER TABLE "HelpDeskTicket" ALTER COLUMN "protocol" SET NOT NULL;

CREATE UNIQUE INDEX "HelpDeskTicket_protocol_key" ON "HelpDeskTicket"("protocol");
