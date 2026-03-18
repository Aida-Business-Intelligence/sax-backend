import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error & { statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err.statusCode ?? 500;
  const message = err.message ?? 'Erro interno do servidor';
  res.status(status).json({ success: false, message, error: message });
}
