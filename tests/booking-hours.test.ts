import request from 'supertest';
import type { Server } from 'http';
import { config } from '../src/config';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { buildDaySlots } from '../src/services/availability.service';
import { AppointmentService } from '../src/services/appointment.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';
import { assertBookableSlot, BookingTimeError, isBookableSlot, parseBookingTime } from '../src/services/booking-time';
import { toolResult } from './helpers/voice';
import { bearer, createStaff, removeStaff, TestStaff } from './helpers/auth';

jest.mock('../src/services/google-calendar.service', () => ({
  GoogleCalendarService: { checkAvailability: jest.fn(), createEvent: jest.fn(), deleteEvent: jest.fn() },
}));

// DAT-010: a booking must be a real time, inside opening hours, on the 30 minute grid, judged in the
// business's own time zone; and the spoken reply must not be a UTC timestamp.
describe('Booking times (DAT-010)', () => {
  const zone = config.DEFAULT_TIME_ZONE; // America/New_York in tests
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1901';
  const calendarId = 'hours-test-calendar';
  let staff: TestStaff;
  let server: Server;

  // A date that is open (Mon-Fri) and one that is closed (Sunday), well in the future.
  const dayKeys = (() => {
    let open = '';
    let closed = '';
    for (let i = 0; i < 14 && (!open || !closed); i++) {
      const key = new Date(Date.UTC(2031, 0, 6 + i)).toISOString().slice(0, 10);
      if (buildDaySlots(key, zone).length > 0) open ||= key;
      else closed ||= key;
    }
    return { open, closed };
  })();

  const webhook = (name: string, args: Record<string, unknown>) =>
    request(server)
      .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
      .set('x-api-key', config.WEBHOOK_API_KEY)
      .send({ message: { type: 'tool-calls', toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] } });

  beforeAll(async () => {
    server = app.listen(0);
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: 'Hours Test', industry: 'HEALTHCARE' } });
    staff = await createStaff(tenantId, 'ADMIN');
  });
  beforeEach(async () => {
    (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
    (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('evt');
    await prisma.appointment.deleteMany({ where: { tenantId } });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.appointment.deleteMany({ where: { tenantId } });
    await removeStaff(staff);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  describe('parseBookingTime', () => {
    it('reads a time without an offset as the business clock (winter and summer)', () => {
      expect(parseBookingTime('2031-01-08T10:00:00').toISOString()).toBe('2031-01-08T15:00:00.000Z'); // EST
      expect(parseBookingTime('2031-07-09T10:00').toISOString()).toBe('2031-07-09T14:00:00.000Z'); // EDT
    });
    it('keeps a time that has an offset or Z, including +0500', () => {
      expect(parseBookingTime('2031-01-08T15:00:00Z').toISOString()).toBe('2031-01-08T15:00:00.000Z');
      expect(parseBookingTime('2031-01-08T20:00:00+05:00').toISOString()).toBe('2031-01-08T15:00:00.000Z');
      expect(parseBookingTime('2031-01-08T20:00:00+0500').toISOString()).toBe('2031-01-08T15:00:00.000Z');
    });
    it('refuses nonsense and dates that do not exist', () => {
      for (const bad of ['', 'tomorrow-ish', '2031-02-30T10:00:00', '2031-01-08T25:00:00', undefined, 42]) {
        expect(() => parseBookingTime(bad)).toThrow(BookingTimeError);
      }
    });
  });

  describe('isBookableSlot', () => {
    const at = (day: string, hhmm: string) => parseBookingTime(`${day}T${hhmm}:00`);
    it('accepts the grid inside opening hours, and nothing else', () => {
      expect(isBookableSlot(at(dayKeys.open, '10:00'))).toBe(true);
      expect(isBookableSlot(at(dayKeys.open, '16:30'))).toBe(true);
      expect(isBookableSlot(at(dayKeys.open, '10:07'))).toBe(false); // off the grid
      expect(isBookableSlot(at(dayKeys.open, '03:00'))).toBe(false); // night
      expect(isBookableSlot(at(dayKeys.open, '17:00'))).toBe(false); // closing time: no slot starts then
      expect(isBookableSlot(at(dayKeys.closed, '10:00'))).toBe(false); // closed day
      expect(() => assertBookableSlot(at(dayKeys.closed, '10:00'))).toThrow(/Monday to Friday 09:00-17:00/);
    });
  });

  describe('the voice agent', () => {
    it('refuses 3 am, a closed day and 10:07, and says why', async () => {
      for (const when of [`${dayKeys.open}T03:00:00`, `${dayKeys.closed}T10:00:00`, `${dayKeys.open}T10:07:00`]) {
        const res = await webhook('bookAppointment', { dateTime: when, customerName: 'Nina Night', customerPhone: '555-0001' });
        expect(toolResult(res).success).toBe(false);
        expect(toolResult(res).message).toMatch(/not available for booking/);
      }
      expect(await prisma.appointment.count({ where: { tenantId } })).toBe(0);
    });

    it('says "not available" with the opening hours when asked about a closed time', async () => {
      const res = await webhook('checkAvailability', { dateTime: `${dayKeys.closed}T10:00:00` });
      expect(toolResult(res).available).toBe(false);
      expect(toolResult(res).message).toMatch(/Monday to Friday 09:00-17:00/);
    });

    it('books a time written without an offset at the business clock, and speaks it in that zone, not UTC', async () => {
      const res = await webhook('bookAppointment', { dateTime: `${dayKeys.open}T10:00:00`, customerName: 'Dana Day', customerPhone: '555-0002' });
      const result = toolResult(res);
      expect(result.success).toBe(true);
      const row = await prisma.appointment.findFirst({ where: { tenantId } });
      expect(row?.appointmentDateTime.toISOString()).toBe(parseBookingTime(`${dayKeys.open}T10:00:00`).toISOString());
      expect(row?.appointmentDateTime.getUTCHours()).toBe(15); // 10:00 New York in January
      expect(result.message).toContain('10:00 AM');
      expect(result.message).toMatch(/EST|EDT/);
      expect(result.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamp
    });
  });

  describe('the dashboard', () => {
    const post = (dateTime: string) =>
      request(server).post('/api/v1/appointments').set(bearer(staff)).send({ dateTime, customerName: 'Sam Staff', customerPhone: '555-0003' });

    it('refuses a closed time with 400 and the reason, and books an open one', async () => {
      const bad = await post(`${dayKeys.open}T03:00:00`);
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/Monday to Friday 09:00-17:00/);
      expect((await post(`${dayKeys.open}T10:07:00Z`)).status).toBe(400);
      const good = await post(parseBookingTime(`${dayKeys.open}T11:30:00`).toISOString());
      expect(good.status).toBe(201);
    });
  });

  describe('the "next free time" suggestion', () => {
    it('never suggests a time outside opening hours: after the last slot of the day it suggests the next open morning', async () => {
      const last = parseBookingTime(`${dayKeys.open}T16:30:00`);
      const next = await AppointmentService.findNextAvailableSlot(tenantId, calendarId, last);
      expect(next).not.toBeNull();
      expect(isBookableSlot(next as Date)).toBe(true);
      expect((next as Date).getTime()).toBeGreaterThan(last.getTime());
    });
  });
});
