import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

/** Gera um id legível no padrão role-{slug}-{sufixo} para novas funções (ex: role-financeiro-a1b2c3) */
function generateRoleId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\u0300/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 24) || 'funcao';
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;
  return `role-${slug}-${suffix}`;
}

/** Formato esperado pelo front: lista plana com label em cada permissão */
const DEFAULT_PERMISSIONS = [
  { label: 'Contas a pagar', capability: 'contas_pagar', feature: 'visualizar', name: 'Visualizar contas a pagar', id: 'cp-visualizar', menu_id: null },
  { label: 'Contas a pagar', capability: 'contas_pagar', feature: 'lancar', name: 'Lançar contas a pagar', id: 'cp-lancar', menu_id: null },
  { label: 'Contas a pagar', capability: 'contas_pagar', feature: 'baixar', name: 'Baixar contas a pagar', id: 'cp-baixar', menu_id: null },
  { label: 'Contas a pagar', capability: 'contas_pagar', feature: 'editar', name: 'Editar contas a pagar', id: 'cp-editar', menu_id: null },
  { label: 'Contas a pagar', capability: 'contas_pagar', feature: 'excluir', name: 'Excluir contas a pagar', id: 'cp-excluir', menu_id: null },
  { label: 'Contas a receber', capability: 'contas_receber', feature: 'visualizar', name: 'Visualizar contas a receber', id: 'cr-visualizar', menu_id: null },
  { label: 'Contas a receber', capability: 'contas_receber', feature: 'lancar', name: 'Lançar contas a receber', id: 'cr-lancar', menu_id: null },
  { label: 'Contas a receber', capability: 'contas_receber', feature: 'baixar', name: 'Baixar contas a receber', id: 'cr-baixar', menu_id: null },
  { label: 'Contas a receber', capability: 'contas_receber', feature: 'editar', name: 'Editar contas a receber', id: 'cr-editar', menu_id: null },
  { label: 'Contas a receber', capability: 'contas_receber', feature: 'excluir', name: 'Excluir contas a receber', id: 'cr-excluir', menu_id: null },
  { label: 'Clientes', capability: 'clientes', feature: 'visualizar', name: 'Visualizar clientes', id: 'cli-visualizar', menu_id: null },
  { label: 'Clientes', capability: 'clientes', feature: 'criar', name: 'Criar clientes', id: 'cli-criar', menu_id: null },
  { label: 'Clientes', capability: 'clientes', feature: 'editar', name: 'Editar clientes', id: 'cli-editar', menu_id: null },
  { label: 'Clientes', capability: 'clientes', feature: 'excluir', name: 'Excluir clientes', id: 'cli-excluir', menu_id: null },
  { label: 'Usuários', capability: 'usuarios', feature: 'visualizar', name: 'Visualizar usuários', id: 'usr-visualizar', menu_id: null },
  { label: 'Usuários', capability: 'usuarios', feature: 'criar', name: 'Criar usuários', id: 'usr-criar', menu_id: null },
  { label: 'Usuários', capability: 'usuarios', feature: 'editar', name: 'Editar usuários', id: 'usr-editar', menu_id: null },
  { label: 'Usuários', capability: 'usuarios', feature: 'excluir', name: 'Excluir usuários', id: 'usr-excluir', menu_id: null },
  { label: 'Configurações', capability: 'configuracoes', feature: 'visualizar', name: 'Visualizar configurações', id: 'cfg-view', menu_id: null },
  { label: 'Configurações', capability: 'configuracoes', feature: 'editar', name: 'Editar configurações', id: 'cfg-editar', menu_id: null },
];

/**
 * GET /api/roles/permissions ou /api/roles/permissions/
 * Lista de permissões para o formulário de criação/edição de função.
 */
async function permissions(req: Request, res: Response) {
  try {
    res.json(DEFAULT_PERMISSIONS);
  } catch (e) {
    console.error('roles permissions error', e);
    res.status(500).json({ message: 'Erro ao listar permissões', data: [] });
  }
}

/**
 * GET ou POST /api/roles/list - Lista funções com paginação e busca.
 * GET: parâmetros em query. POST: parâmetros em body (compatibilidade).
 */
