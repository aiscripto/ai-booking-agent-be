import { z } from 'zod';
import { config } from '../config';

/**
 * Opening hours as the business sets them: for each weekday, zero or more time ranges.
 * Seven lists, Sunday first (the same numbering as Date.getDay and the BUSINESS_DAYS setting).
 * A range is "HH:MM" to "HH:MM"; the end may be "24:00" (midnight at the end of the day).
 *   8 hours  = 09:00-17:00      12 hours = 08:00-20:00      24 hours = 00:00-24:00
 * A day with no range is closed. Two ranges on a day make a break (for example lunch).
 */

export interface TimeRange {
  start: string;
  end: string;
}
export type WeeklyHours = TimeRange[][];

/** The old single-range form: one start, one end, and the open days. */
export interface LegacyHours {
  start: string;
  end: string;
  days: number[];
}

export const MAX_RANGES_PER_DAY = 4;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const timeText = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM, for example 09:00 (24:00 is allowed as an end).');

/** The rules for what a business may save. Used by the admin API. */
export const weeklyHoursSchema = z
  .array(z.array(z.object({ start: timeText, end: timeText })).max(MAX_RANGES_PER_DAY))
  .length(7, 'Give the hours for all seven days (Sunday first).')
  .superRefine((week, ctx) => {
    week.forEach((ranges, day) => {
      let previousEnd = -1;
      for (const range of [...ranges].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))) {
        if (range.start === '24:00') {
          ctx.addIssue({ code: 'custom', message: `${DAY_NAMES[day]}: a range cannot start at 24:00.` });
          return;
        }
        if (minutesOf(range.end) <= minutesOf(range.start)) {
          ctx.addIssue({ code: 'custom', message: `${DAY_NAMES[day]}: the end must be after the start.` });
          return;
        }
        if (minutesOf(range.start) < previousEnd) {
          ctx.addIssue({ code: 'custom', message: `${DAY_NAMES[day]}: time ranges must not overlap.` });
          return;
        }
        previousEnd = minutesOf(range.end);
      }
    });
  })
  .transform((week): WeeklyHours => week.map((ranges) => [...ranges].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))));

/** What the server settings say (BUSINESS_HOURS_START / END / DAYS). Used until a business sets its own. */
export function defaultWeekly(): WeeklyHours {
  const days = config.BUSINESS_DAYS.split(',').map(Number);
  return legacyToWeekly({ start: config.BUSINESS_HOURS_START, end: config.BUSINESS_HOURS_END, days });
}

export function legacyToWeekly(hours: LegacyHours): WeeklyHours {
  return Array.from({ length: 7 }, (_, day) => (hours.days.includes(day) ? [{ start: hours.start, end: hours.end }] : []));
}

/** Reads what is stored in the database. Returns null when it is missing or not valid (the default then applies). */
export function parseStoredWeekly(value: unknown): WeeklyHours | null {
  const parsed = weeklyHoursSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** True when at least one day has a range. */
export function hasOpenDay(week: WeeklyHours): boolean {
  return week.some((ranges) => ranges.length > 0);
}

/**
 * The short form the calendar screen uses: earliest opening, latest closing, and the open days.
 * `end` is never "24:00" here (screens read it as a clock time), so a full day ends at 23:59.
 */
export function summarize(week: WeeklyHours): LegacyHours {
  const open = week.flatMap((ranges) => ranges);
  const days = week.map((ranges, day) => (ranges.length ? day : -1)).filter((d) => d >= 0);
  if (open.length === 0) return { start: '00:00', end: '00:00', days: [] };
  const start = open.reduce((a, r) => (minutesOf(r.start) < minutesOf(a) ? r.start : a), open[0].start);
  const end = open.reduce((a, r) => (minutesOf(r.end) > minutesOf(a) ? r.end : a), open[0].end);
  return { start, end: end === '24:00' ? '23:59' : end, days };
}

/** Plain words: "Monday to Friday 09:00-17:00; Saturday 10:00-14:00". Days with the same hours are joined. */
export function describeWeekly(week: WeeklyHours): string {
  if (!hasOpenDay(week)) return 'Closed every day';
  const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
  const key = (day: number) => week[day].map((r) => `${r.start}-${r.end}`).join(', ');
  const groups: Array<{ days: number[]; hours: string }> = [];
  for (const day of order) {
    if (week[day].length === 0) continue;
    const last = groups[groups.length - 1];
    const lastDay = last?.days[last.days.length - 1];
    const adjacent = last && lastDay !== undefined && order.indexOf(day) === order.indexOf(lastDay) + 1;
    if (last && adjacent && last.hours === key(day)) last.days.push(day);
    else groups.push({ days: [day], hours: key(day) });
  }
  return groups
    .map((g) => {
      const names = g.days.map((d) => DAY_NAMES[d]);
      const label = names.length > 2 ? `${names[0]} to ${names[names.length - 1]}` : names.join(' and ');
      return `${label} ${g.hours}`;
    })
    .join('; ');
}
