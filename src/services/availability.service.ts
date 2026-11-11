import { prisma } from './db.service';
import { GoogleCalendarService } from './google-calendar.service';
import { SLOT_MINUTES } from './appointment.service';
import { defaultWeekly, LegacyHours, legacyToWeekly, WeeklyHours } from './business-hours';
import { TenantScheduleService } from './tenant-schedule.service';

/**
 * One source of truth for "which times can be booked" (decision D3): the local appointments table
 * plus Google Calendar, the same two places AppointmentService checks when a booking is made.
 * Cal.com is not asked. Free times are worked out in memory from two reads, so a distant database
 * costs one round trip, not one per slot.
 */

export interface Interval {
  start: Date;
  end: Date;
}

/** Thrown when Google Calendar cannot be read, so the answer would be a guess. Never guess. */
export class AvailabilityUnavailableError extends Error {
  constructor(message = 'The calendar cannot be checked right now.') {
    super(message);
    this.name = 'AvailabilityUnavailableError';
  }
}

/** How far a time zone is ahead of UTC at a given instant, in minutes. */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUtc - utcMs) / 60000;
}

/** The UTC instant for a wall-clock time ('YYYY-MM-DD', 'HH:MM') in a time zone (handles summer time). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMinutes(guess, timeZone) * 60000;
  // A second pass fixes the hours around a clock change.
  return new Date(guess - offsetMinutes(first, timeZone) * 60000);
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

/**
 * The start of a calendar date and the start of the next date, as UTC instants, in a time zone.
 * Use `>= start` and `< end` to pick the appointments of that date.
 */
export function dayBoundsUtc(date: string, timeZone: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: zonedTimeToUtc(date, '00:00', timeZone), end: zonedTimeToUtc(next, '00:00', timeZone) };
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Every slot start inside opening hours for one date (empty on a day the business is closed).
 * `hours` is the weekly hours (seven lists, Sunday first); the old single-range form is still accepted.
 * With no `hours`, the server settings apply.
 */
export function buildDaySlots(
  date: string,
  timeZone: string,
  hours: WeeklyHours | LegacyHours = defaultWeekly(),
  slotMinutes: number = SLOT_MINUTES
): Date[] {
  const week = Array.isArray(hours) ? hours : legacyToWeekly(hours);
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const slots = new Map<number, Date>(); // keyed by time, so overlapping ranges cannot repeat a slot
  for (const range of week[weekday] ?? []) {
    const open = zonedTimeToUtc(date, range.start, timeZone).getTime();
    const close = zonedTimeToUtc(date, range.end, timeZone).getTime();
    for (let t = open; t + slotMinutes * 60000 <= close; t += slotMinutes * 60000) {
      slots.set(t, new Date(t));
    }
  }
  return [...slots.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** Slots that do not overlap any busy interval. */
export function removeBusy(slots: Date[], busy: Interval[], slotMinutes: number = SLOT_MINUTES): Date[] {
  return slots.filter((slot) => {
    const start = slot.getTime();
    const end = start + slotMinutes * 60000;
    return !busy.some((b) => start < b.end.getTime() && end > b.start.getTime());
  });
}

export interface FreeSlots {
  /** True when the business is closed that day (no slots exist, as opposed to all being taken). */
  closed: boolean;
  slots: Date[];
}

export class AvailabilityService {
  /**
   * Free, bookable slots for one date, in time order. Slots in the past are left out.
   * @throws AvailabilityUnavailableError when Google Calendar could not be read.
   */
  public static async getFreeSlots(
    tenantId: string,
    calendarId: string,
    date: string,
    timeZone: string,
    now: Date = new Date()
  ): Promise<FreeSlots> {
    const schedule = await TenantScheduleService.get(tenantId);
    const candidates = buildDaySlots(date, timeZone, schedule.weekly);
    if (candidates.length === 0) return { closed: true, slots: [] };

    const upcoming = candidates.filter((s) => s.getTime() >= now.getTime());
    if (upcoming.length === 0) return { closed: false, slots: [] };

    const windowStart = upcoming[0];
    const windowEnd = new Date(upcoming[upcoming.length - 1].getTime() + SLOT_MINUTES * 60000);

    // Two reads at the same time: appointments held locally, and events in Google Calendar.
    const [rows, googleBusy] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          tenantId,
          calendarId,
          status: 'SCHEDULED',
          // An appointment that starts up to one slot before the window can still overlap it.
          appointmentDateTime: { gt: new Date(windowStart.getTime() - SLOT_MINUTES * 60000), lt: windowEnd },
        },
        select: { appointmentDateTime: true },
      }),
      GoogleCalendarService.getBusyIntervals(tenantId, calendarId, windowStart, windowEnd),
    ]);

    if (googleBusy === null) throw new AvailabilityUnavailableError();

    const localBusy: Interval[] = rows.map((r) => ({
      start: r.appointmentDateTime,
      end: new Date(r.appointmentDateTime.getTime() + SLOT_MINUTES * 60000),
    }));

    return { closed: false, slots: removeBusy(upcoming, [...localBusy, ...googleBusy]) };
  }
}
