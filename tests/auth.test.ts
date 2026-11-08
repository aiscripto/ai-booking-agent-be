import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../src/app';
import { config } from '../src/config';
import { prisma } from '../src/services/db.service';
import { AuthService } from '../src/services/auth.service';
import { createStaff, removeStaff, bearer, TestStaff } from './helpers/auth';

describe('Authentication and tenant isolation (SEC-012)', () => {
  const tenantA = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1301';
  const tenantB = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1302';
  let adminA: TestStaff;
  let frontDeskA: TestStaff;
  let patientA: TestStaff;
  let adminB: TestStaff;
  let resourceB: string;
  let ip = 0;
  const freshIp = () => `10.9.${Math.floor(++ip / 250)}.${ip % 250}`;

  beforeAll(async () => {
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: `Auth Test ${id.slice(-2)}`, industry: 'HEALTHCARE' },
      });
    }
    adminA = await createStaff(tenantA, 'ADMIN');
    frontDeskA = await createStaff(tenantA, 'FRONT_DESK');
    patientA = await createStaff(tenantA, 'PATIENT');
    adminB = await createStaff(tenantB, 'ADMIN');
    const r = await prisma.resource.create({ data: { tenantId: tenantB, name: 'Dr B', email: 'drb@example.test' } });
    resourceB = r.id;
    await prisma.callLog.createMany({
      data: [
        { tenantId: tenantA, status: 'completed', payload: {}, customerName: 'Visible To A' },
        { tenantId: tenantB, status: 'completed', payload: {}, customerName: 'Secret Of B' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.callLog.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.resource.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await removeStaff(adminA, frontDeskA, patientA, adminB);
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns a token and the user, never the password hash', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: adminA.email, password: adminA.password });

      expect(res.status).toBe(200);
      expect(typeof res.body.data.token).toBe('string');
      expect(res.body.data.user).toMatchObject({ email: adminA.email, role: 'ADMIN', tenantId: tenantA });
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('$2');
    });

    it('the token it returns works on a protected route', async () => {
      const login = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: adminA.email, password: adminA.password });
      const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.data.token}`);
      expect(me.status).toBe(200);
      expect(me.body.data.id).toBe(adminA.id);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: adminA.email, password: 'wrong password 123' });
      const unknownEmail = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: 'nobody@example.test', password: 'wrong password 123' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body).toEqual(unknownEmail.body);
    });

    it('refuses a deactivated user', async () => {
      const user = await createStaff(tenantA, 'ADMIN');
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: user.email, password: user.password });
      expect(res.status).toBe(401);
      await removeStaff(user);
    });

    it('returns 400 for a missing body, an empty username, and a password over 72 bytes', async () => {
      const ipAddr = freshIp();
      for (const body of [{}, { email: '   ', password: 'x' }, { email: adminA.email, password: 'a'.repeat(73) }]) {
        const res = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', ipAddr).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('rate limits repeated failures for one account and address (429 on the 6th)', async () => {
      const ipAddr = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await request(app)
          .post('/api/v1/auth/login')
          .set('X-Forwarded-For', ipAddr)
          .send({ email: adminA.email, password: 'wrong password 123' });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

      // The same address can still sign in as someone else (a shared office is not locked out).
      const other = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ipAddr)
        .send({ email: adminB.email, password: adminB.password });
      expect(other.status).toBe(200);
    });
  });

  describe('token checks', () => {
    const sign = (claims: object, secret: string, options: jwt.SignOptions = {}) =>
      jwt.sign(claims, secret, { algorithm: 'HS256', issuer: 'booking-agent', ...options });

    it('rejects no token, garbage, another secret, an expired token and an unsigned token', async () => {
      const good = { tid: tenantA };
      const tokens = [
        undefined,
        'garbage',
        sign(good, 'some-other-secret-that-is-long-enough-123456', { subject: adminA.id }),
        sign(good, config.JWT_SECRET, { subject: adminA.id, expiresIn: -10 }),
        jwt.sign(good, '', { algorithm: 'none', issuer: 'booking-agent', subject: adminA.id }),
        sign(good, config.JWT_SECRET, { subject: adminA.id, issuer: 'someone-else' }),
      ];
      for (const token of tokens) {
        const req = request(app).get('/api/v1/auth/me');
        const res = await (token ? req.set('Authorization', `Bearer ${token}`) : req);
        expect(res.status).toBe(401);
      }
    });

    it('rejects a token whose tenant does not match the user', async () => {
      const token = sign({ tid: tenantB }, config.JWT_SECRET, { subject: adminA.id });
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('stops working at once when the user is deactivated or their role changes', async () => {
      const user = await createStaff(tenantA, 'ADMIN');
      const before = await request(app).get('/api/v1/appointments/logs').set(bearer(user));
      expect(before.status).toBe(200);

      await prisma.user.update({ where: { id: user.id }, data: { role: 'PATIENT' } });
      const afterRole = await request(app).get('/api/v1/appointments/logs').set(bearer(user));
      expect(afterRole.status).toBe(403);

      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      const afterOff = await request(app).get('/api/v1/appointments/logs').set(bearer(user));
      expect(afterOff.status).toBe(401);
      await removeStaff(user);
    });
  });

  describe('protected routes', () => {
    const routes: Array<[string, string]> = [
      ['get', '/api/v1/appointments'],
      ['post', '/api/v1/appointments'],
      ['get', '/api/v1/appointments/logs'],
      ['get', '/api/v1/tenant/vocabulary'],
      ['get', '/api/v1/tenant/branding'],
      ['put', '/api/v1/tenant/branding'],
      ['post', '/api/v1/tenant/resources'],
      ['get', '/api/v1/auth/google'],
    ];

    it.each(routes)('%s %s returns 401 without a token, even with an x-tenant-id or tenant_id', async (method, path) => {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](`${path}?tenant_id=${tenantA}`)
        .set('x-tenant-id', tenantA);
      expect(res.status).toBe(401);
    });

    it('a patient account cannot use the dashboard (403)', async () => {
      const res = await request(app).get('/api/v1/appointments/logs').set(bearer(patientA));
      expect(res.status).toBe(403);
    });

    it('front desk can read but cannot change the tenant or connect Google (403)', async () => {
      expect((await request(app).get('/api/v1/tenant/branding').set(bearer(frontDeskA))).status).toBe(200);
      expect((await request(app).put('/api/v1/tenant/branding').set(bearer(frontDeskA)).send({ industry: 'FITNESS' })).status).toBe(403);
      expect((await request(app).post('/api/v1/tenant/resources').set(bearer(frontDeskA)).send({ name: 'x', email: 'x@example.test' })).status).toBe(403);
      expect((await request(app).get('/api/v1/auth/google').set(bearer(frontDeskA))).status).toBe(403);
    });

    it('the voice webhook and health stay reachable without a login token', async () => {
      expect((await request(app).get('/health')).status).toBe(200);
      // No API key: the webhook answers 401 from its own key check, not from the login middleware.
      const res = await request(app).post('/api/v1/voice/webhook?tenant_id=' + tenantA).send({});
      if (![200, 400, 401].includes(res.status)) {
        throw new Error(`Unexpected status ${res.status} from the voice webhook: ${JSON.stringify(res.body)}`);
      }
      expect(res.body.message ?? '').not.toBe('Authentication required.');
    });
  });

  describe('tenant isolation', () => {
    it('an x-tenant-id header or tenant_id query for another tenant is ignored', async () => {
      const res = await request(app)
        .get(`/api/v1/appointments/logs?tenant_id=${tenantB}`)
        .set(bearer(adminA))
        .set('x-tenant-id', tenantB);

      if (res.status !== 200 || !Array.isArray(res.body.data)) {
        throw new Error(`Unexpected answer ${res.status}: ${JSON.stringify(res.body)}`);
      }
      const names = res.body.data.map((l: { customerName: string }) => l.customerName);
      expect(names).toContain('Visible To A');
      expect(names).not.toContain('Secret Of B');
    });

    it('a body tenantId is ignored when changing branding', async () => {
      const res = await request(app)
        .put('/api/v1/tenant/branding')
        .set(bearer(adminA))
        .send({ tenantId: tenantB, branding: { color: 'red' } });
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(tenantA);
      const b = await prisma.tenant.findUnique({ where: { id: tenantB } });
      expect(JSON.stringify(b?.branding ?? null)).not.toContain('red');
    });

    it("an admin cannot offboard another tenant's provider (404, still active)", async () => {
      const res = await request(app).delete(`/api/v1/tenant/resources/${resourceB}`).set(bearer(adminA));
      expect(res.status).toBe(404);
      const r = await prisma.resource.findUnique({ where: { id: resourceB } });
      expect(r?.isActive).toBe(true);
    });

    it("an admin cannot onboard a provider into another tenant: the new provider lands in their own", async () => {
      const res = await request(app)
        .post('/api/v1/tenant/resources')
        .set(bearer(adminA))
        .send({ tenantId: tenantB, name: 'Dr Mine', email: 'mine@example.test' });
      expect(res.status).toBe(201);
      const r = await prisma.resource.findUnique({ where: { id: res.body.data.id } });
      expect(r?.tenantId).toBe(tenantA);
    });
  });

  describe('AuthService', () => {
    it('hashes passwords with bcrypt and never stores them in clear', async () => {
      const hash = await AuthService.hashPassword('some long password 123', 4);
      expect(hash).toMatch(/^\$2[aby]\$/);
      expect(hash).not.toContain('some long password');
    });
  });
});

describe('GET /api/v1/auth/google/status (Dashboard calendar status)', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1901';
  let staff: TestStaff;
  let patient: TestStaff;

  beforeAll(async () => {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: 'Google Status Test', industry: 'HEALTHCARE' } });
    staff = await createStaff(tenantId, 'FRONT_DESK');
    patient = await createStaff(tenantId, 'PATIENT');
    await prisma.googleCredential.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    await prisma.googleCredential.deleteMany({ where: { tenantId } });
    await removeStaff(staff, patient);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  it('needs a login, and not a patient account', async () => {
    expect((await request(app).get('/api/v1/auth/google/status')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/google/status').set(bearer(patient))).status).toBe(403);
  });

  it('says the tenant uses its own account only when a real refresh token is stored, and never returns a token', async () => {
    const before = await request(app).get('/api/v1/auth/google/status').set(bearer(staff));
    expect(before.status).toBe(200);
    expect(before.body.data.source).not.toBe('tenant');

    for (const refreshToken of ['', 'mock-refresh-token']) {
      await prisma.googleCredential.upsert({
        where: { tenantId },
        update: { refreshToken },
        create: { tenantId, accessToken: 'a', refreshToken, expiryDate: new Date(Date.now() + 3600_000) },
      });
      const res = await request(app).get('/api/v1/auth/google/status').set(bearer(staff));
      expect(res.body.data.source).not.toBe('tenant');
    }

    await prisma.googleCredential.update({ where: { tenantId }, data: { refreshToken: 'real-looking-refresh-token' } });
    const after = await request(app).get('/api/v1/auth/google/status').set(bearer(staff));
    expect(after.body.data.source).toBe('tenant');
    expect(JSON.stringify(after.body)).not.toContain('real-looking-refresh-token');
  });
});
