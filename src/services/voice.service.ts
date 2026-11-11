import { BookingTimeError, assertBookableSlot, parseBookingTime } from './booking-time';
import { TenantScheduleService } from './tenant-schedule.service';
import { BookingService } from './booking.service';
import { AuditService } from './audit.service';
import { ConsultantError, ConsultantService, consultantKey } from './consultants/consultant.service';
import { AppointmentService } from './appointment.service';
import { prisma } from './db.service';
import { TRANSACTION_OPTIONS } from '../config/timeouts';
import { AvailabilityService, AvailabilityUnavailableError, isRealDate, todayIn } from './availability.service';
import { config } from '../config';
import { slotCacheService, SlotCacheService } from './slot-cache.service';


export interface ToolCallInput {
  name: string;
  arguments: any;
  toolCallId: string;
}

/** The tools the voice agent can call. Used to check a tool name sent in the web address (see processWebhook). */
export const VOICE_TOOLS = ['checkAvailability', 'getAvailableTimes', 'bookAppointment', 'listConsultants'] as const;
export type VoiceToolName = (typeof VOICE_TOOLS)[number];

/** Tool arguments arrive as an object (Vapi, Retell) or as a JSON string (OpenAI style). Always give back an object. */
function argumentsOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/** The agent reads times aloud, so a long list is not helpful. */
const MAX_SPOKEN_SLOTS = 6;

export class VoiceService {

  /**
   * Main entrypoint for processing voice webhook events.
   * Handles Vapi/Retell tool calls, processes database updates, and posts logs asynchronously.
   */
  public static async processWebhook(
    tenantId: string,
    calendarId: string,
    payload: any,
    /** Name of the tool, taken from the web address (?tool=). Needed only when the platform sends the arguments alone. */
    toolHint?: VoiceToolName
  ): Promise<any> {
    const messageType = payload.message?.type || payload.type;
    const callSid = payload.message?.call?.id || payload.call_id || payload.call?.id || payload.call?.call_id;

    // Log the incoming call payload asynchronously to prevent request blocking
    this.asyncLogCall(tenantId, callSid, payload).catch((err) =>
      console.error('[VoiceService] Error creating call log:', err)
    );

    // The platform sends only the arguments (Retell "Payload: args only") and the web address names the tool.
    if (toolHint && !messageType && !payload.name) {
      return this.executeTool(tenantId, calendarId, { name: toolHint, arguments: argumentsOf(payload), toolCallId: 'flat-tool-call' });
    }

    // Detect and handle flat Custom Tool Call format
    if (!messageType && payload.dateTime) {
      const isBooking = !!(payload.customerPhone || payload.customerName);
      const toolName = isBooking ? 'bookAppointment' : 'checkAvailability';
      console.log(`[VoiceService] Detected flat Custom Tool Call for: ${toolName}`);
      
      const result = await this.executeTool(tenantId, calendarId, {
        name: toolName,
        arguments: payload,
        toolCallId: 'flat-tool-call',
      });
      return result;
    }

    // 1. Vapi tool call. The calls are in message.toolCallList (older versions: message.toolCalls).
    //    Vapi needs each result as a SINGLE-LINE STRING, so the answer is written as one line of JSON.
    if (messageType === 'tool-calls') {
      const toolCalls = payload.message.toolCallList || payload.message.toolCalls || [];
      const results = [];

      for (const tc of toolCalls) {
        const toolName = tc.function?.name || tc.name;
        const args = argumentsOf(tc.function?.arguments ?? tc.arguments ?? tc.parameters);
        const toolCallId = tc.id;

        const result = await this.executeTool(tenantId, calendarId, {
          name: toolName,
          arguments: args,
          toolCallId,
        });

        results.push({
          toolCallId,
          result: JSON.stringify(result),
        });
      }

      return { results };
    }

    // 2. Retell custom function ({ name, args, call }) or a generic tool call with the name in the root.
    //    The answer is returned as a plain JSON object; Retell turns it into text for the agent.
    if (payload.name && (payload.args || payload.arguments || payload.tool_call_id)) {
      const result = await this.executeTool(tenantId, calendarId, {
        name: payload.name,
        arguments: argumentsOf(payload.args ?? payload.arguments),
        toolCallId: payload.tool_call_id ?? payload.call?.call_id ?? 'retell-tool-call',
      });
      return result;
    }

    // 3. Fallback response for status updates, transcriptions, or assistant configuration requests
    return { status: 'ignored_or_processed' };
  }

