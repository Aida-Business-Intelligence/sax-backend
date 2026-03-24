#!/bin/sh
set -e

echo "▶ Rodando migrações Prisma..."
./node_modules/.bin/prisma migrate deploy

echo "▶ Iniciando servidor..."
exec node dist/server.js
