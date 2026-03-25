-- CreateTable HelpDeskTicket
-- Nota: coluna "protocol" é adicionada em migração posterior (20260329140000_helpdesk_ticket_protocol)
CREATE TABLE "HelpDeskTicket" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "queue" TEXT NOT NULL DEFAULT 'geral',
    "proprietarioId" TEXT NOT NULL,
    "warehouseId" TEXT,
    "assignedUserId" TEXT,
    "createdByStaff" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "firstMessageAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpDeskTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable HelpDeskMessage
-- Nota: coluna "imageUrl" é adicionada em migração posterior (20260330120000_helpdesk_message_image)
CREATE TABLE "HelpDeskMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorUserId" TEXT,
    "readByOwnerAt" TIMESTAMP(3),
    "readByStaffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpDeskMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable HelpDeskTicketEvent
CREATE TABLE "HelpDeskTicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpDeskTicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HelpDeskTicket_number_key" ON "HelpDeskTicket"("number");

-- CreateIndex
CREATE INDEX "HelpDeskTicket_status_idx" ON "HelpDeskTicket"("status");

-- CreateIndex
CREATE INDEX "HelpDeskTicket_proprietarioId_idx" ON "HelpDeskTicket"("proprietarioId");

-- CreateIndex
CREATE INDEX "HelpDeskTicket_assignedUserId_idx" ON "HelpDeskTicket"("assignedUserId");

-- CreateIndex
CREATE INDEX "HelpDeskTicket_queue_idx" ON "HelpDeskTicket"("queue");

-- CreateIndex
CREATE INDEX "HelpDeskTicket_createdAt_idx" ON "HelpDeskTicket"("createdAt");

-- CreateIndex
CREATE INDEX "HelpDeskMessage_ticketId_idx" ON "HelpDeskMessage"("ticketId");

-- CreateIndex
CREATE INDEX "HelpDeskTicketEvent_ticketId_idx" ON "HelpDeskTicketEvent"("ticketId");

-- AddForeignKey
ALTER TABLE "HelpDeskTicket" ADD CONSTRAINT "HelpDeskTicket_proprietarioId_fkey" FOREIGN KEY ("proprietarioId") REFERENCES "Proprietario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskTicket" ADD CONSTRAINT "HelpDeskTicket_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskTicket" ADD CONSTRAINT "HelpDeskTicket_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskTicket" ADD CONSTRAINT "HelpDeskTicket_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskMessage" ADD CONSTRAINT "HelpDeskMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpDeskTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskMessage" ADD CONSTRAINT "HelpDeskMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpDeskTicketEvent" ADD CONSTRAINT "HelpDeskTicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpDeskTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
