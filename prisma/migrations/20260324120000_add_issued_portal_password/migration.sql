-- CreateTable
CREATE TABLE "IssuedPortalPassword" (
    "id" TEXT NOT NULL,
    "sha256_hex" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedPortalPassword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuedPortalPassword_sha256_hex_key" ON "IssuedPortalPassword"("sha256_hex");
