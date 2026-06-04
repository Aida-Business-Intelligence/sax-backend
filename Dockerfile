FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package*.json ./

# 🔥 IMPORTANTE: evita rodar postinstall (prisma generate automático)
RUN npm ci --ignore-scripts

COPY . .

# Prisma + build controlados manualmente
RUN npx prisma generate && npm run build

# ──────────────────────────────────────────
FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 appuser

COPY package*.json ./

# Mantém ignore-scripts aqui também (já estava certo)
RUN npm ci --omit=dev --ignore-scripts

# Copia Prisma CLI e engines do builder
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

# Copia schema
COPY prisma ./prisma

# 🔥 Gera client no ambiente correto (Alpine)
RUN npx prisma generate

# Copia build
COPY --from=builder /app/dist ./dist

# Permissões
RUN mkdir -p uploads \
 && chown -R appuser:nodejs uploads \
      node_modules/@prisma \
      node_modules/.prisma \
      node_modules/prisma \
      node_modules/.bin/prisma

# Entrypoint
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

USER appuser
EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]