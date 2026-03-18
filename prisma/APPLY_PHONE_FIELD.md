# Aplicar campo phone no User (sem corrigir migrações)

O comando `prisma migrate dev` está falhando porque a migração antiga `add_proprietario_status` exige que a tabela `Proprietario` já exista no banco shadow, e não há migração que a crie.

**Solução rápida** – aplicar só o schema atual (incluindo a coluna `phone` em `User`):

```bash
npx prisma db push
npx prisma generate
```

- `db push`: sincroniza o `schema.prisma` com o banco (cria/altera tabelas e colunas). Adiciona a coluna `phone` na tabela `User`.
- `generate`: regenera o cliente Prisma para usar o novo campo no código.

Depois disso, reinicie o backend e o telefone poderá ser salvo e exibido.

---

**Se no futuro quiser usar `migrate dev` de novo**, será preciso ajustar o histórico de migrações (por exemplo: ter uma migração inicial que crie todas as tabelas, ou marcar/resolver a migração `add_proprietario_status`). Por enquanto, `db push` resolve o problema do campo phone.
