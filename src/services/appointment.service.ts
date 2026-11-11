import { prisma } from './db.service';
import { GoogleCalendarService } from './google-calendar.service';
import { SmsService } from './sms.service';
import { EmailService } from './email.service';
import { TIMEOUTS, TRANSACTION_OPTIONS } from '../config/timeouts';
import { config } from '../config';
import { slotCacheService } from './slot-cache.service';
import { isBookableSlot } from './booking-time';
import { TenantScheduleService } from './tenant-schedule.service';
import { isConsultantKey } from './consultants/consultant.service';

/** The Google calendar for events. A consultant's booking key is not a Google calendar: events go to the default one. */
function googleCalendarOf(calendarId: string): string {
  return isConsultantKey(calendarId) ? config.GOOGLE_DEFAULT_CALENDAR_ID : calendarId;
}

/**
 * Every booking is this long. The Appointment table does not store a duration, so an
 * existing appointment is assumed to last this many minutes when checking for overlaps.
 */
export const SLOT_MINUTES = 30;

/**
 * A booking may be at most this far in the past. Requests take time to arrive and clocks drift,
 * so "right now" must not be refused. Anything older is a mistake (for example yesterday).
 */
const PAST_GRACE_MS = 5 * 60 * 1000;

export class AppointmentService {

  /**
   * Where clause for appointments that overlap a new one starting at `start` and lasting
   * `durationMinutes`, but do NOT start at exactly the same time. The exact same start time
   * is left to the unique index, which also handles cancelled rows and retries.
   */
  private static overlapWhere(
    tenantId: string,
    calendarId: string,
    start: Date,
    durationMinutes: number
  ) {
    return {
      tenantId,
      calendarId,
      status: 'SCHEDULED',
      AND: [
        {
          appointmentDateTime: {
            gt: new Date(start.getTime() - SLOT_MINUTES * 60000),
            lt: new Date(start.getTime() + durationMinutes * 60000),
          },
        },
        { appointmentDateTime: { not: start } },
      ],
    };
  }

  /**
   * Checks availability of a slot across both the local database and the external Google Calendar.
   */
  public static async checkAvailability(
    tenantId: string,
    calendarId: string,
    dateTime: Date,
    durationMinutes: number = 30
  ): Promise<boolean> {
    // 1. Check local DB for active bookings (Rule of Least Privilege: explicit tenantId filter)
    const localConflict = await prisma.appointment.findFirst({
      where: {
        tenantId,
        calendarId,
        appointmentDateTime: dateTime,
        status: 'SCHEDULED',
      },
    });

    if (localConflict) {
      return false;
    }

    // Overlap: a 10:15 booking must not be accepted while a 10:00 (30 minute) one exists.
    const overlapping = await prisma.appointment.findFirst({
      where: this.overlapWhere(tenantId, calendarId, dateTime, durationMinutes),
    });
    if (overlapping) {
      return false;
    }

    // 2. Check external Google Calendar. A consultant's own booking key is not a Google calendar: their
    // availability is the local appointments only (see consultant.service.ts).
    if (isConsultantKey(calendarId)) {
      return true;
    }
    const googleAvailable = await GoogleCalendarService.checkAvailability(
      tenantId,
      calendarId,
      dateTime,
      durationMinutes
    );

    return googleAvailable;
  }

