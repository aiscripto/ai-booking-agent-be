import request from 'supertest';
import type { Server } from 'http';
import { config } from '../src/config';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { buildDaySlots } from '../src/services/availability.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';
import { describeWeekly, summarize, weeklyHoursSchema, WeeklyHours } from '../src/services/business-hours';
import { TenantScheduleService } from '../src/services/tenant-schedule.service';
import { bearer, createStaff, removeStaff, TestStaff } from './helpers/auth';

jest.mock('../src/services/google-calendar.service', () => ({
  GoogleCalendarService: { checkAvailability: jest.fn(), createEvent: jest.fn(), deleteEvent: jest.fn(), getBusyIntervals: jest.fn() },
}));

const everyDay = (start: string, end: string): WeeklyHours => Array.from({ length: 7 }, () => [{ start, end }]);
const onlyDays = (days: number[], start: string, end: string): WeeklyHours =>
  Array.from({ length: 7 }, (_, d) => (days.includes(d) ? [{ start, end }] : []));

describe('Opening hours model', () => {
  it('8, 12 and 24 hour days give 16, 24 and 48 half-hour slots', () => {
    const slots = (start: string, end: string) => buildDaySlots('2031-01-08', 'America/New_York', everyDay(start, end)).length;
    expect(slots('09:00', '17:00')).toBe(16);
    expect(slots('08:00', '20:00')).toBe(24);
    expect(slots('00:00', '24:00')).toBe(48);
  });

  it('a break (two ranges) leaves a gap, and a closed day has no slots', () => {
    const week: WeeklyHours = onlyDays([1, 2, 3, 4, 5], '09:00', '12:00').map((r) => (r.length ? [...r, { start: '13:00', end: '17:00' }] : r));
    const day = buildDaySlots('2031-01-08', 'America/New_York', week).map((d) => d.toISOString().slice(11, 16));
    expect(day).toContain('14:00'); // 09:00 New York
    expect(day).not.toContain('17:00'); // 12:00 New York: lunch
    expect(day).toContain('18:00'); // 13:00 New York
    expect(buildDaySlots('2031-01-12', 'America/New_York', week)).toEqual([]); // a Sunday
  });

  it('describes the week in plain words', () => {
    expect(describeWeekly(onlyDays([1, 2, 3, 4, 5], '09:00', '17:00'))).toBe('Monday to Friday 09:00-17:00');
    expect(describeWeekly(everyDay('00:00', '24:00'))).toBe('Monday to Sunday 00:00-24:00');
    const mixed = onlyDays([1, 2, 3, 4, 5], '08:00', '20:00');
    mixed[6] = [{ start: '10:00', end: '14:00' }];
    expect(describeWeekly(mixed)).toBe('Monday to Friday 08:00-20:00; Saturday 10:00-14:00');
    expect(describeWeekly(onlyDays([], '09:00', '17:00'))).toBe('Closed every day');
  });

  it('the short form for the calendar grid never ends at 24:00', () => {
    expect(summarize(everyDay('00:00', '24:00'))).toEqual({ start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('refuses overlapping ranges, an end before the start, a bad time, and not seven days', () => {
    const overlap = onlyDays([1], '09:00', '12:00');
    overlap[1].push({ start: '11:00', end: '13:00' });
    expect(weeklyHoursSchema.safeParse(overlap).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(onlyDays([1], '17:00', '09:00')).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(onlyDays([1], '9:00', '17:00')).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(onlyDays([1], '24:00', '24:00')).success).toBe(false);
    expect(weeklyHoursSchema.safeParse([[], []]).success).toBe(false);
    expect(weeklyHoursSchema.safeParse(everyDay('00:00', '24:00')).success).toBe(true);
  });
});

describe('Opening hours set in Setup apply to booking and availability', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1a01';
  const calendarId = 'primary';
  let staff: TestStaff;
  let server: Server;

  // Two dates in the future: a Monday and a Sunday.
  const monday = '2031-01-06';
  const sunday = '2031-01-12';

  const saveBusiness = (timeZone: string, businessHours: WeeklyHours) =>
    request(server).put('/api/v1/admin/business').set(bearer(staff)).send({ name: 'Hours Test', timeZone, businessHours });
  const book = (dateTime: string) =>
    request(server).post('/api/v1/appointments').set(bearer(staff)).send({ dateTime, customerName: 'Hana Hours', customerPhone: '555-0100' });
  const freeTimes = (date: string, extra = '') =>
    request(server).get(`/api/v1/voice/check-availability?tenant_id=${tenantId}&date=${date}&limit=50${extra}`);

  beforeAll(async () => {
    server = app.listen(0);
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: 'Hours Test', industry: 'HEALTHCARE' } });
    staff = await createStaff(tenantId, 'ADMIN');
  });
  beforeEach(async () => {
    TenantScheduleService.clearAll();
    (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
    (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('evt');
    (GoogleCalendarService.getBusyIntervals as jest.Mock).mockResolvedValue([]);
    await prisma.appointment.deleteMany({ where: { tenantId } });
    await prisma.$executeRaw`UPDATE tenants SET business_hours = NULL, time_zone = NULL WHERE id = ${tenantId}::uuid`;
    TenantScheduleService.invalidate(tenantId);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.appointment.deleteMany({ where: { tenantId } });
    await removeStaff(staff);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  it('a business that set nothing uses the server settings, and says so', async () => {
    const res = await request(server).get('/api/v1/admin/business').set(bearer(staff));
    expect(res.body.data.hoursAreDefaults).toBe(true);
    expect(res.body.data.timeZone).toBe(config.DEFAULT_TIME_ZONE);
    expect(res.body.data.businessHours[1]).toEqual([{ start: config.BUSINESS_HOURS_START, end: config.BUSINESS_HOURS_END }]);
    expect(res.body.data.businessHours[0]).toEqual([]);
  });

  it('a 24 hour business can be booked at 3 am, and its free times are 48 a day, at once after saving', async () => {
    expect((await book(`${monday}T03:00:00`)).status).toBe(400); // default hours: refused
    expect((await freeTimes(monday)).body.data.totalFree).toBe(16);

    const saved = await saveBusiness('America/New_York', everyDay('00:00', '24:00'));
    expect(saved.status).toBe(200);
    expect(saved.body.data.hoursAreDefaults).toBe(false);

    expect((await book(`${monday}T03:00:00`)).status).toBe(201);
    expect((await freeTimes(monday)).body.data.totalFree).toBe(47); // 48 minus the one just booked
    expect((await freeTimes(sunday)).body.data.totalFree).toBe(48); // Sunday is open now
  });

  it('saving new hours clears the cached free times at once (no booking in between)', async () => {
    expect((await freeTimes(monday)).body.data.totalFree).toBe(16); // now cached
    await saveBusiness('America/New_York', everyDay('00:00', '24:00'));
    expect((await freeTimes(monday)).body.data.totalFree).toBe(48);
  });

  it('a 12 hour day with a lunch break: the break is refused, the afternoon is open', async () => {
    const week = onlyDays([1, 2, 3, 4, 5], '08:00', '12:00').map((r) => (r.length ? [...r, { start: '13:00', end: '20:00' }] : r));
    expect((await saveBusiness('America/New_York', week)).status).toBe(200);
    expect((await book(`${monday}T12:00:00`)).status).toBe(400);
    expect((await book(`${monday}T12:30:00`)).status).toBe(400);
    expect((await book(`${monday}T19:30:00`)).status).toBe(201);
    expect((await freeTimes(monday)).body.data.totalFree).toBe(8 + 14 - 1);
  });

  it('a different time zone changes what "10:00" means, and the caller zone is ignored', async () => {
    expect((await saveBusiness('Asia/Karachi', onlyDays([1], '09:00', '17:00'))).status).toBe(200);
    const res = await book(`${monday}T10:00:00`);
    expect(res.status).toBe(201);
    expect(new Date(res.body.data.appointmentDateTime).toISOString()).toBe('2031-01-06T05:00:00.000Z'); // 10:00 in UTC+5
    // A caller who says it is in Tokyo gets the business's own hours, not Tokyo's.
    const free = await freeTimes(monday, '&timeZone=Asia/Tokyo');
    expect(free.body.data.availableSlotsIso[0]).toBe('2031-01-06T04:00:00.000Z'); // 09:00 in UTC+5
  });

  it('the tenant screens get the full week and the short form', async () => {
    await saveBusiness('America/Chicago', onlyDays([6], '10:00', '14:00'));
    const res = await request(server).get('/api/v1/tenant/vocabulary').set(bearer(staff));
    expect(res.body.data.timeZone).toBe('America/Chicago');
    expect(res.body.data.businessHours).toMatchObject({ start: '10:00', end: '14:00', days: [6] });
    expect(res.body.data.businessHours.weekly[6]).toEqual([{ start: '10:00', end: '14:00' }]);
  });

  it('refuses bad hours or a bad zone with 400 and keeps the old hours', async () => {
    expect((await saveBusiness('Nowhere/City', everyDay('09:00', '17:00'))).status).toBe(400);
    expect((await saveBusiness('America/New_York', onlyDays([], '09:00', '17:00'))).body.message).toMatch(/Open at least one day/);
    expect((await saveBusiness('America/New_York', onlyDays([1], '17:00', '09:00'))).status).toBe(400);
    const res = await request(server).get('/api/v1/admin/business').set(bearer(staff));
    expect(res.body.data.hoursAreDefaults).toBe(true);
  });
});
