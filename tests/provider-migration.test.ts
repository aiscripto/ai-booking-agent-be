import crypto from 'crypto';
import { prisma } from '../src/services/db.service';
import { migrateProvidersToEmployees } from '../src/services/admin/provider-migration.service';

describe('Copying providers into employees', () => {
  let tenantId = '';

  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: `Migration test ${crypto.randomUUID()}` } })).id;
    const dept = await prisma.department.create({ data: { tenantId, name: 'Eyes' } });
    await prisma.resource.createMany({
      data: [
        { tenantId, name: 'Dr Eve', email: 'eve@example.test', title: 'optometrist', departmentId: dept.id },
        { tenantId, name: 'Dr Old', email: 'old@example.test', isActive: false },
      ],
    });
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  it('a dry run changes nothing', async () => {
    const result = await migrateProvidersToEmployees(tenantId, false);
    expect(result.created).toHaveLength(2);
    expect(await prisma.employee.count({ where: { tenantId } })).toBe(0);
  });

  it('copies each provider once as a consultant, keeps the old rows, and repeating does nothing', async () => {
    const first = await migrateProvidersToEmployees(tenantId, true);
    expect(first.created.map((c) => c.fullName)).toEqual(['Dr Eve', 'Dr Old']);
    expect(first.created.map((c) => c.code)).toEqual(['EMP-0001', 'EMP-0002']);

    const eve = await prisma.employee.findFirst({ where: { tenantId, fullName: 'Dr Eve' } });
    expect(eve).toMatchObject({ isBookable: true, title: 'optometrist', email: 'eve@example.test', isActive: true });
    expect(eve?.departmentId).not.toBeNull();
    expect((await prisma.employee.findFirst({ where: { tenantId, fullName: 'Dr Old' } }))?.isActive).toBe(false);
    expect(await prisma.resource.count({ where: { tenantId } })).toBe(2);

    const again = await migrateProvidersToEmployees(tenantId, true);
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toHaveLength(2);
    expect(await prisma.employee.count({ where: { tenantId } })).toBe(2);
  });
});
