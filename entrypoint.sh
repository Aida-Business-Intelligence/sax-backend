#!/bin/sh
set -e

echo "▶ Rodando migrações Prisma..."
# Resolve estado "failed" da migração de helpdesk caso o container anterior tenha
# falhado tentando ALTER TABLE antes do CREATE TABLE existir.
# Seguro e idempotente: erro é ignorado se a migração já estiver em outro estado.
./node_modules/.bin/prisma migrate resolve --rolled-back 20260328190000_add_helpdesk_tables 2>/dev/null || true
./node_modules/.bin/prisma migrate resolve --rolled-back 20260329140000_helpdesk_ticket_protocol 2>/dev/null || true
./node_modules/.bin/prisma migrate deploy

echo "▶ Iniciando servidor..."
exec node dist/server.js