  /**
   * Finds the next available slot starting from a reference date/time.
   * Scans forward in 30-minute increments.
   */
  public static async findNextAvailableSlot(
    tenantId: string,
    calendarId: string,
    startFrom: Date,
    durationMinutes: number = 30,
    maxSearchSteps: number = 8
  ): Promise<Date | null> {
    // Start searching from the next 30-minute interval
    let currentCheck = new Date(startFrom.getTime() + durationMinutes * 60000);

    // Each check can call Google. Stop when the total time is used up, so a caller
    // is never left waiting through many slow checks in a row.
    const deadline = Date.now() + TIMEOUTS.NEXT_SLOT_SEARCH_MS;

    // Only times that can really be booked are suggested (inside opening hours, on the grid).
    // Skipping a closed night or weekend costs no database call, so it does not use up a step.
    const schedule = await TenantScheduleService.get(tenantId);
    const MAX_SKIPPED = 400; // 400 half-hours = more than 8 days
    let skipped = 0;
    let checks = 0;

    while (checks < maxSearchSteps) {
      if (Date.now() >= deadline) {
        return null;
      }
      if (!isBookableSlot(currentCheck, schedule)) {
        if (++skipped > MAX_SKIPPED) return null;
        currentCheck = new Date(currentCheck.getTime() + durationMinutes * 60000);
        continue;
      }
      checks += 1;
      const isAvailable = await this.checkAvailability(
        tenantId,
        calendarId,
        currentCheck,
        durationMinutes
      );

      if (isAvailable) {
        return currentCheck;
      }

      currentCheck = new Date(currentCheck.getTime() + durationMinutes * 60000);
    }

    return null;
  }

