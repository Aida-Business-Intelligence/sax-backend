-- CreateTable Visitor (tracking por fingerprint)
CREATE TABLE "Visitor" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Visitor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Visitor_fingerprint_key" ON "Visitor"("fingerprint");
CREATE INDEX "Visitor_fingerprint_idx" ON "Visitor"("fingerprint");
CREATE INDEX "Visitor_updatedAt_idx" ON "Visitor"("updatedAt");

CREATE TABLE "TrackingSession" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    CONSTRAINT "TrackingSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrackingSession_visitorId_idx" ON "TrackingSession"("visitorId");

CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TrackingEvent_visitorId_idx" ON "TrackingEvent"("visitorId");
CREATE INDEX "TrackingEvent_type_idx" ON "TrackingEvent"("type");
CREATE INDEX "TrackingEvent_createdAt_idx" ON "TrackingEvent"("createdAt");

ALTER TABLE "TrackingSession" ADD CONSTRAINT "TrackingSession_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
