FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# prisma generate não precisa de DATABASE_URL (gera apenas o client TypeScript)
RUN npx prisma generate && npm run build

# ──────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser

COPY package*.json ./
# --ignore-scripts: postinstall roda "prisma generate", mas prisma CLI ainda não existe
# nesta etapa (omit=dev). O generate explícito vem abaixo após copiar o Prisma do builder.
RUN npm ci --omit=dev --ignore-scripts

# Copia CLI do Prisma (é devDependency, não vem no npm ci --omit=dev)
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
COPY prisma ./prisma

# Regenera o Prisma Client NESTA stage (runner) — garante que os
# binários do engine correspondem EXATAMENTE a esta plataforma Alpine.
# Roda como root, então tem permissão de escrita e detecção de OpenSSL funciona.
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads \
 && chown -R appuser:nodejs uploads \
      node_modules/@prisma \
      node_modules/.prisma \
      node_modules/prisma \
      node_modules/.bin/prisma

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

USER appuser
EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
