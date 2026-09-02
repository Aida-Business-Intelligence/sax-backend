/**
 * Redefine a senha de um usuário do painel.
 *
 * Existe porque o sistema NÃO tem recuperação de senha: não há rota de
 * "esqueci minha senha" no backend, então um admin que perde a senha fica
 * trancado do lado de fora sem nenhuma saída pela interface.
 *
 * Uso (na máquina que enxerga o banco, com DATABASE_URL configurada):
 *
 *   npm run db:reset-senha -- admin@aida.com.br "NovaSenhaForte123"
 *
 * Para só conferir se o usuário existe, sem trocar nada:
 *
 *   npm run db:reset-senha -- admin@aida.com.br --conferir
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SENHA_MINIMA = 6;

function sair(mensagem: string, codigo = 1): never {
  console.error(mensagem);
  process.exit(codigo);
}

async function main() {
  const [emailBruto, segundoArg] = process.argv.slice(2);

  if (!emailBruto) {
    sair(
      'Faltou o e-mail.\n\n' +
        '  npm run db:reset-senha -- admin@aida.com.br "NovaSenhaForte123"\n' +
        '  npm run db:reset-senha -- admin@aida.com.br --conferir'
    );
  }

  const email = emailBruto.toLowerCase().trim();
  const apenasConferir = segundoArg === '--conferir';

  const usuario = await prisma.user.findUnique({
    where: { email },
    include: { role: true, warehouse: true },
  });

  if (!usuario) {
    const existentes = await prisma.user.findMany({
      select: { email: true, active: true },
      orderBy: { email: 'asc' },
      take: 20,
    });
    console.error(`Nenhum usuário com o e-mail "${email}".`);
    if (existentes.length > 0) {
      console.error('\nUsuários que existem no banco:');
      existentes.forEach((u) => console.error(`  - ${u.email}${u.active ? '' : '  (INATIVO)'}`));
    } else {
      console.error('\nO banco não tem nenhum usuário. Rode antes: npm run db:seed');
    }
    process.exit(1);
  }

  console.log(`Usuário encontrado: ${usuario.email}`);
  console.log(`  nome:  ${usuario.name}`);
  console.log(`  ativo: ${usuario.active ? 'sim' : 'NÃO — mesmo com a senha certa o login é recusado'}`);
  console.log(`  perfil: ${usuario.role?.name ?? '(sem perfil)'}`);
  console.log(`  loja:   ${usuario.warehouse?.warehouseName ?? '(sem loja)'}`);

  if (apenasConferir) {
    console.log('\nModo conferência: nada foi alterado.');
    return;
  }

  const novaSenha = segundoArg;
  if (!novaSenha) {
    sair('\nFaltou a nova senha. Coloque entre aspas se tiver espaço ou caractere especial.');
  }
  if (novaSenha.length < SENHA_MINIMA) {
    sair(`\nA senha precisa ter pelo menos ${SENHA_MINIMA} caracteres (o painel recusa senhas menores).`);
  }

  const hash = await bcrypt.hash(novaSenha, 10);
  await prisma.user.update({
    where: { email },
    data: { password: hash, active: true },
  });

  console.log('\nSenha redefinida e usuário marcado como ativo.');
  console.log('Entre no painel com esse e-mail e a senha que você acabou de definir.');
}

main()
  .catch((e) => {
    console.error('Falhou:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
