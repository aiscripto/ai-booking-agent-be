import { Request, Response, NextFunction } from 'express';
import { AuditService, redact } from '../services/audit.service';

/**
 * Writes an audit entry for what a signed-in user does. Mount it AFTER requireAuth.
 *
 *  - Every change (POST, PUT, PATCH, DELETE) by every user, including refused ones (the status is kept).
 *  - Every read (GET) too, but only for a user whose role is limited to their own appointments
 *    (a consultant): for them, everything is logged.
 *
 * A route can add a clearer sentence and the record it touched: `res.locals.audit = { summary, entityType, entityId, details }`.
 * Writing the entry never changes the answer sent to the user.
 */

export interface AuditNote {
  summary?: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  /** Log this read even for a login that is not limited to its own appointments (for sensitive data). */
  alwaysLog?: boolean;
}

/** True for a login whose appointment rights are limited to the linked consultant. */
export function isOwnOnly(permissions: readonly string[]): boolean {
  return permissions.includes('appointments.own_only');
}

/** A plain sentence for a change, from the method and the route (a route can still set its own). */
function describe(method: string, route: string): string | null {
  const verb = method === 'POST' ? 'Created' : method === 'PUT' || method === 'PATCH' ? 'Changed' : method === 'DELETE' ? 'Deleted' : null;
  if (!verb) return null;
  const known: Array<[RegExp, string]> = [
    [/\/admin\/users(\/:id)?$/, 'a user account'],
    [/\/admin\/roles(\/:id)?$/, 'a role'],
    [/\/admin\/grades(\/:id)?$/, 'a grade'],
    [/\/admin\/departments(\/:id)?$/, 'a department'],
    [/\/admin\/employees(\/:id)?$/, 'an employee'],
    [/\/admin\/employees\/:id\/time-off$/, 'days off'],
    [/\/admin\/time-off\/:id$/, 'days off'],
    [/\/admin\/categories(\/:id)?$/, 'a service category'],
    [/\/admin\/business$/, 'the business details and opening hours'],
    [/\/tenant\/branding$/, 'the branding'],
    [/\/tenant\/resources(\/:id)?$/, 'a provider'],
    [/\/appointments\/:id\/telehealth$/, 'a video link for an appointment'],
  ];
  const hit = known.find(([pattern]) => pattern.test(route));
  return hit ? `${verb} ${hit[1]}` : null;
}

export function auditRequests(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    const auth = req.auth;
    if (!auth) return;
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const note = (res.locals.audit ?? {}) as AuditNote;
    if (isRead && !isOwnOnly(auth.permissions) && !note.alwaysLog) return;
    const route = `${req.baseUrl}${req.route?.path ?? req.path}`.replace(/\/$/, '');
    const status = res.statusCode;
    const entityId = note.entityId ?? (typeof req.params.id === 'string' ? req.params.id : undefined);

    const details: Record<string, unknown> = { status, ...(note.details ?? {}) };
    if (isRead && Object.keys(req.query).length > 0) details.query = redact(req.query);
    if (!isRead && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0 && !note.details) details.body = redact(req.body);

    const action = `${req.method} ${route}`;
    const summary =
      note.summary ??
      (!isRead && status < 400 ? describe(req.method, route) : null) ??
      `${isRead ? 'Opened' : status >= 400 ? 'Tried to change' : 'Changed'} ${route}${status >= 400 ? ` (refused, HTTP ${status})` : ''}`;

    void AuditService.record(
      auth.tenantId,
      { userId: auth.userId, name: auth.username, role: auth.roleName },
      { action, entityType: note.entityType ?? null, entityId: entityId ?? null, summary, details },
      req.ip,
    );
  });
  next();
}
