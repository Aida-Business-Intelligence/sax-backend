import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

// --- Schemas -----------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1, "Nome obrigatório"),
  sortOrder: z.number().int().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1, "Nome obrigatório").optional(),
  sortOrder: z.number().int().optional(),
});

// --- Helpers -----------------------------------------------------------------

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseBody<T>(
  result: z.SafeParseReturnType<unknown, T>,
  res: Response,
): T | null {
  if (!result.success) {
    const message = result.error.errors.map((e) => e.message).join("; ");
    res.status(400).json({ success: false, message });
    return null;
  }
  return result.data;
}

// --- Handlers ----------------------------------------------------------------

async function listPropertyTypes(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const types = await prisma.propertyType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json(types);
  } catch (error) {
    next(error);
  }
}

async function getPropertyType(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const type = await prisma.propertyType.findUnique({ where: { id } });

    if (!type) {
      res
        .status(404)
        .json({ success: false, message: "Tipo de imóvel não encontrado" });
      return;
    }

    res.json(type);
  } catch (error) {
    next(error);
  }
}

async function createPropertyType(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = parseBody(createSchema.safeParse(req.body), res);
    if (!data) return;

    const value = slugify(data.name);

    const conflict = await prisma.propertyType.findUnique({ where: { value } });
    if (conflict) {
      res.status(409).json({
        success: false,
        message: "Já existe um tipo de imóvel com este valor",
      });
      return;
    }

    const type = await prisma.propertyType.create({
      data: { name: data.name, value, sortOrder: data.sortOrder ?? 0 },
    });

    res.status(201).json(type);
  } catch (error) {
    next(error);
  }
}

async function updatePropertyType(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const data = parseBody(updateSchema.safeParse(req.body), res);
    if (!data) return;

    const existing = await prisma.propertyType.findUnique({ where: { id } });
    if (!existing) {
      res
        .status(404)
        .json({ success: false, message: "Tipo de imóvel não encontrado" });
      return;
    }

    const updateData: { name?: string; value?: string; sortOrder?: number } =
      {};

    if (data.name !== undefined) {
      const newValue = slugify(data.name);

      if (newValue !== existing.value) {
        const conflict = await prisma.propertyType.findUnique({
          where: { value: newValue },
        });
        if (conflict) {
          res.status(409).json({
            success: false,
            message: "Já existe um tipo de imóvel com este valor",
          });
          return;
        }
      }

      updateData.name = data.name;
      updateData.value = newValue;
    }

    if (data.sortOrder !== undefined) {
      updateData.sortOrder = data.sortOrder;
    }

    const type = await prisma.propertyType.update({
      where: { id },
      data: updateData,
    });
    res.json(type);
  } catch (error) {
    next(error);
  }
}

async function deletePropertyType(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;

    const existing = await prisma.propertyType.findUnique({ where: { id } });
    if (!existing) {
      res
        .status(404)
        .json({ success: false, message: "Tipo de imóvel não encontrado" });
      return;
    }

    const usageCount = await prisma.property.count({
      where: { propertyType: existing.value },
    });

    if (usageCount > 0) {
      res.status(409).json({
        success: false,
        message: `Não é possivel remover este tipo. Há ${usageCount} imóvel(is) cadastrado(s) com ele.`,
      });
      return;
    }

    await prisma.propertyType.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

// --- Routes ------------------------------------------------------------------

router.get("/", listPropertyTypes);
router.get("/:id", getPropertyType);
router.post("/", authMiddleware, createPropertyType);
router.put("/:id", authMiddleware, updatePropertyType);
router.delete("/:id", authMiddleware, deletePropertyType);

export default router;
