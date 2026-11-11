import { prisma } from '../db.service';

/**
 * One-time copy of the old "providers" (Resource rows) into Employees who take appointments (consultants).
 * Safe to repeat: a provider whose email already belongs to an employee of the same business is skipped.
 * The Resource rows are NOT deleted or changed. Used by src/scripts/migrate-providers.ts.
 */

export interface ProviderMigrationResult {
  created: Array<{ code: string; fullName: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

export async function migrateProvidersToEmployees(tenantId: string, apply: boolean): Promise<ProviderMigrationResult> {
  const result: ProviderMigrationResult = { created: [], skipped: [] };
  const resources = await prisma.resource.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, take: 1000 });

  for (const r of resources) {
    const existing = await prisma.employee.count({ where: { tenantId, email: { equals: r.email, mode: 'insensitive' } } });
    if (existing > 0) {
      result.skipped.push({ name: r.name, reason: 'an employee with this email already exists' });
      continue;
    }
    if (!apply) {
      result.created.push({ code: '(assigned on apply)', fullName: r.name });
      continue;
    }
    const employee = await prisma.$transaction(async (tx) => {
      const bumped = await tx.tenant.update({ where: { id: tenantId }, data: { employeeSeq: { increment: 1 } }, select: { employeeSeq: true } });
      return tx.employee.create({
        data: {
          tenantId,
          code: `EMP-${String(bumped.employeeSeq).padStart(4, '0')}`,
          fullName: r.name,
          email: r.email,
          title: r.title,
          departmentId: r.departmentId,
          isBookable: true,
          isActive: r.isActive,
        },
      });
    });
    result.created.push({ code: employee.code, fullName: employee.fullName });
  }
  return result;
}
