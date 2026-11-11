import { Request, Response, NextFunction } from 'express';
import { AuthContext, AuthService, StaffRole } from '../services/auth.service';
import { Permission } from '../config/permissions';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. The only trusted source of the caller's tenant and role. */
    auth?: AuthContext;
  }
}

/**
 * Requires a valid login token in `Authorization: Bearer <token>`.
 * The tenant and role come from the verified token and the database, never from the
 * request's own headers, body or query.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const ctx = token ? await AuthService.authenticate(token) : null;

    if (!ctx) {
      res.status(401).json({ status: 'error', message: 'Authentication required.' });
      return;
    }

    req.auth = ctx;
    next();
  } catch (error) {
    next(error);
  }
}

/** Allows only the listed roles. Use after requireAuth. */
export function requireRole(...roles: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ status: 'error', message: 'You do not have permission to do this.' });
      return;
    }
    next();
  };
}

/**
 * Requires EVERY listed permission. The permissions come from the user's role, read from the
 * database (not from the token), so a change to a role applies within the auth cache time.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const granted = req.auth?.permissions ?? [];
    if (!req.auth || !permissions.every((p) => granted.includes(p))) {
      res.status(403).json({ status: 'error', message: 'You do not have permission to do this.' });
      return;
    }
    next();
  };
}

/** Requires AT LEAST ONE of the listed permissions (for lists that two screens need). */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const granted = req.auth?.permissions ?? [];
    if (!req.auth || !permissions.some((p) => granted.includes(p))) {
      res.status(403).json({ status: 'error', message: 'You do not have permission to do this.' });
      return;
    }
    next();
  };
}

/** Staff who may use the dashboard. Patients may not. */
export const STAFF_ROLES: StaffRole[] = ['ADMIN', 'FRONT_DESK', 'PROVIDER'];
