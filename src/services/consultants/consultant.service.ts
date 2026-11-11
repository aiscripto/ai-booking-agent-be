import { prisma } from '../db.service';
import { buildDaySlots, Interval, removeBusy, todayIn } from '../availability.service';
import { parseStoredWeekly } from '../business-hours';
import { SLOT_MINUTES } from '../appointment.service';
import type { TenantSchedule } from '../tenant-schedule.service';

/**
 * Consultants are employees who take appointments (Employee.isBookable). A business that has at least
 * one active consultant is in "consultant mode": every booking is with a consultant, and free times are
 * worked out per consultant. A business with none keeps the older one-calendar behaviour.
 *
 * Each consultant has their own booking key ("emp:<employee id>") stored in Appointment.calendarId. That
 * reuses the existing double-booking protection (unique time, overlap check, lock) one consultant at a time.
 * In consultant mode free times come from the local appointments, working hours and time off. Google
 * Calendar is not read (its busy time belongs to one shared account, not to a consultant).
 */

export const CONSULTANT_KEY_PREFIX = 'emp:';
export const consultantKey = (employeeId: string): string => `${CONSULTANT_KEY_PREFIX}${employeeId}`;
export const isConsultantKey = (calendarId: string): boolean => calendarId.startsWith(CONSULTANT_KEY_PREFIX);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Consultant {
  id: string;
  fullName: string;
  title: string | null;
  workingHours: unknown;
  categories: Array<{ id: string; name: string }>;
  timeOff: Array<{ startDate: Date; endDate: Date }>;
}

export interface ConsultantFilter {
  categoryId?: string | null;
  employeeId?: string | null;
}

export interface ConsultantSlot {
  start: Date;
  consultants: Array<{ id: string; fullName: string }>;
}

/** A person or category the caller named that cannot be used. The message is spoken or shown as it is. */
export class ConsultantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsultantError';
  }
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
const normalize = (s: string): string => s.trim().toLowerCase().replace(/^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?)\s+/, '').replace(/\s+/g, ' ');

export class ConsultantService {
  /** Active consultants, optionally only those who serve one category or are one person. */
  public static async list(tenantId: string, filter: ConsultantFilter = {}): Promise<Consultant[]> {
    return prisma.employee.findMany({
      where: {
        tenantId,
        isBookable: true,
        isActive: true,
        ...(filter.employeeId ? { id: filter.employeeId } : {}),
        ...(filter.categoryId ? { categories: { some: { id: filter.categoryId, tenantId, isActive: true } } } : {}),
      },
      orderBy: { fullName: 'asc' },
      take: 500,
      select: {
        id: true,
        fullName: true,
        title: true,
        workingHours: true,
        categories: { where: { isActive: true }, select: { id: true, name: true } },
        timeOff: { select: { startDate: true, endDate: true } },
      },
    });
  }

  /** True when the business has at least one active consultant. */
  public static async isActive(tenantId: string): Promise<boolean> {
    return (await prisma.employee.count({ where: { tenantId, isBookable: true, isActive: true } })) > 0;
  }

  public static async categories(tenantId: string) {
    return prisma.serviceCategory.findMany({ where: { tenantId, isActive: true }, orderBy: { name: 'asc' }, take: 500, select: { id: true, name: true, description: true } });
  }

  // ── Names the caller says ────────────────────────────────────────────────

