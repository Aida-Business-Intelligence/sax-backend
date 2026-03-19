-- CreateTable
CREATE TABLE "SiteLead" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'cookie_banner',
    "consent" BOOLEAN NOT NULL DEFAULT true,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAnalyticsEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "path" TEXT,
    "payload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteAnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteAnalyticsEvent_sessionId_idx" ON "SiteAnalyticsEvent"("sessionId");
CREATE INDEX "SiteAnalyticsEvent_eventType_idx" ON "SiteAnalyticsEvent"("eventType");
CREATE INDEX "SiteAnalyticsEvent_createdAt_idx" ON "SiteAnalyticsEvent"("createdAt");
