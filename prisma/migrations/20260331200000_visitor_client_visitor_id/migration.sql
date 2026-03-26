-- AlterTable
ALTER TABLE "Visitor" ADD COLUMN "client_visitor_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Visitor_client_visitor_id_key" ON "Visitor"("client_visitor_id");
