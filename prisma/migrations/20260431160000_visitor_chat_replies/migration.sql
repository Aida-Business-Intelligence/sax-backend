-- CreateTable
CREATE TABLE "visitor_chat_replies" (
    "id" TEXT NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_chat_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visitor_chat_replies_session_id_created_at_idx" ON "visitor_chat_replies"("session_id", "created_at");
