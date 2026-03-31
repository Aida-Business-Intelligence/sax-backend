-- Mensagens em tempo real PDV → visitante no site (painel ao vivo)
CREATE TABLE "live_visitor_messages" (
    "id" TEXT NOT NULL,
    "session_id" VARCHAR(128) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "body" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_visitor_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "live_visitor_messages_session_id_delivered_idx" ON "live_visitor_messages"("session_id", "delivered");
CREATE INDEX "live_visitor_messages_created_at_idx" ON "live_visitor_messages"("created_at");
