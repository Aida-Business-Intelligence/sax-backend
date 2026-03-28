-- Cadastro de fornecedores por loja
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "person_type" TEXT NOT NULL DEFAULT 'pj',
    "document" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "supply_kind" TEXT NOT NULL DEFAULT 'service',
    "service_type" TEXT,
    "product_type" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "suppliers_warehouse_id_idx" ON "suppliers"("warehouse_id");
CREATE INDEX "suppliers_supply_kind_idx" ON "suppliers"("supply_kind");

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
