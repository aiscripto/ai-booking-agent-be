import { BookingTimeError, parseBookingTime } from '../services/booking-time';
import { BookingService } from '../services/booking.service';
import { isOwnOnly } from '../middlewares/audit.middleware';
import { ConsultantError } from '../services/consultants/consultant.service';
import { TenantScheduleService } from '../services/tenant-schedule.service';
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../services/db.service';
import { AppointmentService } from '../services/appointment.service';
import { TelehealthService, TelehealthUnavailableError } from '../services/telehealth.service';
import { z } from 'zod';
import { config } from '../config';
import { dayBoundsUtc, isRealDate } from '../services/availability.service';


/** A moment as it should read in the audit log: in the business's own time zone. */
function parsedWhen(moment: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(moment);
}

export class AppointmentController {
  /**
   * The caller's tenant, taken from the verified login token (set by requireAuth).
   * The request's own headers, body and query are never used to choose a tenant.
   */
  private static getTenantId(req: Request): string {
    if (!req.auth?.tenantId) {
      throw new Error('Unauthorized: authentication required.');
    }
    return req.auth.tenantId;
  }

  /**
   * A login limited to "their own appointments" (a consultant) may only touch the appointments of the
   * employee it is linked to. Returns that limit, or null when the login has no limit.
   * `linked` is false when the login is limited but not linked to an employee: it then sees and changes nothing.
   */
  private static ownLimit(req: Request): { employeeId: string | null } | null {
    if (!req.auth || !isOwnOnly(req.auth.permissions)) return null;
    return { employeeId: req.auth.employeeId };
  }


  /**
   * GET /api/v1/appointments
   * Optional Query: date (YYYY-MM-DD)
   */
  public static async listAppointments(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);
      const dateStr = req.query.date as string;

      let whereCondition: any = {
        tenantId,
        status: 'SCHEDULED', // Only list active scheduled appointments
      };

      if (dateStr && isRealDate(dateStr)) {
        // The date is the business's calendar day (its own time zone), not the UTC day: an evening
        // appointment belongs to the day it is on for the people who book it.
        const { start, end } = dayBoundsUtc(dateStr, (await TenantScheduleService.get(tenantId)).timeZone);
        whereCondition.appointmentDateTime = { gte: start, lt: end };
      }

      // A consultant login sees only its own appointments (and none if it is not linked to an employee).
      const limit = AppointmentController.ownLimit(req);
      if (limit) {
        if (!limit.employeeId) {
          res.status(200).json({ status: 'success', data: [] });
          return;
        }
        whereCondition.employeeId = limit.employeeId;
      }

      const appointments = await prisma.appointment.findMany({
        where: whereCondition,
        orderBy: { appointmentDateTime: 'asc' },
        include: { employee: { select: { id: true, fullName: true } }, category: { select: { id: true, name: true } } },
      });

