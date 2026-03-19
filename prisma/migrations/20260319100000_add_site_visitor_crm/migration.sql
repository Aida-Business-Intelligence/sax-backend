-- CreateTable SiteVisitor (CRM: visitantes com dados técnicos e marketing)
CREATE TABLE "SiteVisitor" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,
    "deviceType" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "country" TEXT,
    "city" TEXT,
    "region" TEXT,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteVisitor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteVisitor_sessionId_key" ON "SiteVisitor"("sessionId");
CREATE INDEX "SiteVisitor_lastSeen_idx" ON "SiteVisitor"("lastSeen");
CREATE INDEX "SiteVisitor_city_idx" ON "SiteVisitor"("city");

-- SiteLead: add sessionId and cpf (para CRM e vínculo com visitante)
ALTER TABLE "SiteLead" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "SiteLead" ADD COLUMN "cpf" TEXT;
CREATE INDEX "SiteLead_sessionId_idx" ON "SiteLead"("sessionId");
CREATE INDEX "SiteLead_email_idx" ON "SiteLead"("email");
CREATE INDEX "SiteLead_phone_idx" ON "SiteLead"("phone");