  /**
   * Executes a single tool request by routing it to the appropriate service.
   */
  private static async executeTool(
    tenantId: string,
    calendarId: string,
    toolCall: ToolCallInput
  ): Promise<any> {
    const { name, arguments: args } = toolCall;
    console.log(`[VoiceService] Executing tool: ${name}`);

    try {
      switch (name) {
        case 'checkAvailability': {
          const { dateTime } = args;
          if (!dateTime) {
            return { success: false, message: 'dateTime parameter is required.' };
          }
          let parsedDate: Date;
          try {
            const schedule = await TenantScheduleService.get(tenantId);
            parsedDate = parseBookingTime(dateTime, schedule.timeZone);
            assertBookableSlot(parsedDate, schedule);
          } catch (error) {
            // A time outside opening hours is "not available", with the reason, so the agent can propose another.
            if (error instanceof BookingTimeError) {
              return { available: false, message: error.message };
            }
            throw error;
          }

          // With consultants, "free" means a consultant who works then and has no booking.
          if (await ConsultantService.isActive(tenantId)) {
            try {
              const schedule = await TenantScheduleService.get(tenantId);
              const categoryId = await ConsultantService.resolveCategory(tenantId, args.category);
              const employeeId = await ConsultantService.resolveConsultant(tenantId, args.consultant);
              const working = await ConsultantService.candidatesAt(tenantId, parsedDate, schedule, { categoryId, employeeId });
              const free: string[] = [];
              for (const c of working) {
                if (await AppointmentService.checkAvailability(tenantId, consultantKey(c.id), parsedDate)) free.push(c.fullName);
              }
              return {
                available: free.length > 0,
                consultants: free,
                message:
                  free.length > 0
                    ? `Slot is available with ${free.join(', ')}.`
                    : 'Slot is not available. Please propose another time or another consultant.',
              };
            } catch (error) {
              if (error instanceof ConsultantError) return { available: false, message: error.message };
              throw error;
            }
          }

          const available = await AppointmentService.checkAvailability(
            tenantId,
            calendarId,
            parsedDate
          );

          return {
            available,
            message: available
              ? 'Slot is available for booking.'
              : 'Slot is not available. Please propose another time.',
          };
        }

        case 'bookAppointment': {
          const { dateTime, customerName, customerPhone, customerEmail } = args;
          if (!dateTime || !customerName || !customerPhone) {
            return {
              success: false,
              message: 'dateTime, customerName, and customerPhone are required parameters.',
            };
          }

          let parsedDate: Date;
          try {
            const schedule = await TenantScheduleService.get(tenantId);
            parsedDate = parseBookingTime(dateTime, schedule.timeZone);
            assertBookableSlot(parsedDate, schedule);
          } catch (error) {
            if (error instanceof BookingTimeError) {
              return { success: false, message: error.message };
            }
            throw error;
          }

          const schedule = await TenantScheduleService.get(tenantId);
          let booked;
          try {
            booked = await BookingService.book(
              tenantId,
              {
                when: parsedDate,
                calendarId,
                customerName,
                customerPhone,
                customerEmail: customerEmail || null,
                consultant: args.consultant,
                category: args.category,
              },
              schedule
            );
          } catch (error) {
            if (error instanceof ConsultantError) return { success: false, message: error.message };
            throw error;
          }

          const withWhom = booked.consultant ? ` with ${booked.consultant.fullName}` : '';
          await AuditService.record(
            tenantId,
            { userId: null, name: 'Voice agent', role: 'system' },
            {
              action: 'voice.bookAppointment',
              entityType: 'appointment',
              entityId: booked.appointment.id,
              summary: `Voice agent booked ${customerName} on ${AppointmentService.formatForCustomer(parsedDate, true, schedule.timeZone)}${withWhom}`,
              details: { customerName, appointmentDateTime: parsedDate.toISOString(), consultantId: booked.consultant?.id ?? null },
            },
          );
          return {
            success: true,
            appointmentId: booked.appointment.id,
            consultant: booked.consultant?.fullName ?? null,
            // Said in the business's own time zone, never as a UTC timestamp.
            message: `Appointment successfully booked for ${customerName}${withWhom} on ${AppointmentService.formatForCustomer(parsedDate, true, schedule.timeZone)}.`,
          };
        }

        // The free times of one day (optionally for one service and/or one consultant), as the agent should offer them.
        case 'getAvailableTimes': {
          const { date, category, consultant } = args;
          const limit = typeof args.limit === 'number' && args.limit >= 1 ? Math.min(Math.floor(args.limit), 50) : undefined;
          if (date !== undefined && (typeof date !== 'string' || !isRealDate(date))) {
            return { success: false, message: 'date must be a real date written YYYY-MM-DD.' };
          }
          return VoiceService.checkAvailabilitySlots(tenantId, calendarId, date, undefined, limit, {
            category: typeof category === 'string' ? category : null,
            consultant: typeof consultant === 'string' ? consultant : null,
          });
        }

        // Who can be booked and for what, so the agent can offer real names and services (nothing invented).
        case 'listConsultants': {
          if (!(await ConsultantService.isActive(tenantId))) {
            return { success: true, consultants: [], categories: [], message: 'This business books one calendar; there are no named consultants.' };
          }
          const [consultants, categories] = await Promise.all([ConsultantService.list(tenantId), ConsultantService.categories(tenantId)]);
          return {
            success: true,
            categories: categories.map((c) => c.name),
            consultants: consultants.map((c) => ({ name: c.fullName, title: c.title, services: c.categories.map((x) => x.name) })),
          };
        }

        default:
          return {
            success: false,
            message: `Unknown tool execution request: ${name}`,
          };
      }
    } catch (error: any) {
      console.error(`[VoiceService] Error executing tool ${name}:`, error);
      return {
        success: false,
        message: error.message || 'An error occurred during tool execution.',
      };
    }
  }