      res.status(200).json({
        status: 'success',
        data: appointments,
      });
    } catch (error: any) {
      res.status(400).json({
        status: 'error',
        message: error.message || 'Failed to list appointments.',
      });
    }
  }

  /**
   * POST /api/v1/appointments
   */
  public static async createAppointment(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);
      const dateTimeRaw = req.body.dateTime || req.body.appointmentDateTime;
      const { customerName, customerPhone, customerEmail } = req.body;


      if (!dateTimeRaw || !customerName || !customerPhone) {
        res.status(400).json({
          status: 'error',
          message: 'dateTime (or appointmentDateTime), customerName, and customerPhone are required fields.',
        });
        return;
      }

      // One rule for the dashboard and the voice agent: a real time, inside opening hours, on the grid.
      // BookingService then books one calendar, or a consultant when the business has consultants.
      let appointment;
      try {
        const schedule = await TenantScheduleService.get(tenantId);
        const when = parseBookingTime(dateTimeRaw, schedule.timeZone);
        // A consultant login can only book for itself, whatever the request says.
        const limit = AppointmentController.ownLimit(req);
        if (limit && !limit.employeeId) {
          res.status(403).json({ status: 'error', message: 'Your login is not linked to a consultant, so it cannot book appointments.' });
          return;
        }
        const booked = await BookingService.book(
          tenantId,
          {
            when,
            calendarId: 'primary', // Default main calendar for client bookings
            customerName,
            customerPhone,
            customerEmail: customerEmail || null,
            consultant: limit ? limit.employeeId : typeof req.body.employeeId === 'string' ? req.body.employeeId : null,
            category: typeof req.body.categoryId === 'string' ? req.body.categoryId : null,
          },
          schedule
        );
        appointment = { ...booked.appointment, consultant: booked.consultant };
        res.locals.audit = {
          summary: `Booked ${customerName} on ${parsedWhen(when, schedule.timeZone)}${booked.consultant ? ` with ${booked.consultant.fullName}` : ''}`,
          entityType: 'appointment',
          entityId: booked.appointment.id,
          details: { customerName, appointmentDateTime: when.toISOString(), consultantId: booked.consultant?.id ?? null },
        };
      } catch (error) {
        if (error instanceof BookingTimeError || error instanceof ConsultantError) {
          res.status(400).json({ status: 'error', message: error.message });
          return;
        }
        throw error;
      }

      res.status(201).json({
        status: 'success',
        data: appointment,
      });
    } catch (error: any) {
      res.status(400).json({
        status: 'error',
        message: error.message || 'Failed to create appointment.',
      });
    }
  }

  /**
   * DELETE /api/v1/appointments/:id
   */
  public static async cancelAppointment(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);
      const { id } = req.params;

      if (!id || !z.string().uuid().safeParse(id).success) {
        res.status(400).json({
          status: 'error',
          message: 'A valid appointment ID path parameter is required.',
        });
        return;
      }

      const limit = AppointmentController.ownLimit(req);
      if (limit && !limit.employeeId) {
        res.status(403).json({ status: 'error', message: 'Your login is not linked to a consultant, so it cannot cancel appointments.' });
        return;
      }
      const cancelled = await AppointmentService.cancelAppointment(tenantId, id, limit?.employeeId ?? undefined);
      const zone = (await TenantScheduleService.get(tenantId)).timeZone;
      res.locals.audit = {
        summary: `Cancelled the appointment of ${cancelled.customerName} on ${parsedWhen(cancelled.appointmentDateTime, zone)}`,
        entityType: 'appointment',
        entityId: id,
        details: { customerName: cancelled.customerName, appointmentDateTime: cancelled.appointmentDateTime.toISOString(), consultantId: cancelled.employeeId },
      };

      res.status(200).json({
        status: 'success',
        message: 'Appointment successfully cancelled.',
      });
    } catch (error: any) {
      res.status(400).json({
        status: 'error',
        message: error.message || 'Failed to cancel appointment.',
      });
    }
  }

  /**
   * GET /api/v1/appointments/logs
   */
  public static async listCallLogs(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);

      // The list leaves out transcript and payload. They hold the most sensitive
      // data and are served one at a time by getCallLog.
      const logs = await prisma.callLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 30, // Limit to recent logs for dashboard view
        select: {
          id: true,
          tenantId: true,
          voiceAgentId: true,
          callSid: true,
          duration: true,
          status: true,
          customerName: true,
          customerPhone: true,
          customerEmail: true,
          purpose: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.status(200).json({
        status: 'success',
        data: logs,
      });
    } catch (error: any) {
      res.status(400).json({
        status: 'error',
        message: error.message || 'Failed to retrieve call logs.',
      });
    }
  }

  /**
   * GET /api/v1/appointments/logs/:id
   * One call log with transcript and payload. Filtered by tenant in the same query.
   */
  public static async getCallLog(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json({ status: 'error', message: 'Invalid call log id.' });
        return;
      }

      const log = await prisma.callLog.findFirst({
        where: { id: id.data, tenantId },
      });
      if (!log) {
        res.status(404).json({ status: 'error', message: 'Call log not found.' });
        return;
      }

      // A transcript holds personal data: opening one is always logged, for every user.
      res.locals.audit = {
        summary: 'Opened a call transcript',
        entityType: 'call',
        entityId: log.id,
        alwaysLog: true,
        details: { caller: log.customerName ?? null },
      };
      res.status(200).json({ status: 'success', data: log });
    } catch (error: unknown) {
      res.status(400).json({
        status: 'error',
        message: error instanceof Error && error.message ? error.message : 'Failed to retrieve call log.',
      });
    }
  }

  /**
   * POST /api/v1/appointments/:id/telehealth
   */
  public static async generateTelehealthLink(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = AppointmentController.getTenantId(req);
      const { id } = req.params;
      const provider = (req.body.provider as 'DAILY' | 'ZOOM' | 'GOOGLE_MEET') || 'DAILY';

      if (!id) {
        res.status(400).json({ status: 'error', message: 'Appointment ID parameter is required.' });
        return;
      }

      const room = await TelehealthService.createVideoRoom(id, provider);

      res.status(200).json({
        status: 'success',
        message: `${provider} video call link generated successfully.`,
        data: {
          appointmentId: id,
          provider: room.provider,
          roomUrl: room.roomUrl,
          expiresAt: room.expiresAt,
        },
      });
    } catch (error: any) {
      // A room that could not be provisioned is a provider or configuration fault,
      // not a malformed request. 503 tells the caller to retry rather than to
      // "fix" input that was already valid. Every other failure keeps its 400.
      const statusCode = error instanceof TelehealthUnavailableError ? 503 : 400;
      res.status(statusCode).json({
        status: 'error',
        message: error.message || 'Failed to generate telehealth link.',
      });
    }
  }
}

