import { config } from '../config';
import { prisma } from './db.service';
import { defaultWeekly, parseStoredWeekly, WeeklyHours } from './business-hours';
import { slotCacheService } from './slot-cache.service';

/**
 * When and where a business works: its time zone and its opening hours. A business that has not set
 * them uses the server settings (DEFAULT_TIME_ZONE, BUSINESS_HOURS_*), so nothing changes until it does.
 *
 * Read often (every availability check and booking), so the answer is remembered for a short time.
 * Saving the hours clears it at once (invalidate).
 */

export interface TenantSchedule {
  timeZone: string;
  weekly: WeeklyHours;
}

const CACHE_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cache = new Map<string, { value: TenantSchedule; expiresAt: number }>();

/** What applies when nothing is stored: the server settings. */
export function defaultSchedule(): TenantSchedule {
  return { timeZone: config.DEFAULT_TIME_ZONE, weekly: defaultWeekly() };
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export class TenantScheduleService {
  public static async get(tenantId: string): Promise<TenantSchedule> {
    const hit = cache.get(tenantId);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    // Not a real tenant id (the column is a UUID): nothing to read, the server settings apply.
    const row = !UUID.test(tenantId)
      ? null
      : await prisma.tenant.findFirst({ where: { id: tenantId }, select: { businessHours: true, timeZone: true } });
    const fallback = defaultSchedule();
    const value: TenantSchedule = {
      timeZone: row?.timeZone && isValidTimeZone(row.timeZone) ? row.timeZone : fallback.timeZone,
      weekly: parseStoredWeekly(row?.businessHours) ?? fallback.weekly,
    };
    cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_SECONDS * 1000 });
    return value;
  }

  /** Forget this business's schedule and the free times worked out from it. Call after saving it. */
  public static invalidate(tenantId: string): void {
    cache.delete(tenantId);
    // Cache keys start with "slots:<tenant id>:" (see SlotCacheService.buildKey).
    slotCacheService.invalidate(`slots:${tenantId}:`);
  }

  public static clearAll(): void {
    cache.clear();
  }
}
