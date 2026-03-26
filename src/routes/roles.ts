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
  // PDV — alinhado a `DEFAULT_MENU` / admin/functions/constants (RH, CRM, cadastros, site, admin).
  { label: 'Leads', capability: 'leads', feature: 'visualizar_todos', name: 'Leads — Ver todos (equipe / imobiliária)', id: 'leads-ver-todos', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'visualizar_proprios', name: 'Leads — Ver apenas os meus', id: 'leads-ver-proprios', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'criar', name: 'Leads — Criar', id: 'leads-criar', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'editar_todos', name: 'Leads — Editar qualquer um', id: 'leads-edit-todos', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'editar_proprios', name: 'Leads — Editar apenas os meus', id: 'leads-edit-proprios', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'excluir_todos', name: 'Leads — Excluir qualquer um', id: 'leads-exc-todos', menu_id: null },
  { label: 'Leads', capability: 'leads', feature: 'excluir_proprios', name: 'Leads — Excluir apenas os meus', id: 'leads-exc-proprios', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'visualizar_todos', name: 'Negócios — Ver todos', id: 'neg-ver-todos', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'visualizar_proprios', name: 'Negócios — Ver apenas os meus', id: 'neg-ver-proprios', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'criar', name: 'Negócios — Criar', id: 'neg-criar', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'editar_todos', name: 'Negócios — Editar qualquer um', id: 'neg-edit-todos', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'editar_proprios', name: 'Negócios — Editar apenas os meus', id: 'neg-edit-proprios', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'excluir_todos', name: 'Negócios — Excluir qualquer um', id: 'neg-exc-todos', menu_id: null },
  { label: 'Negócios', capability: 'negocios', feature: 'excluir_proprios', name: 'Negócios — Excluir apenas os meus', id: 'neg-exc-proprios', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'visualizar_todos', name: 'Atividades — Ver todas', id: 'ativ-ver-todos', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'visualizar_proprios', name: 'Atividades — Ver apenas as minhas', id: 'ativ-ver-proprios', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'criar', name: 'Atividades — Criar', id: 'ativ-criar', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'editar_todos', name: 'Atividades — Editar qualquer uma', id: 'ativ-edit-todos', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'editar_proprios', name: 'Atividades — Editar apenas as minhas', id: 'ativ-edit-proprios', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'excluir_todos', name: 'Atividades — Excluir qualquer uma', id: 'ativ-exc-todos', menu_id: null },
  { label: 'Atividades', capability: 'atividades', feature: 'excluir_proprios', name: 'Atividades — Excluir apenas as minhas', id: 'ativ-exc-proprios', menu_id: null },
  { label: 'Imóveis', capability: 'propriedades', feature: 'visualizar', name: 'Visualizar imóveis', id: 'prop-visualizar', menu_id: null },
  { label: 'Imóveis', capability: 'propriedades', feature: 'criar', name: 'Criar imóveis', id: 'prop-criar', menu_id: null },
  { label: 'Imóveis', capability: 'propriedades', feature: 'editar', name: 'Editar imóveis', id: 'prop-editar', menu_id: null },
  { label: 'Imóveis', capability: 'propriedades', feature: 'excluir', name: 'Excluir imóveis', id: 'prop-excluir', menu_id: null },
  { label: 'Proprietários', capability: 'proprietarios', feature: 'visualizar', name: 'Visualizar proprietários', id: 'propr-visualizar', menu_id: null },
  { label: 'Proprietários', capability: 'proprietarios', feature: 'criar', name: 'Criar proprietários', id: 'propr-criar', menu_id: null },
  { label: 'Proprietários', capability: 'proprietarios', feature: 'editar', name: 'Editar proprietários', id: 'propr-editar', menu_id: null },
  { label: 'Proprietários', capability: 'proprietarios', feature: 'excluir', name: 'Excluir proprietários', id: 'propr-excluir', menu_id: null },
  { label: 'Imobiliárias', capability: 'imobiliarias', feature: 'visualizar', name: 'Visualizar imobiliárias', id: 'imob-visualizar', menu_id: null },
  { label: 'Imobiliárias', capability: 'imobiliarias', feature: 'criar', name: 'Criar imobiliárias', id: 'imob-criar', menu_id: null },
  { label: 'Imobiliárias', capability: 'imobiliarias', feature: 'editar', name: 'Editar imobiliárias', id: 'imob-editar', menu_id: null },
  { label: 'Imobiliárias', capability: 'imobiliarias', feature: 'excluir', name: 'Excluir imobiliárias', id: 'imob-excluir', menu_id: null },
  { label: 'Seções do site (cadastro)', capability: 'secoes', feature: 'visualizar', name: 'Visualizar seções', id: 'sec-visualizar', menu_id: null },
  { label: 'Seções do site (cadastro)', capability: 'secoes', feature: 'criar', name: 'Criar seções', id: 'sec-criar', menu_id: null },
  { label: 'Seções do site (cadastro)', capability: 'secoes', feature: 'editar', name: 'Editar seções', id: 'sec-editar', menu_id: null },
  { label: 'Seções do site (cadastro)', capability: 'secoes', feature: 'excluir', name: 'Excluir seções', id: 'sec-excluir', menu_id: null },
  { label: 'Tags de imóveis', capability: 'tags_imoveis', feature: 'visualizar', name: 'Visualizar tags', id: 'tags-visualizar', menu_id: null },
  { label: 'Tags de imóveis', capability: 'tags_imoveis', feature: 'criar', name: 'Criar tags', id: 'tags-criar', menu_id: null },
  { label: 'Tags de imóveis', capability: 'tags_imoveis', feature: 'editar', name: 'Editar tags', id: 'tags-editar', menu_id: null },
  { label: 'Tags de imóveis', capability: 'tags_imoveis', feature: 'excluir', name: 'Excluir tags', id: 'tags-excluir', menu_id: null },
  { label: 'Recursos Humanos', capability: 'rh', feature: 'visualizar', name: 'Visualizar RH (visão geral e colaboradores)', id: 'rh-visualizar', menu_id: null },
  { label: 'Recursos Humanos', capability: 'rh', feature: 'criar', name: 'Criar colaboradores', id: 'rh-criar', menu_id: null },
  { label: 'Recursos Humanos', capability: 'rh', feature: 'editar', name: 'Editar colaboradores', id: 'rh-editar', menu_id: null },
  { label: 'Recursos Humanos', capability: 'rh', feature: 'excluir', name: 'Excluir colaboradores', id: 'rh-excluir', menu_id: null },
  { label: 'Gestão de Site', capability: 'gestao_site', feature: 'visualizar', name: 'Visualizar gestão de site', id: 'gsite-visualizar', menu_id: null },
  { label: 'Gestão de Site', capability: 'gestao_site', feature: 'editar', name: 'Editar gestão de site', id: 'gsite-editar', menu_id: null },
  { label: 'Help Desk', capability: 'helpdesk', feature: 'visualizar', name: 'Visualizar Help Desk', id: 'hd-visualizar', menu_id: null },
  { label: 'Help Desk', capability: 'helpdesk', feature: 'editar', name: 'Atender / editar tickets', id: 'hd-editar', menu_id: null },
  { label: 'Funções (permissões)', capability: 'admin_funcoes', feature: 'visualizar', name: 'Visualizar funções', id: 'afunc-visualizar', menu_id: null },
  { label: 'Funções (permissões)', capability: 'admin_funcoes', feature: 'criar', name: 'Criar funções', id: 'afunc-criar', menu_id: null },
  { label: 'Funções (permissões)', capability: 'admin_funcoes', feature: 'editar', name: 'Editar funções', id: 'afunc-editar', menu_id: null },
  { label: 'Funções (permissões)', capability: 'admin_funcoes', feature: 'excluir', name: 'Excluir funções', id: 'afunc-excluir', menu_id: null },
  { label: 'Menu do sistema', capability: 'admin_menu', feature: 'visualizar', name: 'Visualizar itens de menu', id: 'amenu-visualizar', menu_id: null },
  { label: 'Menu do sistema', capability: 'admin_menu', feature: 'editar', name: 'Editar menu lateral', id: 'amenu-editar', menu_id: null },
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
