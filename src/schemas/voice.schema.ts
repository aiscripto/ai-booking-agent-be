import { z } from 'zod';
import { config } from '../config';
import { isRealDate } from '../services/availability.service';

export const webhookQuerySchema = z.object({
  tenant_id: z.string().uuid({ message: 'tenant_id must be a valid UUID.' }),
  calendar_id: z.string().min(1, { message: 'calendar_id must not be empty.' }),
  // Only for platforms that send the arguments alone: which tool this web address is for.
  tool: z.enum(['checkAvailability', 'getAvailableTimes', 'bookAppointment', 'listConsultants']).optional(),
});

export const webhookPayloadSchema = z.object({
  type: z.string().optional(),
  message: z
    .object({
      type: z.string().optional(),
      call: z
        .object({
          id: z.string().optional(),
        })
        .optional(),
      toolCalls: z.array(z.any()).optional(),
      transcript: z.string().optional(),
    })
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.any().optional(),
});

export const checkAvailabilitySchema = z.object({
  // Required: the answer comes from this tenant's own appointments and calendar.
  tenant_id: z.string().uuid({ message: 'tenant_id must be a valid UUID.' }),
  // The calendar to check. Defaults to the same default calendar the webhook uses.
  calendar_id: z.string().min(1).optional().default(config.GOOGLE_DEFAULT_CALENDAR_ID),
  // With consultants: the service wanted and/or the consultant asked for (a name or an id). Both optional.
  category: z.string().trim().max(120).optional(),
  consultant: z.string().trim().max(120).optional(),
  // How many times to return. The voice agent reads a few aloud (default); screens can ask for more.
  limit: z.coerce.number().int().min(1).max(50).optional(),
  date: z
    .string()
    .optional()
    .refine((d) => d === undefined || isRealDate(d), { message: 'date must be a real date written YYYY-MM-DD.' }),
  timeZone: z
    .string()
    .optional()
    .default(config.DEFAULT_TIME_ZONE)
    .refine(
      (tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'timeZone must be a valid IANA time zone.' }
    ),
});

