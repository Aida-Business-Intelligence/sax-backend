import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';

export type AuthPayload = { userId: string };

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.replace(/^Bearer\s+/i, '');

  if (!token) {
    res.status(401).json({ success: false, message: 'Token não informado' });
    return;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { role: true, warehouse: true },
    });
    if (!user || !user.active) {
      res.status(401).json({ success: false, message: 'Usuário inválido ou inativo' });
      return;
    }
    (req as Request & { user: typeof user }).user = user;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Token inválido ou expirado' });
  }
}