  /** A category from an id or a name. Returns null for "none given". Throws ConsultantError when it cannot be used. */
  public static async resolveCategory(tenantId: string, ref?: string | null): Promise<string | null> {
    const text = ref?.trim();
    if (!text) return null;
    const rows = await prisma.serviceCategory.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true }, take: 500 });
    const hit = UUID.test(text) ? rows.find((r) => r.id === text.toLowerCase()) : undefined;
    if (hit) return hit.id;
    const wanted = text.toLowerCase();
    const exact = rows.filter((r) => r.name.toLowerCase() === wanted);
    const partial = exact.length ? exact : rows.filter((r) => r.name.toLowerCase().includes(wanted) || wanted.includes(r.name.toLowerCase()));
    if (partial.length === 1) return partial[0].id;
    const names = rows.map((r) => r.name).join(', ');
    throw new ConsultantError(
      partial.length > 1
        ? `More than one service matches "${text}": ${partial.map((r) => r.name).join(', ')}. Which one do you want?`
        : `I could not find a service called "${text}".${names ? ` We offer: ${names}.` : ''}`,
    );
  }

  /** A consultant from an id or a name (a title such as "Dr." is ignored). */
  public static async resolveConsultant(tenantId: string, ref?: string | null): Promise<string | null> {
    const text = ref?.trim();
    if (!text) return null;
    const rows = await ConsultantService.list(tenantId);
    const byId = UUID.test(text) ? rows.find((r) => r.id === text.toLowerCase()) : undefined;
    if (byId) return byId.id;
    const wanted = normalize(text);
    const exact = rows.filter((r) => normalize(r.fullName) === wanted);
    const partial = exact.length ? exact : rows.filter((r) => normalize(r.fullName).includes(wanted));
    if (partial.length === 1) return partial[0].id;
    throw new ConsultantError(
      partial.length > 1
        ? `More than one person matches "${text}": ${partial.map((r) => r.fullName).join(', ')}. Which one do you want?`
        : `I could not find a consultant called "${text}".${rows.length ? ` Available: ${rows.map((r) => r.fullName).join(', ')}.` : ''}`,
    );
  }

  // ── When a consultant works ──────────────────────────────────────────────

  private static isOff(consultant: Consultant, date: string): boolean {
    return consultant.timeOff.some((t) => dayKey(t.startDate) <= date && date <= dayKey(t.endDate));
  }

  /** The slots a consultant works on one date: their own hours (or the business's), inside the business hours, not on leave. */
  public static workingSlots(consultant: Consultant, date: string, schedule: TenantSchedule): Date[] {
    if (ConsultantService.isOff(consultant, date)) return [];
    const business = new Set(buildDaySlots(date, schedule.timeZone, schedule.weekly).map((d) => d.getTime()));
    const own = parseStoredWeekly(consultant.workingHours) ?? schedule.weekly;
    return buildDaySlots(date, schedule.timeZone, own).filter((slot) => business.has(slot.getTime()));
  }

  private static async busyByKey(tenantId: string, keys: string[], from: Date, to: Date): Promise<Map<string, Interval[]>> {
    const rows = await prisma.appointment.findMany({
      where: {
        tenantId,
        calendarId: { in: keys },
        status: 'SCHEDULED',
        // An appointment that starts up to one slot before the window can still overlap it.
        appointmentDateTime: { gt: new Date(from.getTime() - SLOT_MINUTES * 60000), lt: to },
      },
      select: { calendarId: true, appointmentDateTime: true },
    });
    const map = new Map<string, Interval[]>();
    for (const r of rows) {
      const list = map.get(r.calendarId) ?? [];
      list.push({ start: r.appointmentDateTime, end: new Date(r.appointmentDateTime.getTime() + SLOT_MINUTES * 60000) });
      map.set(r.calendarId, list);
    }
    return map;
  }

  /**
   * Free times for one date, each with the consultants who are free then. Past times are left out.
   * `closed` is true when the business itself is closed that day.
   */
  public static async getFreeSlots(
    tenantId: string,
    date: string,
    schedule: TenantSchedule,
    filter: ConsultantFilter = {},
    now: Date = new Date(),
  ): Promise<{ closed: boolean; slots: ConsultantSlot[] }> {
    if (buildDaySlots(date, schedule.timeZone, schedule.weekly).length === 0) return { closed: true, slots: [] };

    const consultants = await ConsultantService.list(tenantId, filter);
    const worked = consultants.map((c) => ({ c, slots: ConsultantService.workingSlots(c, date, schedule).filter((s) => s.getTime() >= now.getTime()) }));
    const all = worked.flatMap((w) => w.slots);
    if (all.length === 0) return { closed: false, slots: [] };

    const times = all.map((s) => s.getTime());
    const busy = await ConsultantService.busyByKey(
      tenantId,
      worked.map((w) => consultantKey(w.c.id)),
      new Date(Math.min(...times)),
      new Date(Math.max(...times) + SLOT_MINUTES * 60000),
    );

    const byTime = new Map<number, ConsultantSlot>();
    for (const { c, slots } of worked) {
      for (const free of removeBusy(slots, busy.get(consultantKey(c.id)) ?? [])) {
        const entry = byTime.get(free.getTime()) ?? { start: free, consultants: [] };
        entry.consultants.push({ id: c.id, fullName: c.fullName });
        byTime.set(free.getTime(), entry);
      }
    }
    return { closed: false, slots: [...byTime.values()].sort((a, b) => a.start.getTime() - b.start.getTime()) };
  }

  /**
   * The consultants who can take this exact time, best first: fewest appointments that day, then by name,
   * so "anyone" spreads the work. Throws ConsultantError with a plain reason when nobody can.
   */
  public static async candidatesAt(tenantId: string, moment: Date, schedule: TenantSchedule, filter: ConsultantFilter = {}): Promise<Consultant[]> {
    const date = todayIn(schedule.timeZone, moment);
    const consultants = await ConsultantService.list(tenantId, filter);
    if (consultants.length === 0) {
      throw new ConsultantError(
        filter.employeeId && filter.categoryId
          ? 'That consultant does not offer that service.'
          : filter.employeeId
            ? 'That consultant is not available for booking.'
            : 'No consultant offers that service.',
      );
    }
    const working = consultants.filter((c) => ConsultantService.workingSlots(c, date, schedule).some((s) => s.getTime() === moment.getTime()));
    if (working.length === 0) {
      throw new ConsultantError(
        filter.employeeId
          ? `${consultants[0].fullName} is not working at that time. Please choose another time.`
          : 'No consultant is working at that time. Please choose another time.',
      );
    }

    const dayStart = new Date(moment.getTime() - 24 * 3600 * 1000);
    const dayEnd = new Date(moment.getTime() + 24 * 3600 * 1000);
    const rows = await prisma.appointment.findMany({
      where: { tenantId, calendarId: { in: working.map((c) => consultantKey(c.id)) }, status: 'SCHEDULED', appointmentDateTime: { gte: dayStart, lt: dayEnd } },
      select: { calendarId: true, appointmentDateTime: true },
    });
    const load = new Map<string, number>();
    for (const r of rows) {
      if (todayIn(schedule.timeZone, r.appointmentDateTime) === date) load.set(r.calendarId, (load.get(r.calendarId) ?? 0) + 1);
    }
    return working.sort((a, b) => (load.get(consultantKey(a.id)) ?? 0) - (load.get(consultantKey(b.id)) ?? 0) || a.fullName.localeCompare(b.fullName));
  }
}
