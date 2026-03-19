-- CreateTable Automation (regras de reimpacto)
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerConfig" JSONB,
    "actionType" TEXT NOT NULL,
    "actionConfig" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Automation_active_idx" ON "Automation"("active");

-- CreateTable AutomationQueue (fila de eventos para envio)
CREATE TABLE "AutomationQueue" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "leadId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduledFor" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "resultPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationQueue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutomationQueue_automationId_idx" ON "AutomationQueue"("automationId");
CREATE INDEX "AutomationQueue_visitorId_idx" ON "AutomationQueue"("visitorId");
CREATE INDEX "AutomationQueue_status_idx" ON "AutomationQueue"("status");
CREATE INDEX "AutomationQueue_scheduledFor_idx" ON "AutomationQueue"("scheduledFor");

ALTER TABLE "AutomationQueue" ADD CONSTRAINT "AutomationQueue_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
