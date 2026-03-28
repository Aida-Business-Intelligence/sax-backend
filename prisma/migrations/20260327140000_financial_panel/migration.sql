-- Módulo financeiro PDV (painel)
CREATE TABLE "fin_categories" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fin_bank_accounts" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bank_name" TEXT,
    "agency" TEXT,
    "account_number" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_bank_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fin_transactions" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "category_id" TEXT,
    "company" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMP(3),
    "note" TEXT,
    "reference" TEXT,
    "bank_account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fin_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fin_categories_warehouse_id_kind_idx" ON "fin_categories"("warehouse_id", "kind");
CREATE INDEX "fin_bank_accounts_warehouse_id_idx" ON "fin_bank_accounts"("warehouse_id");
CREATE INDEX "fin_transactions_warehouse_id_kind_idx" ON "fin_transactions"("warehouse_id", "kind");
CREATE INDEX "fin_transactions_due_date_idx" ON "fin_transactions"("due_date");
CREATE INDEX "fin_transactions_status_idx" ON "fin_transactions"("status");

ALTER TABLE "fin_categories" ADD CONSTRAINT "fin_categories_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fin_bank_accounts" ADD CONSTRAINT "fin_bank_accounts_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "fin_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "fin_transactions" ADD CONSTRAINT "fin_transactions_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "fin_bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
