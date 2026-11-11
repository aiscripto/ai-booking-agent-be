import { Prisma } from '@prisma/client';
import { prisma } from './db.service';

/**
 * The audit log: who did what, and when. Entries are only ever ADDED. There is no way to change or delete
 * one through the app. (Someone with direct access to the database could; that is a database access rule.)
 *
 * Writing an entry never stops the action it describes: if the write fails, the failure is printed in the
 * server log, and the action goes on. Passwords, tokens and secrets are never stored in an entry.
 */

export interface AuditActor {
  /** Empty for the voice agent and other system actions. */
  userId: string | null;
  /** The user name at the time (a copy, so the entry still reads right if the user changes later). */
  name: string;
  role?: string | null;
}

export interface AuditEntry {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
}

const SECRET_KEY = /pass(word)?|token|secret|authorization|api[-_]?key|cookie/i;
const MAX_DETAILS_CHARS = 4000;

/** A copy of the data with every secret-looking value replaced, and a size limit. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[too deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[hidden]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

function boundedDetails(details?: Record<string, unknown> | null): Prisma.InputJsonValue | undefined {
  if (!details) return undefined;
  const clean = redact(details);
  const text = JSON.stringify(clean);
  if (text.length > MAX_DETAILS_CHARS) return { note: 'details too large to keep', size: text.length } as Prisma.InputJsonValue;
  return clean as Prisma.InputJsonValue;
}

export interface AuditQuery {
  /** Text to find in the user name, the action or the summary. */
  q?: string;
  /** Only entries by this user id. */
  userId?: string;
  /** Inclusive start and end instants. */
  from?: Date;
  to?: Date;
  limit: number;
  /** Continue after this entry (the `nextCursor` of the previous page). */
  cursor?: string;
}

export class AuditService {
  /** Adds one entry. Never throws. */
  public static async record(tenantId: string, actor: AuditActor, entry: AuditEntry, ip?: string | null): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          actorName: actor.name,
          actorRole: actor.role ?? null,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          summary: entry.summary.slice(0, 500),
          details: boundedDetails(entry.details),
          ip: ip ?? null,
        },
      });
    } catch (error) {
      console.error('[AuditService] Could not write an audit entry:', error instanceof Error ? error.message : error);
    }
  }

  /** Newest first. Always limited to the caller's own business. */
  public static async list(tenantId: string, query: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
      ...(query.q
        ? {
            OR: [
              { actorName: { contains: query.q, mode: 'insensitive' } },
              { action: { contains: query.q, mode: 'insensitive' } },
              { summary: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return { entries: page, nextCursor: rows.length > query.limit ? page[page.length - 1].id : null };
  }
}
