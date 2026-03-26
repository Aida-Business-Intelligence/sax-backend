import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';

const router = Router();

/**
 * POST /api/users/list
 * Lista usuários para o PDV (admin > Usuários).
 * Body: { page, pageSize, sortField, sortOrder, search?, type? }
 * Resposta: { data: [...], total } no formato esperado pelo front (staffid, firstname, lastname, email, phonenumber, datecreated, role_name).
 */
const listHandler = async (req: Request, res: Response) => {
  try {
    const {
      page = 1,
      pageSize = 10,
      sortField = 'createdAt',
      sortOrder = 'DESC',
      search = '',
    } = req.body as {
      page?: number;
      pageSize?: number;
      sortField?: string;
      sortOrder?: string;
      search?: string;
    };

    const skip = Math.max(0, (Number(page) || 1) - 1) * Math.max(1, Math.min(100, Number(pageSize) || 10));
    const take = Math.max(1, Math.min(100, Number(pageSize) || 10));

    const orderByField = sortField === 'staffid' || sortField === 'datecreated' ? 'createdAt' : sortField === 'firstname' ? 'name' : sortField === 'role_name' ? { role: { name: sortOrder === 'ASC' ? 'asc' : 'desc' } } : 'createdAt';
    const orderBy = typeof orderByField === 'string'
      ? { [orderByField]: sortOrder?.toUpperCase() === 'ASC' ? 'asc' : 'desc' }
      : orderByField;

    const where = search && String(search).trim()
      ? {
          OR: [
            { email: { contains: String(search).trim(), mode: 'insensitive' as const } },
            { name: { contains: String(search).trim(), mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take,
        orderBy: orderBy as { createdAt?: 'asc' | 'desc'; name?: 'asc' | 'desc' } | { role: { name: 'asc' | 'desc' } },
        include: { role: true },
      }),
      prisma.user.count({ where }),
    ]);

    const data = users.map((u) => {
      const nameParts = (u.name || '').trim().split(/\s+/);
      const firstname = nameParts[0] || u.email?.split('@')[0] || '';
      const lastname = nameParts.slice(1).join(' ') || '';
      return {
        staffid: u.id,
        firstname,
        lastname,
        email: u.email,
        phonenumber: (u as { phone?: string | null }).phone ?? null,
        datecreated: u.createdAt,
        role_name: u.role?.name ?? '',
      };
    });

    res.json({ data, total });
  } catch (e) {
    console.error('users list error', e);
    res.status(500).json({ message: 'Erro ao listar usuários', data: [], total: 0 });
  }
};
router.post('/list', listHandler);
router.post('/list/', listHandler);

/**
 * POST /api/users/create
 * POST /api/users/create/
 * Cria usuário (PDV admin > Usuários > Novo).
 */
async function createUser(req: Request, res: Response) {
  try {
    const b = (req.body || {}) as {
      firstname?: string;
      lastname?: string;
      email?: string;
      password?: string;
      role?: string;
      warehouse?: string[];
      phonenumber?: string;
    };
    const email = (b.email && String(b.email).trim().toLowerCase()) || '';
    const password = (b.password && String(b.password).trim()) || '';
    if (!email || !password) {
      res.status(400).json({ message: 'E-mail e senha são obrigatórios' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ message: 'Senha deve ter pelo menos 6 caracteres' });
      return;
    }
    const roleId = b.role && String(b.role).trim();
    if (!roleId) {
      res.status(400).json({ message: 'Função (role) é obrigatória' });
      return;
    }
    const roleExists = await prisma.role.findUnique({ where: { id: roleId } });
    if (!roleExists) {
      res.status(400).json({ message: 'Função (role) inválida ou não encontrada' });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ message: 'Já existe um usuário com este e-mail' });
      return;
    }
    const name = [b.firstname, b.lastname].filter(Boolean).join(' ').trim() || email.split('@')[0];
    const rawWarehouse = Array.isArray(b.warehouse) && b.warehouse[0] ? String(b.warehouse[0]).trim() : null;
    let warehouseId: string | null = null;
    if (rawWarehouse) {
      const warehouseExists = await prisma.warehouse.findUnique({ where: { id: rawWarehouse } });
      if (!warehouseExists) {
        res.status(400).json({ message: 'Loja (warehouse) inválida ou não encontrada' });
        return;
      }
      warehouseId = rawWarehouse;
    }
    const hashed = await bcrypt.hash(password, 10);
    const phone = b.phonenumber ? String(b.phonenumber).trim() : null;

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name,
        roleId,
        warehouseId,
        ...(phone ? { phone } : {}),
        active: true,
      },
    });

    res.status(201).json({
      data: { staffid: user.id },
      status: true,
      message: 'Usuário criado com sucesso',
    });
  } catch (e) {
    console.error('users create error', e);
    res.status(500).json({ message: 'Erro ao criar usuário' });
  }
}

router.post('/create', createUser);
router.post('/create/', createUser);

/**
 * GET /api/users/get/:id
 * Retorna um usuário para edição (formato esperado pelo PDV).
 */