async function list(req: Request, res: Response) {
  try {
    const source = req.method === 'GET' ? req.query : req.body;
    const query = (source || {}) as Record<string, string>;
    const page = Math.max(0, parseInt(query.page as string, 10) || 0);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize as string, 10) || 10));
    const search = (query.search || '').trim().toLowerCase();
    const orderBy = query.sortField === 'name' ? 'name' : 'id';
    const sortOrder = (query.sortOrder || 'asc').toLowerCase() as 'asc' | 'desc';

    const where = search
      ? { name: { contains: search, mode: 'insensitive' as const } }
      : {};

    const [roles, total] = await Promise.all([
      prisma.role.findMany({
        where,
        orderBy: { [orderBy]: sortOrder },
        skip: page * pageSize,
        take: pageSize,
        select: { id: true, name: true, permissions: true, createdAt: true, updatedAt: true },
      }),
      prisma.role.count({ where }),
    ]);

    const data = roles.map((r) => ({
      ...r,
      roleid: r.id,
      display: '1',
    }));
    res.json({ data, total });
  } catch (e) {
    console.error('roles list error', e);
    res.status(500).json({ message: 'Erro ao listar funções', data: [], total: 0 });
  }
}

/**
 * GET /api/roles/get/:id
 * Retorna uma função por id.
 */
async function get(req: Request, res: Response) {
  try {
    const id = (req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ message: 'ID obrigatório' });
      return;
    }
    const role = await prisma.role.findUnique({
      where: { id },
      select: { id: true, name: true, permissions: true, createdAt: true, updatedAt: true },
    });
    if (!role) {
      res.status(404).json({ message: 'Função não encontrada' });
      return;
    }
    const permissionsParsed =
      typeof role.permissions === 'string'
        ? (() => {
            try {
              return JSON.parse(role.permissions || '{}');
            } catch {
              return {};
            }
          })()
        : role.permissions ?? {};
    res.json({
      data: {
        ...role,
        permissions: permissionsParsed,
        roleid: role.id,
        display: '1',
      },
    });
  } catch (e) {
    console.error('roles get error', e);
    res.status(500).json({ message: 'Erro ao buscar função' });
  }
}

/**
 * POST /api/roles/create ou /api/roles/create/
 * Cria nova função. Body: { name: string, permissions: object }
 */
async function create(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const name = (body.name || '').trim();
    if (!name) {
      res.status(400).json({ message: 'Nome da função é obrigatório' });
      return;
    }
    const permissionsPayload = body.permissions || {};
    const permissionsJson =
      typeof permissionsPayload === 'string' ? permissionsPayload : JSON.stringify(permissionsPayload);

    const id = generateRoleId(name);
    const role = await prisma.role.create({
      data: {
        id,
        name,
        permissions: permissionsJson,
      },
      select: { id: true, name: true, permissions: true, createdAt: true, updatedAt: true },
    });
    res.status(201).json({
      data: { ...role, roleid: role.id },
      message: 'Função criada com sucesso',
    });
  } catch (e) {
    console.error('roles create error', e);
    res.status(500).json({ message: 'Erro ao criar função' });
  }
}

/**
 * PATCH /api/roles/update/:id ou POST /api/roles/update/:id
 * Atualiza função. Body: { name?: string, permissions?: object }
 */
async function update(req: Request, res: Response) {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ message: 'ID obrigatório' });
      return;
    }
    const body = req.body || {};
    const name = (body.name || '').trim();
    const permissionsPayload = body.permissions;
    const updateData: { name?: string; permissions?: string } = {};
    if (name) updateData.name = name;
    if (permissionsPayload !== undefined) {
      updateData.permissions =
        typeof permissionsPayload === 'string' ? permissionsPayload : JSON.stringify(permissionsPayload);
    }
    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ message: 'Nenhum dado para atualizar' });
      return;
    }
    const role = await prisma.role.update({
      where: { id },
      data: updateData,
      select: { id: true, name: true, permissions: true, createdAt: true, updatedAt: true },
    });
    res.json({ data: { ...role, roleid: role.id }, message: 'Função atualizada' });
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err?.code === 'P2025') {
      res.status(404).json({ message: 'Função não encontrada' });
      return;
    }
    console.error('roles update error', e);
    res.status(500).json({ message: 'Erro ao atualizar função' });
  }
}

/**
 * POST /api/roles/remove
 * Remove funções. Body: { rows: string[] } (array de ids)
 */
async function remove(req: Request, res: Response) {
  try {
    const body = req.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) {
      res.status(400).json({ message: 'Nenhuma função selecionada' });
      return;
    }
    await prisma.role.deleteMany({
      where: { id: { in: rows } },
    });
    res.json({ message: 'Funções excluídas', count: rows.length });
  } catch (e) {
    console.error('roles remove error', e);
    res.status(500).json({ message: 'Erro ao excluir funções' });
  }
}

router.get('/list', list);
router.get('/list/', list);
router.post('/list', list);
router.post('/list/', list);
router.get('/permissions', permissions);
router.get('/permissions/', permissions);
router.get('/get/:id', get);
router.get('/get/:id/', get);
router.post('/create', create);
router.post('/create/', create);
router.patch('/update/:id', update);
router.post('/update/:id', update);
router.post('/remove', remove);

export default router;
