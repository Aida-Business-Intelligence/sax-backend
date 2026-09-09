-- Area privativa (util) do imovel, em m2.
-- A coluna "area" ja existente guarda a area TOTAL; o DWV traz as duas
-- separadas e o site deve destacar a privativa.
ALTER TABLE "Property" ADD COLUMN "areaPrivativa" DECIMAL(10,2);
