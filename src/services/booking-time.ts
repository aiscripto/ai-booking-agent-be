import { config } from '../config';
import { buildDaySlots, isRealDate, todayIn, zonedTimeToUtc } from './availability.service';
import { describeWeekly } from './business-hours';
import { defaultSchedule, TenantSchedule } from './tenant-schedule.service';

/**
 * Turns the time a caller or a screen sends into one exact moment, and refuses times the business
 * cannot serve. Both booking doors (the voice tool and the dashboard) use this, so they agree.
 *
 * The business time zone (DEFAULT_TIME_ZONE) is the only zone used to judge opening hours.
 * A time written WITHOUT an offset ("2026-11-12T10:00:00") means that time in the business zone,
 * not UTC. A time with an offset or Z is taken as written.
 */

/** A time that cannot be booked. The message is meant to be shown or spoken as it is. */
export class BookingTimeError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BookingTimeError';
  }
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Reads a date-time string. Throws BookingTimeError when it is not a real date and time. */
export function parseBookingTime(raw: unknown, timeZone: string = config.DEFAULT_TIME_ZONE): Date {
  if (typeof raw !== 'string' || raw.trim() === '') throw new BookingTimeError('Invalid dateTime format.');
  const text = raw.trim();
  const match = WALL_CLOCK.exec(text);

  let parsed: Date;
  if (match) {
    const [, date, hh, mm, ss, offset] = match;
    if (!isRealDate(date) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) {
      throw new BookingTimeError('Invalid dateTime format.');
    }
    if (offset) {
      // "+0500" is not accepted by Date everywhere; write it as "+05:00".
      const fixed = /^[+-]\d{4}$/.test(offset) ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset;
      parsed = new Date(`${date}T${hh}:${mm}:${ss ?? '00'}${fixed.toUpperCase()}`);
    } else {
      // No offset: the business's own clock. A non-zero seconds part is kept, so it fails the grid check.
      parsed = new Date(zonedTimeToUtc(date, `${hh}:${mm}`, timeZone).getTime() + Number(ss ?? 0) * 1000);
    }
  } else {
    // Another style of date text (for example "Nov 12 2026 10:00 AM"): taken as before.
    parsed = new Date(text);
  }

  if (Number.isNaN(parsed.getTime())) throw new BookingTimeError('Invalid dateTime format.');
  return parsed;
}

/** True when the moment is the start of a bookable slot: inside the business's opening hours, on the grid. */
export function isBookableSlot(moment: Date, schedule: TenantSchedule = defaultSchedule()): boolean {
  const day = todayIn(schedule.timeZone, moment);
  return buildDaySlots(day, schedule.timeZone, schedule.weekly).some((slot) => slot.getTime() === moment.getTime());
}

/** The sentence that explains the opening hours, in plain words. */
export function openingHoursText(schedule: TenantSchedule = defaultSchedule()): string {
  return `We are open ${describeWeekly(schedule.weekly)} (${schedule.timeZone}); appointments are every 30 minutes.`;
}

/** Throws BookingTimeError when the moment is not a bookable slot. */
export function assertBookableSlot(moment: Date, schedule: TenantSchedule = defaultSchedule()): void {
  if (!isBookableSlot(moment, schedule)) {
    throw new BookingTimeError(`That time is not available for booking. ${openingHoursText(schedule)} Please choose another time.`);
  }
}
