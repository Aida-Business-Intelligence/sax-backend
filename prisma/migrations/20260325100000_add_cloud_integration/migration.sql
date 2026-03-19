-- CreateTable CloudIntegration (integrações Dropbox, Drive, OneDrive por usuário)
CREATE TABLE "CloudIntegration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "email" TEXT,
    "integratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudIntegration_userId_provider_key" ON "CloudIntegration"("userId", "provider");
CREATE INDEX "CloudIntegration_userId_idx" ON "CloudIntegration"("userId");
