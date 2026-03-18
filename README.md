# sax-backend

Backend da aplicação SAX: usuários, login, lojas (warehouses) e imóveis. Compatível com **sax-frontend-pdv** (painel admin) e **sax-site-front** (site imobiliário).

- **Stack:** Node.js, TypeScript, Express, Prisma, PostgreSQL
- **Auth:** JWT; login compatível com a tela de signin do PDV (e-mail, senha, seleção de loja).

## Rotas principais (compatíveis com o PDV)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/data` | Login. Body: `{ email, password, warehouse_id }`. Retorna `{ success, token, user }` com `user.roles` e `user.warehouse`. |
| GET | `/api/warehouse/list` ou `/api/warehouse/list/` | Lista lojas (para o select do login e módulo warehouse). |

## Setup

1. **Requisitos:** Node 18+, PostgreSQL.

2. **Instalar dependências e configurar env:**

```bash
cd sax-backend
npm install
cp .env.example .env
```

3. **Editar `.env`:**  
   - `DATABASE_URL`: connection string do PostgreSQL (ex.: `postgresql://usuario:senha@localhost:5432/sax`).  
   - `JWT_SECRET`: segredo forte em produção (ex.: `openssl rand -base64 32`).  
   - `CORS_ORIGIN`: origens permitidas (ex.: `http://localhost:3031` para o PDV).

4. **Criar banco e rodar seed:**

```bash
npx prisma generate
npx prisma db push
npm run db:seed
```

5. **Subir o servidor:**

```bash
npm run dev
```

O backend sobe em `http://localhost:4000` (ou na `PORT` do `.env`).

## Login no PDV (sax-frontend-pdv)

Após o backend estar no ar:

1. No **sax-frontend-pdv**, configure o env para apontar para o sax-backend:
   - `NEXT_PUBLIC_AUTH_URL_LOCAL=http://localhost:4000`  
   (a tela de login chama `NEXT_PUBLIC_AUTH_URL_LOCAL + '/api/auth/data'` e `.../api/warehouse/list/`).

2. Usuário padrão criado pelo seed:
   - **E-mail:** `admin@sax.com`  
   - **Senha:** `admin123`  
   - **Loja:** selecione "001 - SAX NEGÓCIOS" no dropdown e faça login.

Assim o cadastro e o login refletem no front do painel (account, warehouse e demais módulos que usarem essa API).

## Scripts

- `npm run dev` – desenvolvimento com reload (tsx watch).
- `npm run build` / `npm run start` – build e produção.
- `npm run db:generate` – gera o Prisma Client.
- `npm run db:push` – aplica o schema no banco (sem migrations).
- `npm run db:migrate` – cria/aplica migrations.
- `npm run db:seed` – executa o seed (role admin, warehouse 001, usuário admin).
- `npm run db:studio` – abre o Prisma Studio.