async function getById(req: Request, res: Response) {
  try {
    const id = (req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ message: 'ID do usuário é obrigatório' });
      return;
    }
    const u = await prisma.user.findUnique({
      where: { id },
      include: {
        role: true,
        warehouse: true,
        hrEmployee: { select: { id: true, fullName: true, status: true } },
      },
    });
    if (!u) {
      res.status(404).json({ message: 'Usuário não encontrado' });
      return;
    }
    const nameParts = (u.name || '').trim().split(/\s+/);
    const firstname = nameParts[0] || u.email?.split('@')[0] || '';
    const lastname = nameParts.slice(1).join(' ') || '';
    const hr = (u as { hrEmployee?: { id: string; fullName: string; status: string } | null }).hrEmployee;
    const data = {
      staffid: u.id,
      firstname,
      lastname,
      email: u.email,
      phonenumber: (u as { phone?: string | null }).phone ?? null,
      role: u.roleId,
      role_name: u.role?.name ?? '',
      warehouse: u.warehouseId ? [u.warehouseId] : [],
      admin: u.role?.name === 'Super Admin' ? '1' : '0',
      hr_employee_id: hr?.id ?? null,
      hr_employee_name: hr?.fullName ?? null,
      hr_employee_status: hr?.status ?? null,
    };
    res.json({ data });
  } catch (e) {
    console.error('users get error', e);
    res.status(500).json({ message: 'Erro ao buscar usuário' });
  }
}

router.get('/get/:id', getById);
router.get('/get/:id/', getById);

/**
 * POST /api/users/update/:id
 * Atualiza um usuário (nome, email, role, warehouse, senha opcional).
 */
async function update(req: Request, res: Response) {
  try {
    const id = (req.params.id || '').trim();
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body) as Record<string, unknown>;
      } catch {
        res.status(400).json({ message: 'Body inválido (JSON esperado)' });
        return;
      }
    }
    const b = (body || {}) as {
      staffid?: string;
      firstname?: string;
      lastname?: string;
      email?: string;
      password?: string;
      role?: string;
      warehouse?: string[];
      admin?: string;
      active?: boolean;
      phonenumber?: string;
    };
    if (!id) {
      res.status(400).json({ message: 'ID do usuário é obrigatório' });
      return;
    }
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Usuário não encontrado' });
      return;
    }
    const name = [b.firstname, b.lastname].filter(Boolean).join(' ').trim() || existing.name;
    const rawWarehouse = Array.isArray(b.warehouse) && b.warehouse[0] ? String(b.warehouse[0]).trim() : null;
    const warehouseId = rawWarehouse && rawWarehouse.length > 0 ? rawWarehouse : (existing.warehouseId ?? null);
    const roleId = b.role && String(b.role).trim().length > 0 ? String(b.role).trim() : undefined;

    const data: { name?: string; email?: string; roleId?: string; warehouseId?: string | null; password?: string; active?: boolean; phone?: string | null } = {
      name: name || undefined,
      email: (b.email && String(b.email).trim()) || undefined,
      ...(roleId && { roleId }),
      warehouseId: warehouseId ?? null,
      ...(typeof b.active === 'boolean' && { active: b.active }),
      phone: b.phonenumber !== undefined ? (b.phonenumber ? String(b.phonenumber).trim() : null) : undefined,
    };
    if (b.password && String(b.password).trim().length >= 6) {
      data.password = await bcrypt.hash(String(b.password).trim(), 10);
    }
    const toUpdate = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as typeof data;
    if (Object.keys(toUpdate).length === 0) {
      res.json({ data: existing, status: true });
      return;
    }
    if (toUpdate.roleId) {
      const roleExists = await prisma.role.findUnique({ where: { id: toUpdate.roleId } });
      if (!roleExists) {
        res.status(400).json({ message: 'Função (role) inválida ou não encontrada' });
        return;
      }
    }
    if (toUpdate.warehouseId !== undefined && toUpdate.warehouseId !== null) {
      const warehouseExists = await prisma.warehouse.findUnique({ where: { id: toUpdate.warehouseId } });
      if (!warehouseExists) {
        res.status(400).json({ message: 'Loja (warehouse) inválida ou não encontrada' });
        return;
      }
    }
    const updated = await prisma.user.update({
      where: { id },
      data: toUpdate,
    });
    res.json({ data: updated, status: true });
  } catch (e) {
    console.error('users update error', e);
    const message = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : 'Erro ao atualizar usuário';
    res.status(500).json({ message });
  }
}

router.post('/update/:id', update);
router.post('/update/:id/', update);

/**
 * POST /api/users/deactivate
 * Desativa usuários (active = false). Body: { rows: string[] }
 */
async function deactivate(req: Request, res: Response) {
  try {
    const body = req.body as { rows?: string[] };
    const ids = Array.isArray(body?.rows) ? body.rows.filter((id) => id && String(id).trim()) : [];
    if (ids.length === 0) {
      res.status(400).json({ message: 'Nenhum usuário informado', status: false });
      return;
    }
    await prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { active: false },
    });
    res.json({ status: true, message: 'Usuário(s) desativado(s) com sucesso' });
  } catch (e) {
    console.error('users deactivate error', e);
    res.status(500).json({ message: 'Erro ao desativar usuários', status: false });
  }
}

/**
 * POST /api/users/remove
 * Exclui usuários definitivamente do banco. Body: { rows: string[] }
 */
async function remove(req: Request, res: Response) {
  try {
    const body = req.body as { rows?: string[] };
    const ids = Array.isArray(body?.rows) ? body.rows.filter((id) => id && String(id).trim()) : [];
    if (ids.length === 0) {
      res.status(400).json({ message: 'Nenhum usuário informado', status: false });
      return;
    }
    await prisma.user.deleteMany({
      where: { id: { in: ids } },
    });
    res.json({ status: true, message: 'Usuário(s) excluído(s) com sucesso' });
  } catch (e) {
    console.error('users remove error', e);
    res.status(500).json({ message: 'Erro ao excluir usuários', status: false });
  }
}

router.post('/deactivate', deactivate);
router.post('/deactivate/', deactivate);
router.post('/remove', remove);
router.post('/remove/', remove);

export default router;