  /**
   * Reserves an appointment. Uses database atomic constraints to prevent double booking.
   * If Google Calendar sync fails, rolls back the local insert.
   */
  public static async createAppointment(
    tenantId: string,
    data: {
      calendarId: string;
      appointmentDateTime: Date;
      customerName: string;
      customerPhone: string;
      customerEmail?: string | null;
      durationMinutes?: number;
      /** The consultant and the service this booking is for (consultant mode). */
      employeeId?: string | null;
      categoryId?: string | null;
    }
  ): Promise<any> {
    if (data.appointmentDateTime.getTime() < Date.now() - PAST_GRACE_MS) {
      throw new Error('The appointment time must be in the future.');
    }

    // A retry of the same request is not a conflict. If this customer already holds this
    // exact slot, return that appointment (voice platforms redeliver webhooks, and
    // staff can double-click). No second row, no second notification.
    const alreadyHeld = await this.findHeldByCustomer(tenantId, data);
    if (alreadyHeld) {
      return alreadyHeld;
    }

    // Double-check availability first to avoid unnecessary failures
    const isAvailable = await this.checkAvailability(
      tenantId,
      data.calendarId,
      data.appointmentDateTime,
      data.durationMinutes
    );

    if (!isAvailable) {
      // An identical request may have been committed between our first check and now.
      // If the slot is held by this same customer, this is a retry, not a conflict.
      const justBooked = await this.findHeldByCustomer(tenantId, data);
      if (justBooked) {
        return justBooked;
      }

      // For a consultant the caller chooses another time or another consultant; no one-calendar suggestion.
      const nextSlot = isConsultantKey(data.calendarId) ? null : await this.findNextAvailableSlot(
        tenantId,
        data.calendarId,
        data.appointmentDateTime,
        data.durationMinutes
      );

      if (nextSlot) {
        const formattedTime = this.formatForCustomer(nextSlot, true, (await TenantScheduleService.get(tenantId)).timeZone);
        throw new Error(`The requested slot is already booked. The next available slot is on ${formattedTime}. Would you like to book that instead?`);
      }

      throw new Error('The requested slot is already booked.');
    }

    // Attempt atomic insertion into database.
    // If a concurrent process insert succeeded right before us, the db unique constraint will catch it.
    let appointment;
    try {
      // The unique index only catches the exact same start time. Overlaps (10:00 and 10:15)
      // are caught by re-checking under a lock for this tenant and calendar, so two callers
      // asking for overlapping times at once cannot both win.
      appointment = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${data.calendarId}))`;

        const overlapping = await tx.appointment.findFirst({
          where: this.overlapWhere(
            tenantId,
            data.calendarId,
            data.appointmentDateTime,
            data.durationMinutes ?? SLOT_MINUTES
          ),
        });
        if (overlapping) {
          throw new Error('The requested slot is already booked.');
        }

        return tx.appointment.create({
          data: {
            tenantId,
            calendarId: data.calendarId,
            appointmentDateTime: data.appointmentDateTime,
            customerName: data.customerName,
            customerPhone: data.customerPhone,
            customerEmail: data.customerEmail || null,
            employeeId: data.employeeId ?? null,
            categoryId: data.categoryId ?? null,
            status: 'SCHEDULED',
          },
        });
      }, TRANSACTION_OPTIONS);
    } catch (dbError: any) {
      // Prisma code for unique constraint violation (P2002)
      if (dbError.code !== 'P2002') {
        throw dbError;
      }

      // A cancelled appointment keeps its row, and the unique index still covers it.
      // Take that row over for the new customer. The status filter makes this atomic:
      // if two callers race, only one update matches and the other gets a conflict.
      const reclaimed = await prisma.appointment.updateMany({
        where: {
          tenantId,
          calendarId: data.calendarId,
          appointmentDateTime: data.appointmentDateTime,
          status: 'CANCELLED',
        },
        data: {
          status: 'SCHEDULED',
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          customerEmail: data.customerEmail || null,
          employeeId: data.employeeId ?? null,
          categoryId: data.categoryId ?? null,
          googleEventId: null,
          joinToken: null,
          meetingUrl: null,
          meetingProvider: null,
          meetingExpiresAt: null,
        },
      });
      if (reclaimed.count !== 1) {
        // Two identical requests can race: the other one just won. Same customer means success.
        const racedWinner = await this.findHeldByCustomer(tenantId, data);
        if (racedWinner) {
          return racedWinner;
        }
        throw new Error('Concurrency conflict: The requested slot was booked by another caller.');
      }
      appointment = await prisma.appointment.findFirst({
        where: {
          tenantId,
          calendarId: data.calendarId,
          appointmentDateTime: data.appointmentDateTime,
          status: 'SCHEDULED',
        },
      });
      if (!appointment) {
        throw new Error('Concurrency conflict: The requested slot was booked by another caller.');
      }
    }

    // Trigger background asynchronous Google Calendar synchronization
    this.bgSyncGoogleCalendar(appointment.id, tenantId, data.calendarId, {
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      start: data.appointmentDateTime,
      durationMinutes: data.durationMinutes,
    }).catch((bgError) => {
      console.error(`[AppointmentService.createAppointment] Triggering background sync failed for appointment ${appointment.id}:`, bgError);
    });

    // A booked time must not keep being offered from the 30 second slot cache.
    slotCacheService.invalidate(`slots:${tenantId}:`);

    return appointment;
  }

  /**
   * A time as the customer should read or hear it: in DEFAULT_TIME_ZONE, never the server's
   * zone (the container runs in UTC). Stored times stay in UTC.
   */
  public static formatForCustomer(date: Date, withWeekday = false, timeZone: string = config.DEFAULT_TIME_ZONE): string {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      ...(withWeekday ? { weekday: 'long' as const, month: 'long' as const } : { month: 'short' as const }),
      year: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
  }

  /**
   * The scheduled appointment for this exact slot, if it belongs to the same customer phone.
   */
  private static async findHeldByCustomer(
    tenantId: string,
    data: { calendarId: string; appointmentDateTime: Date; customerPhone: string }
  ) {
    return prisma.appointment.findFirst({
      where: {
        tenantId,
        calendarId: data.calendarId,
        appointmentDateTime: data.appointmentDateTime,
        customerPhone: data.customerPhone,
        status: 'SCHEDULED',
      },
    });
  }

  /**
   * Performs Google Calendar synchronization asynchronously in the background.
   */
  private static async bgSyncGoogleCalendar(
    appointmentId: string,
    tenantId: string,
    calendarId: string,
    details: {
      customerName: string;
      customerPhone: string;
      customerEmail?: string | null;
      start: Date;
      durationMinutes?: number;
    }
  ): Promise<void> {
    try {
      const googleEventId = await GoogleCalendarService.createEvent(
        tenantId,
        googleCalendarOf(calendarId),
        details
      );

      // Save googleEventId to the record (Rule of Least Privilege: filter by tenantId)
      await prisma.appointment.updateMany({
        where: {
          id: appointmentId,
          tenantId,
        },
        data: { googleEventId },
      });
      console.log(`[AppointmentService.bgSyncGoogleCalendar] Successfully synced appointment ${appointmentId} to Google Calendar.`);

    } catch (gcalError) {

      console.error(`[AppointmentService.bgSyncGoogleCalendar] Failed to sync appointment ${appointmentId} to Google Calendar:`, gcalError);
      // We do NOT roll back the database reservation. The booking remains in the local DB.
    }

    // Confirmations do not depend on the calendar: a failed sync must not silence them.
    await this.sendConfirmations(appointmentId, details);
  }

  /**
   * Sends the SMS and email confirmations and logs what really happened.
   * Each channel is separate: one failing never stops the other. Never throws.
   * Logs carry the appointment id only, never names, phone numbers or emails.
   */
  private static async sendConfirmations(
    appointmentId: string,
    details: {
      customerName: string;
      customerPhone: string;
      customerEmail?: string | null;
      start: Date;
    }
  ): Promise<void> {
    const dateTimeStr = this.formatForCustomer(details.start);
    const smsBody = SmsService.formatConfirmationText(details.customerName, 'Consultation', dateTimeStr);

    const channels: Array<{ name: string; send: () => Promise<{ status: string; reason?: string }> }> = [
      { name: 'SMS', send: () => SmsService.sendConfirmation({ to: details.customerPhone, body: smsBody }) },
    ];
    if (details.customerEmail) {
      const to = details.customerEmail;
      channels.push({
        name: 'email',
        send: () =>
          EmailService.sendAppointmentConfirmation({
            to,
            subject: 'Appointment Confirmation & iCalendar Invite',
            customerName: details.customerName,
            serviceName: 'Consultation',
            appointmentDateTime: details.start,
          }),
      });
    }

    const results = await Promise.allSettled(channels.map((c) => c.send()));
    results.forEach((result, i) => {
      const name = channels[i].name;
      if (result.status === 'rejected') {
        console.error(`[AppointmentService] Confirmation ${name} failed for appointment ${appointmentId}.`);
      } else {
        const { status, reason } = result.value;
        console.log(
          `[AppointmentService] Confirmation ${name} for appointment ${appointmentId}: ${status}${reason ? ` (${reason})` : ''}`
        );
      }
    });
  }

  /**
   * Cancels an appointment. Deletes Google Calendar event if synchronized.
   */
  public static async cancelAppointment(
    tenantId: string,
    appointmentId: string,
    /** When set, only an appointment of this consultant can be cancelled (a consultant login). */
    onlyEmployeeId?: string
  ) {
    // Verify ownership and fetch appointment (Rule of Least Privilege: filter by tenantId)
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        tenantId,
        ...(onlyEmployeeId ? { employeeId: onlyEmployeeId } : {}),
      },
    });

    if (!appointment) {
      throw new Error('Appointment not found or unauthorized.');
    }

    if (appointment.status === 'CANCELLED') {
      return appointment;
    }

    // If synchronized with Google Calendar, cancel there
    if (appointment.googleEventId) {
      try {
        await GoogleCalendarService.deleteEvent(tenantId, googleCalendarOf(appointment.calendarId), appointment.googleEventId);
      } catch (error) {
        console.warn(`[AppointmentService] Non-fatal error deleting calendar event on cancellation:`, error);
      }
    }

    // Update status in local DB (Rule of Least Privilege: filter by tenantId)
    await prisma.appointment.updateMany({
      where: {
        id: appointmentId,
        tenantId,
      },
      data: {
        status: 'CANCELLED',
      },
    });

    // The freed time can be offered again at once.
    slotCacheService.invalidate(`slots:${tenantId}:`);
    return appointment;
  }
}
