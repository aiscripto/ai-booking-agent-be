import { prisma } from '../src/services/db.service';
import { AuthError, AuthService } from '../src/services/auth.service';

describe('Creating dashboard users (SEC-012)', () => {
  const tenantA = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1401';
  const tenantB = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1402';
  const email = 'Create.User.Test@Example.test';
  const password = 'a long enough password 1';

  beforeAll(async () => {
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: `Create User Test ${id.slice(-2)}`, industry: 'HEALTHCARE' },
      });
    }
    await prisma.user.deleteMany({ where: { email: { equals: email, mode: 'insensitive' } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
  });

  it('creates a user with a hashed password who can then sign in (email is case-insensitive)', async () => {
    const result = await AuthService.createUser({ tenantId: tenantA, email, role: 'ADMIN', password, name: 'T' });
    expect(result.action).toBe('created');

    const row = await prisma.user.findUnique({ where: { id: result.user.id } });
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row?.passwordHash).not.toContain(password);

    const login = await AuthService.login(email.toUpperCase(), password);
    expect(login.user.id).toBe(result.user.id);
    expect(login.user.tenantId).toBe(tenantA);
  });

  it('refuses a duplicate unless a reset is asked for, and a reset changes the password', async () => {
    await expect(AuthService.createUser({ tenantId: tenantA, email, role: 'ADMIN', password })).rejects.toBeInstanceOf(AuthError);

    const newPassword = 'a different long password 2';
    const result = await AuthService.createUser({ tenantId: tenantA, email, role: 'ADMIN', password: newPassword, resetIfExists: true });
    expect(result.action).toBe('password-reset');

    await expect(AuthService.login(email, password)).rejects.toBeInstanceOf(AuthError);
    await expect(AuthService.login(email, newPassword)).resolves.toBeDefined();
  });

  it('will not take over an email that belongs to another tenant, even with reset', async () => {
    await expect(
      AuthService.createUser({ tenantId: tenantB, email, role: 'ADMIN', password, resetIfExists: true })
    ).rejects.toThrow(/another tenant/);
  });

  it('a plain username (not an email) can sign in, and a short password only with the explicit opt-in', async () => {
    const username = 'Test-Admin-User';
    await prisma.user.deleteMany({ where: { email: { equals: username, mode: 'insensitive' } } });

    // Strict by default: 4 characters is refused.
    await expect(AuthService.createUser({ tenantId: tenantA, email: username, role: 'ADMIN', password: '1234' })).rejects.toThrow(/at least 12/);
    // Opt-in: allowed from 4 characters, still not below.
    await expect(AuthService.createUser({ tenantId: tenantA, email: username, role: 'ADMIN', password: '123', allowWeakPassword: true })).rejects.toThrow(/at least 4/);
    const created = await AuthService.createUser({ tenantId: tenantA, email: username, role: 'ADMIN', password: '1234', allowWeakPassword: true });
    expect(created.action).toBe('created');

    const login = await AuthService.login('test-admin-user', '1234'); // case-insensitive
    expect(login.user.email).toBe('test-admin-user');
    expect(login.user.tenantId).toBe(tenantA);
    await expect(AuthService.login(username, '12345')).rejects.toBeInstanceOf(AuthError);
  });

  it('refuses a short password, a too-long password and an unknown tenant', async () => {
    await expect(AuthService.createUser({ tenantId: tenantA, email: 'short@example.test', role: 'ADMIN', password: 'short' })).rejects.toBeInstanceOf(AuthError);
    await expect(AuthService.createUser({ tenantId: tenantA, email: 'long@example.test', role: 'ADMIN', password: 'a'.repeat(73) })).rejects.toBeInstanceOf(AuthError);
    await expect(
      AuthService.createUser({ tenantId: '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1fffff', email: 'x@example.test', role: 'ADMIN', password })
    ).rejects.toThrow(/Tenant not found/);
  });
});
