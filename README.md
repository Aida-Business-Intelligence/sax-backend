# sax-backend

Backend da aplicação SAX: usuários, login, lojas (warehouses) e imóveis. Compatível com **sax-frontend-pdv** (painel admin) e **sax-site-front** (site imobiliário).

- **Stack:** Node.js 20, TypeScript, Express, Prisma 5, PostgreSQL 16
- **Auth:** JWT; login compatível com a tela de signin do PDV (e-mail, senha, seleção de loja)
- **Imagem Docker:** `aidabusiness/sax-backend` (:latest | :dev)

## Rotas principais

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/data` | Login. Body: `{ email, password, warehouse_id }`. Retorna `{ success, token, user }` com `user.roles` e `user.warehouse`. |
| GET | `/api/warehouse/list` | Lista lojas (para o select do login e módulo warehouse). |

## Setup local

```bash
npm install
cp .env.example .env
# editar .env com suas credenciais do PostgreSQL
npx prisma generate
npx prisma db push
npm run db:seed
npm run dev  # http://localhost:4000
```

### Variáveis de ambiente (`.env.example`)

| Variável | Descrição |
|----------|-----------|
| `DATABASE_URL` | Connection string PostgreSQL |
| `JWT_SECRET` | Segredo para assinar tokens (produção: `openssl rand -base64 32`) |
| `JWT_EXPIRES_IN` | Validade do token (padrão: `7d`) |
| `CORS_ORIGIN` | Origens permitidas, separadas por vírgula |

## Docker

```bash
# Build local
docker build -t sax-backend .

# Subir a stack completa (API + PostgreSQL + pgAdmin)
docker compose up -d
```

A stack inclui:

| Serviço | Porta | Descrição |
|---------|-------|-----------|
| `api` | `4000` | Backend Express |
| `postgres` | `5432` (interna) | PostgreSQL 16 Alpine |
| `pgadmin` | `5050` | pgAdmin 4 em `/db/` |
| `watchtower` | — | Auto-deploy: detecta novas imagens no DockerHub |

## CI/CD

Push para `main` → CI builda `aidabusiness/sax-backend:latest` → Watchtower atualiza o container em produção.
Push para `develop` → CI builda `aidabusiness/sax-backend:dev` → Watchtower atualiza homologação.

## Login no PDV

Após o backend estar no ar, no **sax-frontend-pdv** configure:

- `NEXT_PUBLIC_AUTH_URL_LOCAL=http://localhost:4000`

Usuário seed: `admin@sax.com` / `admin123` / loja "001 - SAX NEGÓCIOS".

Assim o cadastro e o login refletem no front do painel (account, warehouse e demais módulos que usarem essa API).

## Scripts

- `npm run dev` – desenvolvimento com reload (tsx watch).
- `npm run build` / `npm run start` – build e produção.
- `npm run db:generate` – gera o Prisma Client.
- `npm run db:push` – aplica o schema no banco (sem migrations).
- `npm run db:migrate` – cria/aplica migrations.
- `npm run db:seed` – executa o seed (role admin, warehouse 001, usuário admin).
- `npm run db:studio` – abre o Prisma Studio.
