-- Nome do empreendimento/edificio do imovel (ex.: "Ibiza Towers"). Diferente
-- de "builder" (construtora). Frequentemente visivel nas fotos do imovel mas
-- nao capturado na importacao original.
ALTER TABLE "Property" ADD COLUMN "empreendimento" TEXT;
