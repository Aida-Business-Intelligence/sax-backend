#!/bin/sh
set -e

echo "▶ Rodando migrações Prisma..."
npx prisma migrate deploy

echo "▶ Iniciando servidor..."
exec node dist/server.js
