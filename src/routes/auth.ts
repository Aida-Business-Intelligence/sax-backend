import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { config } from '../config.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
  warehouse_id: z.string().min(1, 'Selecione uma loja'),
});

/**
 * POST /api/auth/data
 * Login - compatível com sax-frontend-pdv (signin.jsx).
 * Body: { email, password, warehouse_id }
 * Resposta: { success, token, user } com user.roles e user.warehouse no formato esperado pelo PDV.
 */
router.post('/data', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => e.message).join('; ');
      res.status(400).json({ success: false, data: { error: msg } });
      return;
    }

    const { email, password, warehouse_id } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { role: true, warehouse: true },
    });

    if (!user || !user.active) {
      res.status(401).json({ success: false, data: { error: 'E-mail ou senha inválidos' } });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ success: false, data: { error: 'E-mail ou senha inválidos' } });
      return;
    }

    // Verifica se o usuário tem acesso à warehouse informada (opcional: pode ser que qualquer usuário possa escolher qualquer loja)
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: warehouse_id },
    });
    if (!warehouse || !warehouse.display) {
      res.status(400).json({ success: false, data: { error: 'Loja inválida ou inativa' } });
      return;
    }

    const token = jwt.sign(
      { userId: user.id },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    const permissions = (user.role.permissions && JSON.parse(user.role.permissions)) ?? [];
    const isSuperAdmin = user.role.name === 'Super Admin';

    // Formato esperado pelo sax-frontend-pdv (signin.jsx). admin: '1' = Super Admin (acesso total).
    const responseUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      admin: isSuperAdmin ? '1' : '0',
      roles: {
        name: user.role.name,
        permissions: isSuperAdmin ? [] : permissions,
      },
      warehouse: {
        warehouse_id: warehouse.id,
        warehouse_code: warehouse.warehouseCode,
        warehouse_name: warehouse.warehouseName,
        razao_social: warehouse.razaoSocial,
        type: warehouse.type,
        telefone: warehouse.telefone,
        cidade: warehouse.cidade,
        estado: warehouse.estado,
        cep: warehouse.cep,
        display: warehouse.display,
      },
    };

    res.json({
      success: true,
      token,
      user: responseUser,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
