import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Função padrão Super Admin (não excluível, permissão total) – id: role-super-admin
  const role = await prisma.role.upsert({
    where: { id: 'role-super-admin' },
    update: { name: 'Super Admin', permissions: JSON.stringify({ '*': [{ feature: '*', menu_id: null }] }) },
    create: {
      id: 'role-super-admin',
      name: 'Super Admin',
      permissions: JSON.stringify({ '*': [{ feature: '*', menu_id: null }] }),
    },
  });

  const warehouse = await prisma.warehouse.upsert({
    where: { id: 'wh-default' },
    update: {
      warehouseName: 'SAX NEGÓCIOS',
      razaoSocial: 'SAX Negócios',
    },
    create: {
      id: 'wh-default',
      warehouseCode: '001',
      warehouseName: 'SAX NEGÓCIOS',
      razaoSocial: 'SAX Negócios',
      type: 'matriz',
      display: true,
    },
  });

  const hash = await bcrypt.hash('123456', 10);
  await prisma.user.upsert({
    where: { email: 'admin@aida.com.br' },
    update: { password: hash, name: 'Administrador', roleId: role.id, warehouseId: warehouse.id, active: true },
    create: {
      email: 'admin@aida.com.br',
      password: hash,
      name: 'Administrador',
      roleId: role.id,
      warehouseId: warehouse.id,
      active: true,
    },
  });
  await prisma.user.upsert({
    where: { email: 'admin@ainda.com' },
    update: { password: hash, name: 'Admin Ainda', roleId: role.id, warehouseId: warehouse.id, active: true },
    create: {
      email: 'admin@ainda.com',
      password: hash,
      name: 'Admin Ainda',
      roleId: role.id,
      warehouseId: warehouse.id,
      active: true,
    },
  });

  await prisma.section.upsert({
    where: { slug: 'frente-mar' },
    update: {},
    create: { title: 'Frente Mar', slug: 'frente-mar', sortOrder: 0, active: true },
  });
  await prisma.section.upsert({
    where: { slug: 'destaques' },
    update: {},
    create: { title: 'Destaques', slug: 'destaques', sortOrder: 1, active: true },
  });

  await prisma.tag.upsert({
    where: { slug: 'lancamento' },
    update: {},
    create: { name: 'Lançamento', slug: 'lancamento', sortOrder: 0, active: true },
  });
  await prisma.tag.upsert({
    where: { slug: 'destaque' },
    update: {},
    create: { name: 'Destaque', slug: 'destaque', sortOrder: 1, active: true },
  });

  console.log('Seed concluído: roles admin e Super Admin, warehouse 001, usuários admin@aida.com.br e admin@ainda.com / 123456, seções e tags iniciais');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
