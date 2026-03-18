import { Router } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

function formatWarehouse(w: {
  id: string;
  warehouseCode: string;
  warehouseName: string;
  razaoSocial: string | null;
  type: string | null;
  telefone: string | null;
  email: string | null;
  cidade: string | null;
  estado: string | null;
  cep: string | null;
  address: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cnpj?: string | null;
  ie?: string | null;
  im?: string | null;
  note?: string | null;
  display: boolean;
}) {
  return {
    warehouse_id: w.id,
    warehouse_code: w.warehouseCode,
    warehouse_name: w.warehouseName,
    razao_social: w.razaoSocial,
    type: w.type,
    telefone: w.telefone,
    email: w.email,
    cidade: w.cidade,
    estado: w.estado,
    cep: w.cep,
    address: w.address,
    endereco: w.address,
    numero: w.numero ?? null,
    complemento: w.complemento ?? null,
    bairro: w.bairro ?? null,
    cnpj: w.cnpj ?? null,
    ie: w.ie ?? null,
    im: w.im ?? null,
    note: w.note ?? null,
    display: w.display ? '1' : '0',
  };
}

/**
 * GET /api/warehouse/list ou /api/warehouse/list/
 * Lista lojas - usado no login do PDV (select de loja) e na seção warehouse.
 */
async function listWarehouses(_req: import('express').Request, res: import('express').Response) {
  const list = await prisma.warehouse.findMany({
    orderBy: [{ warehouseCode: 'asc' }],
  });
  res.json(list.map(formatWarehouse));
}

/**
 * GET /api/warehouse/:id - Detalhes de uma loja (para modal e tela de edição).
 */
async function getWarehouse(req: import('express').Request, res: import('express').Response) {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ message: 'ID da loja é obrigatório' });
    return;
  }
  const w = await prisma.warehouse.findUnique({ where: { id } });
  if (!w) {
    res.status(404).json({ message: 'Loja não encontrada' });
    return;
  }
  const formatted = formatWarehouse(w) as Record<string, unknown>;
  formatted.arquivo_nfe = null;
  res.json(formatted);
}

/**
 * PUT /api/warehouse/:id - Atualiza uma loja (ao menos display; outros campos opcionais).
 */
async function updateWarehouse(req: import('express').Request, res: import('express').Response) {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ message: 'ID da loja é obrigatório' });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const display = body.active !== undefined
    ? body.active === '1' || body.active === true
    : body.display !== undefined
      ? body.display === '1' || body.display === true
      : undefined;

  const updateData: {
    display?: boolean;
    warehouseCode?: string;
    warehouseName?: string;
    razaoSocial?: string;
    type?: string;
    telefone?: string;
    email?: string;
    cidade?: string;
    estado?: string;
    cep?: string;
    address?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cnpj?: string;
    ie?: string;
    im?: string;
    note?: string;
  } = {};
  if (display !== undefined) updateData.display = display;
  if (typeof body.warehouse_code === 'string') updateData.warehouseCode = body.warehouse_code;
  if (typeof body.warehouse_name === 'string') updateData.warehouseName = body.warehouse_name;
  if (typeof body.razao_social === 'string') updateData.razaoSocial = body.razao_social;
  if (typeof body.type === 'string') updateData.type = body.type;
  if (typeof body.telefone === 'string') updateData.telefone = body.telefone;
  if (typeof body.email === 'string') updateData.email = body.email;
  if (typeof body.cidade === 'string') updateData.cidade = body.cidade;
  if (typeof body.estado === 'string') updateData.estado = body.estado;
  if (typeof body.cep === 'string') updateData.cep = body.cep;
  if (typeof body.endereco === 'string' || typeof body.address === 'string') updateData.address = (body.endereco ?? body.address) as string;
  if (typeof body.numero === 'string') updateData.numero = body.numero;
  if (typeof body.complemento === 'string') updateData.complemento = body.complemento;
  if (typeof body.bairro === 'string') updateData.bairro = body.bairro;
  if (typeof body.cnpj === 'string') updateData.cnpj = body.cnpj;
  if (typeof body.ie === 'string') updateData.ie = body.ie;
  if (typeof body.im === 'string') updateData.im = body.im;
  if (typeof body.note === 'string') updateData.note = body.note;

  const w = await prisma.warehouse.update({
    where: { id },
    data: updateData,
  });
  res.json(formatWarehouse(w));
}

/**
 * POST /api/warehouse/create - cria uma nova imobiliária/loja.
 */
async function createWarehouse(req: import('express').Request, res: import('express').Response) {
  try {
    const body = req.body as Record<string, unknown>;

    const warehouseCode = typeof body.warehouse_code === 'string' ? body.warehouse_code.trim() : '';
    const warehouseName = typeof body.warehouse_name === 'string' ? body.warehouse_name.trim() : '';

    if (!warehouseCode || !warehouseName) {
      res.status(400).json({ message: 'Código e nome da loja são obrigatórios' });
      return;
    }

    const w = await prisma.warehouse.create({
      data: {
        warehouseCode,
        warehouseName,
        razaoSocial: typeof body.razao_social === 'string' ? body.razao_social : null,
        type: typeof body.type === 'string' ? body.type : null,
        telefone: typeof body.telefone === 'string' ? body.telefone : null,
        email: typeof body.email === 'string' ? body.email : null,
        cidade: typeof body.cidade === 'string' ? body.cidade : null,
        estado: typeof body.estado === 'string' ? body.estado : null,
        cep: typeof body.cep === 'string' ? body.cep : null,
        address: typeof body.endereco === 'string' ? body.endereco : typeof body.address === 'string' ? body.address : null,
        numero: typeof body.numero === 'string' ? body.numero : null,
        complemento: typeof body.complemento === 'string' ? body.complemento : null,
        bairro: typeof body.bairro === 'string' ? body.bairro : null,
        cnpj: typeof body.cnpj === 'string' ? body.cnpj : null,
        ie: typeof body.ie === 'string' ? body.ie : null,
        im: typeof body.im === 'string' ? body.im : null,
        note: typeof body.note === 'string' ? body.note : null,
        display: body.display !== undefined ? body.display === '1' || body.display === true : true,
      },
    });

    res.status(201).json(formatWarehouse(w));
  } catch (error) {
    console.error('Erro ao criar loja:', error);
    res.status(500).json({ message: 'Erro ao criar loja' });
  }
}

/**
 * DELETE /api/warehouse/:id - Remove uma loja (não permite remover a loja default).
 */
async function deleteWarehouse(req: import('express').Request, res: import('express').Response) {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ message: 'ID da loja é obrigatório' });
    return;
  }
  const w = await prisma.warehouse.findUnique({ where: { id } });
  if (!w) {
    res.status(404).json({ message: 'Loja não encontrada' });
    return;
  }
  if (w.id === 'wh-default') {
    res.status(400).json({ message: 'Não é permitido excluir a imobiliária padrão (SAX NEGÓCIOS).' });
    return;
  }
  await prisma.warehouse.delete({ where: { id } });
  res.json({ success: true });
}

router.get('/list', listWarehouses);
router.get('/list/', listWarehouses);
router.post('/create', createWarehouse);
router.post('/create/', createWarehouse);
router.get('/:id', getWarehouse);
router.put('/:id', updateWarehouse);
router.delete('/:id', deleteWarehouse);

export default router;
