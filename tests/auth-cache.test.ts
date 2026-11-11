import { AuthCache } from '../src/services/auth-cache';
import { AuthContext, AuthService, authCache } from '../src/services/auth.service';
import { prisma } from '../src/services/db.service';
import { createStaff, removeStaff, TestStaff } from './helpers/auth';

const ctx = (userId: string, tenantId = 't1', role: AuthContext['role'] = 'ADMIN'): AuthContext => ({ userId, tenantId, role, permissions: [] });

describe('AuthCache (short memory of active users)', () => {
  it('returns a stored user until the time is up, then forgets', () => {
    let now = 1_000;
    const cache = new AuthCache(10, () => now);
    cache.set(ctx('u1'));
    expect(cache.get('u1', 't1')).toEqual(ctx('u1'));
    now += 9_999;
    expect(cache.get('u1', 't1')).not.toBeNull();
    now += 2;
    expect(cache.get('u1', 't1')).toBeNull();
  });

  it('does not share entries between tenants or users', () => {
    const cache = new AuthCache(10);
    cache.set(ctx('u1', 'tenantA'));
    expect(cache.get('u1', 'tenantB')).toBeNull();
    expect(cache.get('u2', 'tenantA')).toBeNull();
  });

  it('is switched off by 0 seconds', () => {
    const cache = new AuthCache(0);
    cache.set(ctx('u1'));
    expect(cache.get('u1', 't1')).toBeNull();
  });

  it('forgets one user on request, and clears everything', () => {
    const cache = new AuthCache(10);
    cache.set(ctx('u1', 'a'));
    cache.set(ctx('u1', 'b'));
    cache.set(ctx('u2', 'a'));
    cache.invalidateUser('u1');
    expect(cache.get('u1', 'a')).toBeNull();
    expect(cache.get('u1', 'b')).toBeNull();
    expect(cache.get('u2', 'a')).not.toBeNull();
    cache.clear();
    expect(cache.get('u2', 'a')).toBeNull();
  });
});

describe('Token check with the memory turned on', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1601';
  let staff: TestStaff;

  beforeAll(async () => {
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Auth Cache Test', industry: 'HEALTHCARE' },
    });
    staff = await createStaff(tenantId, 'ADMIN');
    authCache.setTtlSeconds(10);
  });

  afterAll(async () => {
    authCache.setTtlSeconds(0); // back to off for any other code in this process
    await removeStaff(staff);
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  it('asks the database once, then answers the next requests from memory', async () => {
    authCache.clear();
    const spy = jest.spyOn(prisma.user, 'findFirst');

    const first = await AuthService.authenticate(staff.token);
    const second = await AuthService.authenticate(staff.token);
    const third = await AuthService.authenticate(staff.token);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the trade-off: a deactivated user still passes until the memory is cleared or expires', async () => {
    authCache.clear();
    await AuthService.authenticate(staff.token); // remembered
    await prisma.user.update({ where: { id: staff.id }, data: { isActive: false } });

    expect(await AuthService.authenticate(staff.token)).not.toBeNull(); // within the 10 seconds

    authCache.clear(); // what happens when the time is up
    expect(await AuthService.authenticate(staff.token)).toBeNull();

    await prisma.user.update({ where: { id: staff.id }, data: { isActive: true } });
  });

  it('never remembers a failure, so a reactivated user can sign in at once', async () => {
    authCache.clear();
    await prisma.user.update({ where: { id: staff.id }, data: { isActive: false } });
    expect(await AuthService.authenticate(staff.token)).toBeNull();

    await prisma.user.update({ where: { id: staff.id }, data: { isActive: true } });
    expect(await AuthService.authenticate(staff.token)).not.toBeNull();
  });

  it('signing out clears the memory for that user straight away', async () => {
    authCache.clear();
    const login = await AuthService.login(staff.email, staff.password);
    await AuthService.authenticate(login.token); // remembered

    await AuthService.revokeSessions(login.refreshToken);

    const spy = jest.spyOn(prisma.user, 'findFirst');
    await AuthService.authenticate(login.token);
    expect(spy).toHaveBeenCalledTimes(1); // asked the database again, not the memory
  });
});
