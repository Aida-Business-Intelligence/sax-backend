-- CreateTable
CREATE TABLE "kanban_workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" VARCHAR(16),
    "created_by_id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kanban_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_workspace_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kanban_workspace_members_workspace_id_user_id_key" ON "kanban_workspace_members"("workspace_id", "user_id");

-- Add workspace_id to existing boards (nullable until migrated)
ALTER TABLE "kanban_boards" ADD COLUMN IF NOT EXISTS "workspace_id" TEXT;

-- Migrate: one workspace per existing board row
DO $$
DECLARE
  r RECORD;
  new_ws_id TEXT;
BEGIN
  FOR r IN SELECT kb.id AS board_id, kb.user_id, kb.created_at, kb.updated_at FROM kanban_boards kb WHERE kb.workspace_id IS NULL LOOP
    new_ws_id := gen_random_uuid()::text;
    INSERT INTO "kanban_workspaces" ("id", "name", "key", "created_by_id", "warehouse_id", "created_at", "updated_at")
    VALUES (new_ws_id, 'Meu espaço', NULL, r.user_id, NULL, r.created_at, r.updated_at);

    INSERT INTO "kanban_workspace_members" ("id", "workspace_id", "user_id", "role", "created_at")
    VALUES (gen_random_uuid()::text, new_ws_id, r.user_id, 'admin', NOW());

    UPDATE "kanban_boards" SET "workspace_id" = new_ws_id WHERE "id" = r.board_id;
  END LOOP;
END $$;

-- Drop old user-based link on boards
ALTER TABLE "kanban_boards" DROP CONSTRAINT IF EXISTS "kanban_boards_user_id_fkey";
DROP INDEX IF EXISTS "kanban_boards_user_id_key";
ALTER TABLE "kanban_boards" DROP COLUMN IF EXISTS "user_id";

ALTER TABLE "kanban_boards" ALTER COLUMN "workspace_id" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "kanban_boards_workspace_id_key" ON "kanban_boards"("workspace_id");

-- Foreign keys
ALTER TABLE "kanban_workspaces" ADD CONSTRAINT "kanban_workspaces_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kanban_workspaces" ADD CONSTRAINT "kanban_workspaces_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kanban_workspace_members" ADD CONSTRAINT "kanban_workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "kanban_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kanban_workspace_members" ADD CONSTRAINT "kanban_workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kanban_boards" ADD CONSTRAINT "kanban_boards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "kanban_workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
