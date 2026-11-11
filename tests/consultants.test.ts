import request from 'supertest';
import type { Server } from 'http';
import { config } from '../src/config';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';
import { TenantScheduleService } from '../src/services/tenant-schedule.service';
import { toolResult } from './helpers/voice';
import { bearer, createStaff, removeStaff, TestStaff } from './helpers/auth';

jest.mock('../src/services/google-calendar.service', () => ({
  GoogleCalendarService: { checkAvailability: jest.fn(), createEvent: jest.fn(), deleteEvent: jest.fn(), getBusyIntervals: jest.fn() },
}));

// Consultants are employees who take appointments. Times below are in the business zone (America/New_York in tests).
describe('Consultants and service categories', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1b01';
  const otherTenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1b02';
  const monday = '2031-01-06';
  const thursday = '2031-01-09';
  let server: Server;
  let admin: TestStaff;
  let desk: TestStaff;
  let otherAdmin: TestStaff;
  let dentist = '';
  let skin = '';
  let ann = ''; // Dentist; own hours Monday to Wednesday 09:00-13:00
  let bob = ''; // Dentist and Skin; follows the business hours

  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, who: TestStaff = admin) => request(server)[method](path).set(bearer(who));
  const week = (days: number[], start: string, end: string) => Array.from({ length: 7 }, (_, d) => (days.includes(d) ? [{ start, end }] : []));
  const webhook = (name: string, args: Record<string, unknown>) =>
    request(server)
      .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=primary`)
      .set('x-api-key', config.WEBHOOK_API_KEY)
      .send({ message: { type: 'tool-calls', toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: args } }] } });
  const slots = (date: string, query = '') => request(server).get(`/api/v1/voice/check-availability?tenant_id=${tenantId}&date=${date}&limit=50${query}`);
  const book = (dateTime: string, body: object = {}, phone = '555-0100') =>
    api('post', '/api/v1/appointments').send({ dateTime, customerName: 'Cora Customer', customerPhone: phone, ...body });
  const employee = (fullName: string, extra: object = {}) =>
    api('post', '/api/v1/admin/employees').send({ fullName, isBookable: true, ...extra });

  beforeAll(async () => {
    server = app.listen(0);
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: 'Consultants Test', industry: 'HEALTHCARE' } });
    }
    admin = await createStaff(tenantId, 'ADMIN');
    desk = await createStaff(tenantId, 'FRONT_DESK');
    otherAdmin = await createStaff(otherTenantId, 'ADMIN');
  });

  beforeEach(() => {
    TenantScheduleService.clearAll();
    (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
    (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('evt');
    (GoogleCalendarService.deleteEvent as jest.Mock).mockResolvedValue(undefined);
    (GoogleCalendarService.getBusyIntervals as jest.Mock).mockResolvedValue([]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeStaff(admin, desk, otherAdmin);
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });

  it('a business with no consultants keeps booking one calendar', async () => {
    const res = await book(`${monday}T10:00:00`);
    expect(res.status).toBe(201);
    expect(res.body.data.employeeId).toBeNull();
    expect((await api('get', '/api/v1/tenant/consultants', desk)).body.data).toEqual({ categories: [], consultants: [] });
    await api('delete', `/api/v1/appointments/${res.body.data.id}`);
  });

  describe('setting them up', () => {
    it('only people who may manage the organization can; others get 403', async () => {
      expect((await api('post', '/api/v1/admin/categories', desk).send({ name: 'X' })).status).toBe(403);
      expect((await api('get', '/api/v1/admin/categories', desk)).status).toBe(403);
    });

    it('creates categories (no duplicates) and consultants with services and their own hours', async () => {
      const d = await api('post', '/api/v1/admin/categories').send({ name: 'Dentist', description: 'Teeth' });
      const s = await api('post', '/api/v1/admin/categories').send({ name: 'Skin check' });
      expect(d.status).toBe(201);
      expect((await api('post', '/api/v1/admin/categories').send({ name: 'Dentist' })).status).toBe(409);
      dentist = d.body.data.id;
      skin = s.body.data.id;

      const a = await employee('Ann Adams', { title: 'dentist', categoryIds: [dentist], workingHours: week([1, 2, 3], '09:00', '13:00') });
      const b = await employee('Bob Brown', { title: 'dermatologist', categoryIds: [dentist, skin] });
      expect(a.status).toBe(201);
      expect(a.body.data).toMatchObject({ isBookable: true, title: 'dentist' });
      expect(a.body.data.categories.map((c: { name: string }) => c.name)).toEqual(['Dentist']);
      ann = a.body.data.id;
      bob = b.body.data.id;
      await employee('Cy Clerk', { isBookable: false }); // an employee who does not take appointments

      const list = (await api('get', '/api/v1/tenant/consultants', desk)).body.data;
      expect(list.consultants.map((c: { fullName: string }) => c.fullName)).toEqual(['Ann Adams', 'Bob Brown']);
      expect(list.categories.map((c: { name: string }) => c.name)).toEqual(['Dentist', 'Skin check']);
    });

    it('refuses a category from another tenant, bad dates for days off, and deleting a category in use', async () => {
      const foreign = (await api('post', '/api/v1/admin/categories', otherAdmin).send({ name: 'Foreign' })).body.data.id;
      expect((await employee('Dee Dee', { categoryIds: [foreign] })).status).toBe(400);
      expect((await api('post', `/api/v1/admin/employees/${bob}/time-off`).send({ startDate: '2031-02-30', endDate: '2031-02-30' })).status).toBe(400);
      expect((await api('post', `/api/v1/admin/employees/${bob}/time-off`).send({ startDate: '2031-03-02', endDate: '2031-03-01' })).status).toBe(400);
      expect((await api('delete', `/api/v1/admin/categories/${dentist}`)).status).toBe(409);
      expect((await api('get', '/api/v1/admin/categories', otherAdmin)).body.data.map((c: { name: string }) => c.name)).toEqual(['Foreign']);
    });
  });

  describe('free times', () => {
    it('shows who is free at each time, from each consultant\'s own hours', async () => {
      const res = await slots(monday, `&category=Dentist`);
      const times: string[] = res.body.data.availableSlotsIso;
      const names: string[][] = res.body.data.slotConsultants;
      expect(res.body.data.totalFree).toBe(16); // Bob covers the whole day
      const at = (iso: string) => names[times.indexOf(iso)];
      expect(at('2031-01-06T15:00:00.000Z')).toEqual(['Ann Adams', 'Bob Brown']); // 10:00 New York: both work
      const ids: string[][] = res.body.data.slotConsultantIds;
      expect(ids[times.indexOf('2031-01-06T15:00:00.000Z')]).toEqual([ann, bob]); // the same people, as ids
      expect(at('2031-01-06T20:00:00.000Z')).toEqual(['Bob Brown']); // 15:00 New York: Ann has finished
    });

    it('narrows to one person, and to a service only some offer', async () => {
      const onlyAnn = await slots(monday, '&consultant=Dr. Ann');
      expect(onlyAnn.body.data.totalFree).toBe(8); // 09:00-13:00
      const skinOnly = await slots(monday, '&category=skin');
      expect(skinOnly.body.data.slotConsultants.every((n: string[]) => n.length === 1 && n[0] === 'Bob Brown')).toBe(true);
      // On a Thursday Ann does not work: nothing for her, Bob still works
      expect((await slots(thursday, '&consultant=Ann')).body.data.totalFree).toBe(0);
      expect((await slots(thursday, '&category=Dentist')).body.data.totalFree).toBe(16);
    });

    it('says plainly when a name or service cannot be found, and offers no times', async () => {
      const res = await slots(monday, '&consultant=Zed');
      expect(res.body.data.availableSlotsIso).toEqual([]);
      expect(res.body.data.responseText).toMatch(/could not find a consultant called "Zed"/);
      expect((await slots(monday, '&category=Plumbing')).body.data.responseText).toMatch(/could not find a service called "Plumbing"/);
    });
  });

  describe('booking', () => {
    it('"anyone" spreads the work, a retry does not book twice, and a full time is refused', async () => {
      const first = await book(`${monday}T10:00:00`, { categoryId: dentist }, '555-0001');
      expect(first.status).toBe(201);
      expect(first.body.data.consultant.fullName).toBe('Ann Adams'); // tie on load: by name
      const retry = await book(`${monday}T10:00:00`, { categoryId: dentist }, '555-0001');
      expect(retry.body.data.id).toBe(first.body.data.id);

      const second = await book(`${monday}T10:00:00`, { categoryId: dentist }, '555-0002');
      expect(second.body.data.consultant.fullName).toBe('Bob Brown'); // Ann is taken at 10:00
      const third = await book(`${monday}T10:00:00`, { categoryId: dentist }, '555-0003');
      expect(third.status).toBe(400);
      expect(third.body.message).toMatch(/already booked/);
    });

    it('the same time with two consultants is two valid bookings, and each stores who and what', async () => {
      const rows = await prisma.appointment.findMany({ where: { tenantId, status: 'SCHEDULED' }, orderBy: { customerPhone: 'asc' } });
      expect(rows.map((r) => r.employeeId)).toEqual([ann, bob]);
      expect(rows.every((r) => r.categoryId === dentist)).toBe(true);
      const list = (await api('get', `/api/v1/appointments?date=${monday}`)).body.data;
      expect(list.map((a: { employee: { fullName: string } }) => a.employee.fullName).sort()).toEqual(['Ann Adams', 'Bob Brown']);
    });

    it('a named consultant who is not working, or does not offer the service, is refused with the reason', async () => {
      const afternoon = await book(`${monday}T15:00:00`, { employeeId: ann });
      expect(afternoon.status).toBe(400);
      expect(afternoon.body.message).toMatch(/Ann Adams is not working at that time/);
      const wrongService = await book(`${monday}T11:00:00`, { employeeId: ann, categoryId: skin });
      expect(wrongService.body.message).toMatch(/does not offer that service/);
    });

    it('a day off removes the consultant from free times and from booking, and can be removed again', async () => {
      const off = await api('post', `/api/v1/admin/employees/${bob}/time-off`).send({ startDate: thursday, endDate: thursday, note: 'Holiday' });
      expect(off.status).toBe(201);
      expect((await slots(thursday, '&category=Dentist')).body.data.totalFree).toBe(0); // Ann does not work Thursdays either
      expect((await book(`${thursday}T10:00:00`, { employeeId: bob })).status).toBe(400);
      expect((await api('delete', `/api/v1/admin/time-off/${off.body.data.id}`)).status).toBe(200);
      expect((await book(`${thursday}T10:00:00`, { employeeId: bob })).status).toBe(201);
    });

    it('cancelling frees that consultant\'s time again', async () => {
      const made = await book(`${monday}T12:00:00`, { employeeId: ann }, '555-0009');
      expect(made.status).toBe(201);
      expect((await book(`${monday}T12:00:00`, { employeeId: ann }, '555-0010')).status).toBe(400);
      expect((await api('delete', `/api/v1/appointments/${made.body.data.id}`)).status).toBe(200);
      expect((await book(`${monday}T12:00:00`, { employeeId: ann }, '555-0010')).status).toBe(201);
    });
  });

  describe('the voice agent', () => {
    it('lists the real consultants and services, and books with a named person', async () => {
      const list = toolResult(await webhook('listConsultants', {}));
      expect(list.categories).toEqual(['Dentist', 'Skin check']);
      expect(list.consultants.map((c: { name: string }) => c.name)).toEqual(['Ann Adams', 'Bob Brown']);

      const check = toolResult(await webhook('checkAvailability', { dateTime: `${monday}T14:00:00`, consultant: 'Bob' }));
      expect(check).toMatchObject({ available: true, consultants: ['Bob Brown'] });
      const unavailable = toolResult(await webhook('checkAvailability', { dateTime: `${monday}T14:00:00`, consultant: 'Ann' }));
      expect(unavailable.available).toBe(false);

      const booked = toolResult(await webhook('bookAppointment', { dateTime: `${monday}T14:00:00`, customerName: 'Vera Voice', customerPhone: '555-0042', consultant: 'Bob', category: 'Skin check' }));
      expect(booked.success).toBe(true);
      expect(booked.message).toMatch(/with Bob Brown on .*2:00 PM EST/);
    });
  });
});
