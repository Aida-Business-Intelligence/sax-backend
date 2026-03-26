-- RH: colaboradores com vínculo opcional ao User (credenciais)

CREATE TABLE "hr_employees" (
    "id" TEXT NOT NULL,
    "warehouse_id" TEXT,
    "full_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "document" TEXT,
    "employment_type" TEXT NOT NULL DEFAULT 'fixed_only',
    "department_code" TEXT NOT NULL DEFAULT 'comercial',
    "is_partner_broker" BOOLEAN NOT NULL DEFAULT false,
    "base_salary_monthly" DECIMAL(14,2),
    "commission_notes" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "user_id" TEXT,
    "hired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hr_employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hr_employees_user_id_key" ON "hr_employees"("user_id");
CREATE INDEX "hr_employees_warehouse_id_idx" ON "hr_employees"("warehouse_id");
CREATE INDEX "hr_employees_department_code_idx" ON "hr_employees"("department_code");
CREATE INDEX "hr_employees_status_idx" ON "hr_employees"("status");
CREATE INDEX "hr_employees_employment_type_idx" ON "hr_employees"("employment_type");

ALTER TABLE "hr_employees" ADD CONSTRAINT "hr_employees_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hr_employees" ADD CONSTRAINT "hr_employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