  /**
   * Asynchronously saves call webhook metadata to the database, ensuring zero execution blockages.
   */
  private static async asyncLogCall(
    tenantId: string,
    callSid: string | undefined,
    payload: any
  ): Promise<void> {
    const messageType = payload.message?.type || payload.type || 'unknown';
    const status = payload.message?.status || payload.status || 'active';
    
    // Extract customer phone
    const customerPhone = 
      payload.message?.customer?.number || 
      payload.customer?.number || 
      payload.message?.call?.customer?.number || 
      null;

    // Extract customer name
    const customerName = 
      payload.message?.customer?.name || 
      payload.customer?.name || 
      null;

    // Extract customer email
    const customerEmail = 
      payload.message?.customer?.email || 
      payload.customer?.email || 
      null;

    // Extract purpose (summary of call from end-of-call analysis)
    const purpose = 
      payload.message?.analysis?.summary || 
      payload.analysis?.summary || 
      payload.message?.analysis?.structuredData?.Purpose ||
      payload.message?.analysis?.structuredData?.purpose ||
      null;

    // Extract transcript
    const transcript = 
      payload.message?.transcript || 
      payload.transcript || 
      payload.message?.call?.transcript || 
      null;

    // Extract duration
    const duration = 
      payload.message?.duration || 
      payload.duration || 
      payload.message?.call?.duration || 
      null;

    // Map webhook event status to simplified state
    let callStatus = 'in-progress';
    if (messageType === 'end-of-call-report' || status === 'ended' || payload.message?.status === 'ended') {
      callStatus = 'completed';
    } else if (status === 'failed') {
      callStatus = 'failed';
    }

    // Proactively fill in patient details using their booking if missing from Vapi profile
    let finalCustomerName = customerName;
    let finalCustomerEmail = customerEmail;
    if (customerPhone && (!finalCustomerName || !finalCustomerEmail)) {
      const latestAppt = await prisma.appointment.findFirst({
        where: { tenantId, customerPhone },
        orderBy: { createdAt: 'desc' },
      });
      if (latestAppt) {
        if (!finalCustomerName) finalCustomerName = latestAppt.customerName;
        if (!finalCustomerEmail) finalCustomerEmail = latestAppt.customerEmail;
      }
    }

    // 1. If callSid is provided, there must be exactly one row per (tenant, call).
    // Events for one call can arrive together. A transaction-scoped database lock keyed on
    // the tenant and call makes them queue up, so find-then-write cannot create two rows.
    if (callSid) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${callSid}))`;

        const existing = await tx.callLog.findFirst({
          where: { tenantId, callSid },
        });

        if (existing) {
          await tx.callLog.updateMany({
            where: { id: existing.id, tenantId },
            data: {
              status: callStatus,
              transcript: transcript || existing.transcript,
              duration: duration ? Math.round(duration) : existing.duration,
              customerName: finalCustomerName || existing.customerName,
              customerPhone: customerPhone || existing.customerPhone,
              customerEmail: finalCustomerEmail || existing.customerEmail,
              purpose: purpose || existing.purpose,
              payload: payload,
            },
          });
          return;
        }

        await tx.callLog.create({
          data: {
            tenantId,
            callSid,
            status: callStatus,
            duration: duration ? Math.round(duration) : null,
            transcript,
            customerName: finalCustomerName,
            customerPhone,
            customerEmail: finalCustomerEmail,
            purpose,
            payload: payload,
          },
        });
      }, TRANSACTION_OPTIONS);
      return;
    }

    // 2. No call id: nothing to match on, so create a new CallLog row
    await prisma.callLog.create({
      data: {
        tenantId,
        callSid: callSid || null,
        status: callStatus,
        duration: duration ? Math.round(duration) : null,
        transcript,
        customerName: finalCustomerName,
        customerPhone,
        customerEmail: finalCustomerEmail,
        purpose,
        payload: payload,
      },
    });
  }

  /**
   * Free appointment times for one date, for the voice agent to read out.
   *
   * One source of truth (decision D3): the local appointments table plus Google Calendar, the same
   * places a booking is checked against, so every time offered here can be booked. Cal.com is not
   * asked. If the calendar cannot be read the answer says so; times are never guessed.
   *
   * `availableSlots` are the spoken labels and `availableSlotsIso` the same times in UTC, in the same
   * order, for the agent to pass to bookAppointment. At most MAX_SPOKEN_SLOTS are returned.
   */
  public static async checkAvailabilitySlots(
    tenantId: string,
    calendarId: string,
    date?: string,
    callerTimeZone?: string,
    limit: number = MAX_SPOKEN_SLOTS,
    filter: { category?: string | null; consultant?: string | null } = {}
  ): Promise<{
    responseText: string;
    closed: boolean;
    /** True when the calendar could not be read, so no times could be worked out. */
    unavailable: boolean;
    availableSlots: string[];
    availableSlotsIso: string[];
    /** For each time above, the consultants who are free then (empty when the business has no consultants). */
    slotConsultants: string[][];
    /** The same consultants as ids, so a screen can match them to its own list. */
    slotConsultantIds: string[][];
    totalFree: number;
    executionTimeMs: number;
    cached?: boolean;
  }> {
    const startTime = Date.now();
    // The business's own time zone decides the hours. A zone sent by the caller is ignored, unless the
    // business has none of its own AND the caller sends one (never the case over HTTP: see the controller).
    const timeZone = callerTimeZone ?? (await TenantScheduleService.get(tenantId)).timeZone;
    const targetDate = date || todayIn(timeZone);

    // With consultants, free times are per consultant, narrowed by the service and/or the person asked for.
    const consultantMode = await ConsultantService.isActive(tenantId);
    let categoryId: string | null = null;
    let employeeId: string | null = null;
    if (consultantMode) {
      try {
        categoryId = await ConsultantService.resolveCategory(tenantId, filter.category);
        employeeId = await ConsultantService.resolveConsultant(tenantId, filter.consultant);
      } catch (error) {
        if (error instanceof ConsultantError) {
          // Say plainly what could not be found; never fall back to someone else's times.
          return {
            responseText: error.message,
            closed: false,
            unavailable: false,
            availableSlots: [],
            availableSlotsIso: [],
            slotConsultants: [],
            slotConsultantIds: [],
            totalFree: 0,
            executionTimeMs: Date.now() - startTime,
            cached: false,
          };
        }
        throw error;
      }
    }
    const scope = consultantMode ? `cons:${categoryId ?? '-'}:${employeeId ?? '-'}` : calendarId;
    const cacheKey = SlotCacheService.buildKey(tenantId, scope, targetDate, timeZone);

    // The cache holds every free time for the day; the answer is cut to `limit` for each request.
    type FullDay = { closed: boolean; slotsIso: string[]; consultants: string[][]; consultantIds: string[][] };
    const answer = (full: FullDay, cached: boolean) => {
      const spokenIso = full.slotsIso.slice(0, limit);
      const labels = spokenIso.map((iso) =>
        new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
      );
      let responseText: string;
      if (full.closed) {
        responseText = `We are closed on ${targetDate}. Would you like to try another day?`;
      } else if (full.slotsIso.length === 0) {
        responseText = `There are no available appointment slots on ${targetDate}. Would you like to try another day?`;
      } else {
        const more =
          full.slotsIso.length > spokenIso.length
            ? ` There are ${full.slotsIso.length - spokenIso.length} more times if none of these suit you.`
            : '';
        responseText = `Available appointment slots for ${targetDate} are at ${labels.join(', ')}.${more} Which time works best for you?`;
      }
      return {
        responseText,
        closed: full.closed,
        unavailable: false,
        availableSlots: labels,
        availableSlotsIso: spokenIso,
        slotConsultants: full.consultants.slice(0, limit),
        slotConsultantIds: full.consultantIds.slice(0, limit),
        totalFree: full.slotsIso.length,
        executionTimeMs: Date.now() - startTime,
        cached,
      };
    };

    const cachedDay = slotCacheService.get<FullDay>(cacheKey);
    if (cachedDay) {
      return answer(cachedDay, true);
    }

    try {
      let full: FullDay;
      if (consultantMode) {
        const schedule = await TenantScheduleService.get(tenantId);
        const day = await ConsultantService.getFreeSlots(tenantId, targetDate, schedule, { categoryId, employeeId });
        full = {
          closed: day.closed,
          slotsIso: day.slots.map((slot) => slot.start.toISOString()),
          consultants: day.slots.map((slot) => slot.consultants.map((c) => c.fullName)),
          consultantIds: day.slots.map((slot) => slot.consultants.map((c) => c.id)),
        };
      } else {
        const { closed, slots } = await AvailabilityService.getFreeSlots(tenantId, calendarId, targetDate, timeZone);
        full = { closed, slotsIso: slots.map((slot) => slot.toISOString()), consultants: slots.map(() => []), consultantIds: slots.map(() => []) };
      }
      slotCacheService.set(cacheKey, full, 30);
      return answer(full, false);
    } catch (error) {
      // Do not offer made-up slots: a caller could book a time that does not exist.
      if (!(error instanceof AvailabilityUnavailableError)) {
        console.warn('[VoiceService] Availability lookup failed:', error);
      }
      return {
        responseText:
          'I am unable to check the calendar right now. Please try again in a moment, or I can take your details and have someone call you back.',
        closed: false,
        unavailable: true,
        availableSlots: [],
        availableSlotsIso: [],
        slotConsultants: [],
        slotConsultantIds: [],
        totalFree: 0,
        executionTimeMs: Date.now() - startTime,
        cached: false,
      };
    }
  }
}


