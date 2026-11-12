import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import crypto from 'crypto';
import type { Server } from 'http';
import { prisma } from '../src/services/db.service';
import { createStaff, removeStaff, bearer, TestStaff } from './helpers/auth';
const app = require('../src/app').default || require('../src/app');

const api = '/api/v1/admin';
const weekdays = Array.from({ length: 7 }, (_, day) => (day >= 1 && day <= 5 ? [{ start: '09:00', end: '17:00' }] : []));
const when = { timeZone: 'America/New_York', businessHours: weekdays };

describe('Admin setup panel', () => {
  // One server for the whole file, so a request can never be answered by another test's throwaway server.
  let server: Server;
  let tenantA = '';
  let tenantB = '';
  let admin: TestStaff;
  let desk: TestStaff;
  let otherAdmin: TestStaff;

  const get = (path: string, who: TestStaff = admin) => request(server).get(`${api}${path}`).set(bearer(who));
  const post = (path: string, body: object, who: TestStaff = admin) => request(server).post(`${api}${path}`).set(bearer(who)).send(body);
  const put = (path: string, body: object, who: TestStaff = admin) => request(server).put(`${api}${path}`).set(bearer(who)).send(body);
  const del = (path: string, who: TestStaff = admin) => request(server).delete(`${api}${path}`).set(bearer(who));
  const roleList = async (who: TestStaff = admin) =>
    (await get('/roles', who)).body.data as Array<{ id: string; code: string; name: string; permissions: string[] }>;

  beforeAll(async () => {
    server = app.listen(0);
    // Own tenants, so no test touches real data. Deleting a tenant removes everything under it.
    tenantA = (await prisma.tenant.create({ data: { name: `Admin test A ${crypto.randomUUID()}` } })).id;
    tenantB = (await prisma.tenant.create({ data: { name: `Admin test B ${crypto.randomUUID()}` } })).id;
    admin = await createStaff(tenantA, 'ADMIN');
    desk = await createStaff(tenantA, 'FRONT_DESK');
    otherAdmin = await createStaff(tenantB, 'ADMIN');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await removeStaff(admin, desk, otherAdmin);
  });

  describe('who may use it', () => {
    it('refuses a request with no login (401) and a front-desk user (403)', async () => {
      expect((await request(server).get(`${api}/grades`)).status).toBe(401);
      expect((await get('/grades', desk)).status).toBe(403);
      expect((await get('/roles', desk)).status).toBe(403);
      expect((await get('/business', desk)).status).toBe(403);
      expect((await get('/grades')).status).toBe(200);
    });

    it('a changed role applies at once: removing a permission blocks the user', async () => {
      const frontDesk = (await roleList()).find((r) => r.code === 'FRONT_DESK')!;
      expect((await request(server).get('/api/v1/appointments').set(bearer(desk))).status).toBe(200);

      const without = frontDesk.permissions.filter((p) => p !== 'appointments.view');
      const saved = await put(`/roles/${frontDesk.id}`, { code: 'FRONT_DESK', name: frontDesk.name, permissions: without, isActive: true });
      expect(saved.status).toBe(200);
      expect((await request(server).get('/api/v1/appointments').set(bearer(desk))).status).toBe(403);

      await put(`/roles/${frontDesk.id}`, { code: 'FRONT_DESK', name: frontDesk.name, permissions: frontDesk.permissions, isActive: true });
      expect((await request(server).get('/api/v1/appointments').set(bearer(desk))).status).toBe(200);
    });

    it('lists only the fixed permission codes', async () => {
      const res = await get('/permissions');
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { code: string }) => p.code)).toContain('users.manage');
    });
  });

  describe('business', () => {
    it('saves details, and refuses half a map position or a bad email', async () => {
      const ok = await put('/business', { ...when, name: 'Test Clinic', phone: '555 0100', email: 'Info@Test.Example', city: 'Austin', state: 'TX', country: 'us', latitude: 30.27, longitude: -97.74 });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ name: 'Test Clinic', email: 'info@test.example', country: 'US', state: 'TX', latitude: 30.27, longitude: -97.74 });
      expect((await put('/business', { ...when, name: 'X', country: 'USA' })).status).toBe(400);
      expect((await put('/business', { ...when, name: 'X', latitude: 30 })).status).toBe(400);
      expect((await put('/business', { ...when, name: 'X', latitude: 95, longitude: 10 })).status).toBe(400);
      expect((await put('/business', { ...when, name: 'X', email: 'nope' })).status).toBe(400);
      expect((await put('/business', { ...when, name: '' })).status).toBe(400);
    });

    it('never changes another tenant', async () => {
      const other = await prisma.tenant.findFirst({ where: { id: tenantB }, select: { name: true } });
      expect(other?.name.startsWith('Admin test B')).toBe(true);
    });
  });

  describe('grades and departments', () => {
    it('creates, updates, rejects a duplicate code, and hides other tenants', async () => {
      const g = await post('/grades', { code: 'G15', name: 'Senior' });
      expect(g.status).toBe(201);
      expect((await post('/grades', { code: 'G15' })).status).toBe(409);
      expect((await post('/grades', { code: 'bad code' })).status).toBe(400);
      const upd = await put(`/grades/${g.body.data.id}`, { code: 'G15', name: 'Senior II', isActive: false });
      expect(upd.body.data).toMatchObject({ name: 'Senior II', isActive: false });
      expect((await get('/grades', otherAdmin)).body.data).toEqual([]);
      expect((await put(`/grades/${g.body.data.id}`, { code: 'X' }, otherAdmin)).status).toBe(404);
      expect((await del(`/grades/${g.body.data.id}`, otherAdmin)).status).toBe(404);
    });

    it('department keeps the location and contact, and cannot be deleted while people use it', async () => {
      const d = await post('/departments', { name: 'Radiology', description: 'Scans', location: 'Floor 2', contact: 'Ext 12', email: 'rad@test.example' });
      expect(d.status).toBe(201);
      expect(d.body.data).toMatchObject({ location: 'Floor 2', contact: 'Ext 12', email: 'rad@test.example' });
      expect((await post('/departments', { name: 'Radiology' })).status).toBe(409);
      const e = await post('/employees', { fullName: 'Rae Diology', departmentId: d.body.data.id });
      expect(e.status).toBe(201);
      expect((await del(`/departments/${d.body.data.id}`)).status).toBe(409);
      const list = (await get('/departments')).body.data as Array<{ id: string; employeeCount: number }>;
      expect(list.find((x) => x.id === d.body.data.id)?.employeeCount).toBe(1);
    });
  });

  describe('employees', () => {
    it('the system assigns the code and ignores one sent by the client', async () => {
      const a = await post('/employees', { fullName: 'First Person', code: 'HACK-1' });
      const b = await post('/employees', { fullName: 'Second Person' });
      expect(a.status).toBe(201);
      expect(a.body.data.code).toMatch(/^EMP-\d{4}$/);
      expect(Number(b.body.data.code.slice(4))).toBe(Number(a.body.data.code.slice(4)) + 1);
      // The other tenant starts its own count
      const c = await post('/employees', { fullName: 'Other Tenant Person' }, otherAdmin);
      expect(c.body.data.code).toBe('EMP-0001');
    });

    it('refuses a department, grade or manager that belongs to another tenant', async () => {
      const foreignDept = await post('/departments', { name: 'Foreign' }, otherAdmin);
      const foreignGrade = await post('/grades', { code: 'F1' }, otherAdmin);
      expect((await post('/employees', { fullName: 'X', departmentId: foreignDept.body.data.id })).status).toBe(400);
      expect((await post('/employees', { fullName: 'X', gradeId: foreignGrade.body.data.id })).status).toBe(400);
      expect((await post('/employees', { fullName: 'X', managerId: crypto.randomUUID() })).status).toBe(400);
    });

    it('refuses a manager loop and a person managing themselves', async () => {
      const boss = (await post('/employees', { fullName: 'Boss' })).body.data;
      const worker = (await post('/employees', { fullName: 'Worker', managerId: boss.id })).body.data;
      expect((await put(`/employees/${boss.id}`, { fullName: 'Boss', managerId: worker.id })).status).toBe(400);
      expect((await put(`/employees/${boss.id}`, { fullName: 'Boss', managerId: boss.id })).status).toBe(400);
      expect((await put(`/employees/${worker.id}`, { fullName: 'Worker', managerId: boss.id })).status).toBe(200);
    });
  });

  describe('roles', () => {
    it('lists the four built-in roles; Admin cannot lose permissions or be turned off', async () => {
      const roles = await roleList();
      expect(roles.slice(0, 4).map((r) => r.code)).toEqual(['ADMIN', 'FRONT_DESK', 'PROVIDER', 'PATIENT']);
      const adminRole = roles.find((r) => r.code === 'ADMIN')!;
      // An Admin row made before newer permissions existed is shown, and stored, with every permission
      await prisma.role.updateMany({ where: { tenantId: tenantA, code: 'ADMIN' }, data: { permissions: ['dashboard.view'] } });
      const refreshed = ((await get('/roles')).body.data as Array<{ code: string; permissions: string[] }>).find((r) => r.code === 'ADMIN')!;
      expect(refreshed.permissions).toContain('audit.view');
      expect(refreshed.permissions).not.toContain('appointments.own_only');
      const shrunk = await put(`/roles/${adminRole.id}`, { code: 'ADMIN', name: 'Admin', permissions: ['dashboard.view'], isActive: true });
      expect(shrunk.body.data.permissions.length).toBe(adminRole.permissions.length);
      expect((await put(`/roles/${adminRole.id}`, { code: 'ADMIN', name: 'Admin', permissions: [], isActive: false })).status).toBe(400);
      expect((await del(`/roles/${adminRole.id}`)).status).toBe(400);
      expect((await put(`/roles/${adminRole.id}`, { code: 'OWNER', name: 'Admin', permissions: [], isActive: true })).status).toBe(400);
    });

    it('creates a custom role, rejects reserved codes and unknown permissions, and blocks deleting a used role', async () => {
      expect((await post('/roles', { code: 'ADMIN', name: 'x', permissions: [] })).status).toBe(409);
      expect((await post('/roles', { code: 'AUDITOR', name: 'Auditor', permissions: ['not.real'] })).status).toBe(400);
      const r = await post('/roles', { code: 'auditor', name: 'Auditor', description: 'Reads', permissions: ['dashboard.view', 'calls.view', 'calls.view'] });
      expect(r.status).toBe(201);
      expect(r.body.data.code).toBe('AUDITOR');
      expect(r.body.data.permissions).toEqual(['dashboard.view', 'calls.view']);
      expect((await post('/roles', { code: 'AUDITOR', name: 'Again', permissions: [] })).status).toBe(409);

      const u = await post('/users', { username: 'audit.user', password: 'a long enough password', roleId: r.body.data.id });
      expect(u.status).toBe(201);
      expect((await del(`/roles/${r.body.data.id}`)).status).toBe(409);
      expect((await put(`/roles/${r.body.data.id}`, { code: 'AUDITOR', name: 'Auditor', permissions: [], isActive: false })).status).toBe(409);
    });
  });

  describe('user accounts', () => {
    const login = (username: string, password: string) => request(server).post('/api/v1/auth/login').send({ email: username, password });

    it("creates a login that works, never returns the password, and gives only the role's permissions", async () => {
      const auditor = (await roleList()).find((r) => r.code === 'AUDITOR')!;
      const made = await post('/users', { username: 'Reader.One', password: 'another long password', roleId: auditor.id, name: 'Reader One' });
      expect(made.status).toBe(201);
      expect(JSON.stringify(made.body)).not.toMatch(/password|hash/i);
      expect(made.body.data.username).toBe('reader.one');

      const session = await login('reader.one', 'another long password');
      expect(session.status).toBe(200);
      expect(session.body.data.user.permissions).toEqual(['dashboard.view', 'calls.view']);
      const token = { Authorization: `Bearer ${session.body.data.token}` };
      expect((await request(server).get('/api/v1/appointments/logs').set(token)).status).toBe(200);
      expect((await request(server).get('/api/v1/appointments').set(token)).status).toBe(403);
      expect((await request(server).get(`${api}/users`).set(token)).status).toBe(403);
    });

    it('refuses a short password, a bad name and a taken name (also across tenants)', async () => {
      const roleId = (await roleList()).find((r) => r.code === 'FRONT_DESK')!.id;
      expect((await post('/users', { username: 'shorty', password: '1234', roleId })).status).toBe(400);
      expect((await post('/users', { username: 'has space', password: 'a long enough password', roleId })).status).toBe(400);
      expect((await post('/users', { username: 'reader.one', password: 'a long enough password', roleId })).status).toBe(409);
      const bRoles = await roleList(otherAdmin);
      const taken = await post('/users', { username: 'reader.one', password: 'a long enough password', roleId: bRoles[0].id }, otherAdmin);
      expect(taken.status).toBe(409);
      // A role from another tenant is refused
      expect((await post('/users', { username: 'cross.role', password: 'a long enough password', roleId: bRoles[0].id })).status).toBe(400);
    });

    it('a deactivated user cannot sign in, and a password reset replaces the old password', async () => {
      const roleId = (await roleList()).find((r) => r.code === 'FRONT_DESK')!.id;
      const u = (await post('/users', { username: 'temp.user', password: 'first long password', roleId })).body.data;
      expect((await login('temp.user', 'first long password')).status).toBe(200);

      expect((await put(`/users/${u.id}`, { password: 'second long password', roleId, isActive: true })).status).toBe(200);
      expect((await login('temp.user', 'first long password')).status).toBe(401);
      expect((await login('temp.user', 'second long password')).status).toBe(200);

      expect((await put(`/users/${u.id}`, { roleId, isActive: false })).status).toBe(200);
      expect((await login('temp.user', 'second long password')).status).toBe(401);
    });

    it('links an employee only once, and protects against lock-out', async () => {
      const roles = await roleList();
      const deskRole = roles.find((r) => r.code === 'FRONT_DESK')!.id;
      const adminRole = roles.find((r) => r.code === 'ADMIN')!.id;
      const emp = (await post('/employees', { fullName: 'Linked Person' })).body.data;
      const first = await post('/users', { username: 'linked.one', password: 'a long enough password', roleId: deskRole, employeeId: emp.id });
      expect(first.status).toBe(201);
      expect(first.body.data.employee.code).toBe(emp.code);
      expect((await post('/users', { username: 'linked.two', password: 'a long enough password', roleId: deskRole, employeeId: emp.id })).status).toBe(409);

      // The signed-in admin cannot switch themselves off or demote themselves
      expect((await put(`/users/${admin.id}`, { roleId: adminRole, isActive: false })).status).toBe(409);
      expect((await put(`/users/${admin.id}`, { roleId: deskRole, isActive: true })).status).toBe(409);

      // A second admin may demote the first; then the second is the last manager and cannot demote themselves
      const second = await post('/users', { username: 'second.admin', password: 'a long enough password', roleId: adminRole });
      expect(second.status).toBe(201);
      const secondLogin = await login('second.admin', 'a long enough password');
      const secondToken = { Authorization: `Bearer ${secondLogin.body.data.token}` };
      const demoted = await request(server).put(`${api}/users/${admin.id}`).set(secondToken).send({ roleId: deskRole, isActive: true });
      expect(demoted.status).toBe(200);
      const lastOne = await request(server).put(`${api}/users/${second.body.data.id}`).set(secondToken).send({ roleId: deskRole, isActive: true });
      expect(lastOne.status).toBe(409);
    });
  });
});
