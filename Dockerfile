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
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser

COPY package*.json ./
# Instala apenas deps de produção
RUN npm ci --omit=dev
# Copia o CLI do Prisma do builder (necessário para migrate deploy)
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines
# Copia o client já gerado no builder (binários nativos do Alpine)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads && chown -R appuser:nodejs uploads

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

USER appuser
EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
