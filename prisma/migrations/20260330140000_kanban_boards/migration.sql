-- CreateTable
CREATE TABLE "kanban_boards" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_boards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kanban_boards_user_id_key" ON "kanban_boards"("user_id");

ALTER TABLE "kanban_boards" ADD CONSTRAINT "kanban_boards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
