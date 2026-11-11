import crypto from 'crypto';
import { config } from '../../src/config';
import { buildDaySlots, todayIn } from '../../src/services/availability.service';

/**
 * A random time that can really be booked: inside opening hours, on the 30 minute grid, on an open
 * day, between 2 and 60 days from now. Random, so tests that share a database rarely pick the same slot, and
 * never the same slot twice in one test file (a repeat would look like a double booking).
 */
const handedOut = new Set<number>();

export function bookableSlot(): Date {
  for (;;) {
    const ahead = crypto.randomInt(2, 61);
    const day = todayIn(config.DEFAULT_TIME_ZONE, new Date(Date.now() + ahead * 24 * 60 * 60 * 1000));
    const slots = buildDaySlots(day, config.DEFAULT_TIME_ZONE);
    if (slots.length === 0) continue;
    const pick = slots[crypto.randomInt(0, slots.length)];
    if (handedOut.has(pick.getTime())) continue;
    handedOut.add(pick.getTime());
    return pick;
  }
}
