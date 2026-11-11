import { prisma } from './db.service';
import { AppointmentService } from './appointment.service';
import { assertBookableSlot } from './booking-time';
import { ConsultantService, consultantKey } from './consultants/consultant.service';
import { TenantSchedule } from './tenant-schedule.service';

/**
 * The one door every booking goes through (voice agent and dashboard). It decides how the booking is made:
 *  - A business with no consultants: one calendar, as before.
 *  - A business with consultants: the booking is with one consultant. The caller may name a consultant
 *    and/or a service category; with neither, or only a category, "anyone" free is chosen.
 */

export interface BookingRequest {
  when: Date;
  calendarId: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string | null;
  /** A consultant (id or name) and a service category (id or name). Ignored when the business has no consultants. */
  consultant?: string | null;
  category?: string | null;
}

/** Messages from the booking code that mean "this consultant is taken at that time", so the next one may be tried. */
const TAKEN = /already booked|concurrency conflict/i;

export class BookingService {
  public static async book(tenantId: string, request: BookingRequest, schedule: TenantSchedule) {
    assertBookableSlot(request.when, schedule);

    const consultantMode = await ConsultantService.isActive(tenantId);
    if (!consultantMode) {
      return {
        appointment: await AppointmentService.createAppointment(tenantId, {
          calendarId: request.calendarId,
          appointmentDateTime: request.when,
          customerName: request.customerName,
          customerPhone: request.customerPhone,
          customerEmail: request.customerEmail ?? null,
        }),
        consultant: null as { id: string; fullName: string; title: string | null } | null,
      };
    }

    // A retry (the voice platform sends a webhook twice) must not book a second consultant for the same person.
    const already = await prisma.appointment.findFirst({
      where: {
        tenantId,
        appointmentDateTime: request.when,
        customerPhone: request.customerPhone,
        status: 'SCHEDULED',
        employeeId: { not: null },
      },
      include: { employee: { select: { id: true, fullName: true, title: true } } },
    });
    if (already) return { appointment: already, consultant: already.employee };

    const categoryId = await ConsultantService.resolveCategory(tenantId, request.category);
    const employeeId = await ConsultantService.resolveConsultant(tenantId, request.consultant);
    const candidates = await ConsultantService.candidatesAt(tenantId, request.when, schedule, { categoryId, employeeId });

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        const appointment = await AppointmentService.createAppointment(tenantId, {
          calendarId: consultantKey(candidate.id),
          appointmentDateTime: request.when,
          customerName: request.customerName,
          customerPhone: request.customerPhone,
          customerEmail: request.customerEmail ?? null,
          employeeId: candidate.id,
          categoryId,
        });
        return { appointment, consultant: { id: candidate.id, fullName: candidate.fullName, title: candidate.title } };
      } catch (error) {
        if (error instanceof Error && TAKEN.test(error.message)) {
          lastError = error;
          continue; // this consultant is taken at that time; try the next one
        }
        throw error;
      }
    }
    throw lastError ?? new Error('The requested slot is already booked.');
  }
}
