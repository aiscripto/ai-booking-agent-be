import request from 'supertest';
import { config } from '../src/config';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';
import { TenantScheduleService } from '../src/services/tenant-schedule.service';
import { bearer, createStaff, removeStaff, TestStaff } from './helpers/auth';
import { bookableSlot } from './helpers/time';

jest.mock('../src/services/google-calendar.service', () => ({
  GoogleCalendarService: { checkAvailability: jest.fn(), createEvent: jest.fn(), deleteEvent: jest.fn(), getBusyIntervals: jest.fn() },
}));

// A consultant signs in and sees, cancels and is logged for only their own appointments; admins read the audit log.
describe('Consultant logins and the audit log', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1d01';
  const otherTenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1d02';
  const password = 'a long enough password';
  let admin: TestStaff;
  let desk: TestStaff;
  let otherAdmin: TestStaff;
  let annId = '';
  let bobId = '';
  let apptAnn = '';
  let apptBob = '';
  let tokenAnn = '';
  let tokenBob = '';
  let tokenLoose = '';

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, token: string) => request(app)[method](path).set(as(token));
  const adminApi = (method: 'get' | 'post' | 'put' | 'delete', path: string) => request(app)[method](path).set(bearer(admin));
  const login = (username: string, pass = password) => request(app).post('/api/v1/auth/login').send({ email: username, password: pass });

  /** The audit entry is written just after the answer is sent, so wait a moment for it. */
  async function auditEntries(query = '', who: TestStaff = admin): Promise<Array<{ action: string; actorName: string; summary: string; details: Record<string, unknown> | null; entityId: string | null }>> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return (await request(app).get(`/api/v1/admin/audit?limit=200${query}`).set(bearer(who))).body.data.entries;
  }

  beforeAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: 'Audit Test', industry: 'HEALTHCARE' } });
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
    await removeStaff(admin, desk, otherAdmin);
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });

  it('sets up two consultants, a Consultant role, and one login each (plus one login not linked to anyone)', async () => {
    const roles = (await adminApi('get', '/api/v1/admin/roles')).body.data as Array<{ id: string; code: string; permissions: string[] }>;
    const consultantRole = roles.find((r) => r.code === 'CONSULTANT')!;
    const adminRole = roles.find((r) => r.code === 'ADMIN')!;
    expect(consultantRole.permissions).toEqual(['dashboard.view', 'appointments.view', 'appointments.cancel', 'appointments.own_only']);
    // The Admin role is never limited to "own appointments"
    expect(adminRole.permissions).not.toContain('appointments.own_only');
    expect(adminRole.permissions).toContain('audit.view');

    annId = (await adminApi('post', '/api/v1/admin/employees').send({ fullName: 'Ann Adams', isBookable: true })).body.data.id;
    bobId = (await adminApi('post', '/api/v1/admin/employees').send({ fullName: 'Bob Brown', isBookable: true })).body.data.id;
    for (const [username, employeeId] of [['ann.adams', annId], ['bob.brown', bobId], ['loose.login', null]] as const) {
      const made = await adminApi('post', '/api/v1/admin/users').send({ username, password, roleId: consultantRole.id, employeeId });
      expect(made.status).toBe(201);
    }
    tokenAnn = (await login('ann.adams')).body.data.token;
    tokenBob = (await login('bob.brown')).body.data.token;
    tokenLoose = (await login('loose.login')).body.data.token;

    const when = bookableSlot();
    apptAnn = (await adminApi('post', '/api/v1/appointments').send({ dateTime: when.toISOString(), customerName: 'Cora Customer', customerPhone: '555-0001', employeeId: annId })).body.data.id;
    apptBob = (await adminApi('post', '/api/v1/appointments').send({ dateTime: when.toISOString(), customerName: 'Dan Customer', customerPhone: '555-0002', employeeId: bobId })).body.data.id;
    expect(apptAnn && apptBob).toBeTruthy();
  });

  describe('a consultant sees and cancels only their own appointments', () => {
    it('lists only their own; an admin lists everyone; an unlinked login sees nothing', async () => {
      const mine = (await api('get', '/api/v1/appointments', tokenAnn)).body.data as Array<{ id: string; customerName: string }>;
      expect(mine.map((a) => a.customerName)).toEqual(['Cora Customer']);
      expect((await api('get', '/api/v1/appointments', tokenBob, )).body.data.map((a: { customerName: string }) => a.customerName)).toEqual(['Dan Customer']);
      expect((await adminApi('get', '/api/v1/appointments')).body.data).toHaveLength(2);
      expect((await api('get', '/api/v1/appointments', tokenLoose)).body.data).toEqual([]);
    });

    it('cannot cancel someone else\'s appointment, can cancel their own, and an unlinked login cannot cancel any', async () => {
      const other = await api('delete', `/api/v1/appointments/${apptBob}`, tokenAnn);
      expect(other.status).toBe(400);
      expect(other.body.message).toMatch(/not found or unauthorized/);
      expect((await prisma.appointment.findFirst({ where: { id: apptBob } }))?.status).toBe('SCHEDULED');
      expect((await api('delete', `/api/v1/appointments/${apptBob}`, tokenLoose)).status).toBe(403);

      expect((await api('delete', `/api/v1/appointments/${apptAnn}`, tokenAnn)).status).toBe(200);
      expect((await prisma.appointment.findFirst({ where: { id: apptAnn } }))?.status).toBe('CANCELLED');
    });

    it('has no other rights: no booking, no call logs, no setup, no audit log', async () => {
      const body = { dateTime: bookableSlot().toISOString(), customerName: 'X', customerPhone: '555-0009' };
      expect((await api('post', '/api/v1/appointments', tokenAnn).send(body)).status).toBe(403);
      expect((await api('get', '/api/v1/appointments/logs', tokenAnn)).status).toBe(403);
      expect((await api('get', '/api/v1/admin/users', tokenAnn)).status).toBe(403);
      expect((await api('get', '/api/v1/admin/audit', tokenAnn)).status).toBe(403);
      expect((await api('get', '/api/v1/tenant/consultants', tokenAnn)).status).toBe(200);
    });

    it('if the role also allows booking, a consultant can only book for themselves', async () => {
      const roles = (await adminApi('get', '/api/v1/admin/roles')).body.data as Array<{ id: string; code: string; name: string; permissions: string[]; isActive: boolean }>;
      const role = roles.find((r) => r.code === 'CONSULTANT')!;
      await adminApi('put', `/api/v1/admin/roles/${role.id}`).send({ code: 'CONSULTANT', name: role.name, permissions: [...role.permissions, 'appointments.create'], isActive: true });
      const res = await api('post', '/api/v1/appointments', tokenAnn).send({ dateTime: bookableSlot().toISOString(), customerName: 'Eve Customer', customerPhone: '555-0003', employeeId: bobId });
      expect(res.status).toBe(201);
      expect(res.body.data.employeeId).toBe(annId); // not Bob, whatever the request said
      await adminApi('put', `/api/v1/admin/roles/${role.id}`).send({ code: 'CONSULTANT', name: role.name, permissions: role.permissions, isActive: true });
    });
  });

  describe('the audit log', () => {
    it('records sign-ins, wrong passwords for a real user, and a consultant\'s every read and change', async () => {
      await login('ann.adams', 'the wrong password'); // a wrong password for a real user
      await login('nobody.here', 'the wrong password'); // an unknown name: no business to record it in
      const entries = await auditEntries();
      const ann = entries.filter((e) => e.actorName === 'ann.adams');

      expect(ann.some((e) => e.action === 'auth.login' && e.summary === 'Signed in')).toBe(true);
      expect(ann.some((e) => e.action === 'auth.login_failed')).toBe(true);
      expect(entries.some((e) => e.actorName === 'nobody.here')).toBe(false);
      // Reads by a consultant are logged...
      expect(ann.some((e) => e.action === 'GET /api/v1/appointments')).toBe(true);
      // ...and so is the cancellation, with who, what and when
      const cancel = ann.find((e) => e.action === 'DELETE /api/v1/appointments/:id' && e.entityId === apptAnn)!;
      expect(cancel.summary).toMatch(/^Cancelled the appointment of Cora Customer on /);
      expect(cancel.details).toMatchObject({ status: 200, customerName: 'Cora Customer' });
      // ...and so is a refused attempt
      expect(ann.some((e) => e.action === 'GET /api/v1/admin/users' && (e.details as { status: number }).status === 403)).toBe(true);
    });

    it('records an admin\'s changes with a plain sentence, never a password, and does not log an admin\'s reads', async () => {
      const entries = await auditEntries();
      const created = entries.find((e) => e.action === 'POST /api/v1/admin/users' && e.actorName !== 'ann.adams')!;
      expect(created.summary).toBe('Created a user account');
      expect(JSON.stringify(created.details)).not.toContain(password);
      expect(JSON.stringify(created.details)).toContain('[hidden]');
      expect(entries.some((e) => e.action === 'GET /api/v1/admin/roles')).toBe(false);
      expect(entries.some((e) => e.action === 'POST /api/v1/appointments' && /^Booked Cora Customer/.test(e.summary))).toBe(true);
    });

    it('always logs the opening of a call transcript, for any user', async () => {
      const log = await prisma.callLog.create({ data: { tenantId, status: 'completed', transcript: 'private words', payload: {}, customerName: 'Tess Transcript' } });
      expect((await request(app).get(`/api/v1/appointments/logs/${log.id}`).set(bearer(desk))).status).toBe(200);
      const entry = (await auditEntries()).find((e) => e.action === 'GET /api/v1/appointments/logs/:id' && e.entityId === log.id)!;
      expect(entry.summary).toBe('Opened a call transcript');
      expect(JSON.stringify(entry.details)).not.toContain('private words'); // the words themselves are not copied into the log
    });

    it('records the voice agent as the actor', async () => {
      await prisma.appointment.deleteMany({ where: { tenantId } });
      const res = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=primary`)
        .set('x-api-key', config.WEBHOOK_API_KEY)
        .send({ name: 'bookAppointment', args: { dateTime: bookableSlot().toISOString(), customerName: 'Vera Voice', customerPhone: '555-0077', consultant: 'Bob' }, call: { call_id: 'c' } });
      expect(res.body.success).toBe(true);
      const entry = (await auditEntries()).find((e) => e.action === 'voice.bookAppointment')!;
      expect(entry.actorName).toBe('Voice agent');
      expect(entry.summary).toMatch(/^Voice agent booked Vera Voice on .* with Bob Brown$/);
    });

    it('only people allowed to read it can; it filters, pages, is newest first, and stays inside its own business', async () => {
      expect((await request(app).get('/api/v1/admin/audit').set(bearer(desk))).status).toBe(403);
      const all = await auditEntries();
      expect(all.length).toBeGreaterThan(5);
      // Newest first
      const stamps = ((await request(app).get('/api/v1/admin/audit?limit=200').set(bearer(admin))).body.data.entries as Array<{ createdAt: string }>).map((e) => Date.parse(e.createdAt));
      expect(stamps).toEqual([...stamps].sort((a, b) => b - a));

      const onlyAnn = await auditEntries('&q=ann.adams');
      expect(onlyAnn.length).toBeGreaterThan(0);
      expect(onlyAnn.every((e) => e.actorName === 'ann.adams' || /ann\.adams|Ann/i.test(e.summary + e.action))).toBe(true);

      const page1 = (await request(app).get('/api/v1/admin/audit?limit=3').set(bearer(admin))).body.data;
      expect(page1.entries).toHaveLength(3);
      const page2 = (await request(app).get(`/api/v1/admin/audit?limit=3&cursor=${page1.nextCursor}`).set(bearer(admin))).body.data;
      expect(page2.entries.map((e: { id: string }) => e.id)).not.toEqual(expect.arrayContaining(page1.entries.map((e: { id: string }) => e.id)));

      expect((await request(app).get('/api/v1/admin/audit').set(bearer(otherAdmin))).body.data.entries).toHaveLength(0);
    });

    it('cannot be changed or deleted through the app', async () => {
      const first = (await request(app).get('/api/v1/admin/audit?limit=1').set(bearer(admin))).body.data.entries[0];
      expect((await request(app).delete(`/api/v1/admin/audit/${first.id}`).set(bearer(admin))).status).toBe(404);
      expect((await request(app).put(`/api/v1/admin/audit/${first.id}`).set(bearer(admin)).send({ summary: 'changed' })).status).toBe(404);
      expect(await prisma.auditLog.count({ where: { id: first.id } })).toBe(1);
    });
  });
});
