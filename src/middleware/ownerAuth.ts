import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export type OwnerRequest = Request & { ownerId?: string };

export function ownerAuth(req: OwnerRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ message: 'Não autorizado' });
    return;
  }
  try {
    const decoded = jwt.verify(token, String(config.jwtSecret)) as {
      ownerId?: string;
      type?: string;
    };
    if (decoded.type !== 'owner' || !decoded.ownerId) {
      res.status(401).json({ message: 'Token inválido' });
      return;
    }
    req.ownerId = decoded.ownerId;
    next();
  } catch {
    res.status(401).json({ message: 'Token inválido' });
  }
}
