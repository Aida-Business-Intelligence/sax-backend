import { prisma } from './prisma.js';

export async function getWarehousePdvSettings(
  warehouseId: string
): Promise<Record<string, unknown>> {
  const row = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { pdvSettingsJson: true },
  });
  if (!row?.pdvSettingsJson) return {};
  try {
    return JSON.parse(row.pdvSettingsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function setWarehousePdvSettings(
  warehouseId: string,
  settings: Record<string, unknown>
): Promise<void> {
  await prisma.warehouse.update({
    where: { id: warehouseId },
    data: { pdvSettingsJson: JSON.stringify(settings) },
  });
}

export async function mergeWarehousePdvSettings(
  warehouseId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const prev = await getWarehousePdvSettings(warehouseId);
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'warehouse_id') continue;
    if (v !== undefined) next[k] = v;
  }
  await setWarehousePdvSettings(warehouseId, next);
  return next;
}
