import { Prisma } from '@prisma/client';
import { prisma } from '../db.service';
import { AdminError } from './admin-error';
import type { EmployeeInput, TimeOffInput } from '../../schemas/admin.schema';

import { slotCacheService } from '../slot-cache.service';

const MAX_MANAGER_CHAIN = 100;

const include = {
  department: { select: { id: true, name: true } },
  grade: { select: { id: true, code: true } },
  role: { select: { id: true, name: true, code: true } },
  manager: { select: { id: true, fullName: true, code: true } },
  user: { select: { id: true, email: true } },
  categories: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
} as const;

export class EmployeeService {
  /** Every id the form sends must belong to the caller's own tenant. */
  private static async checkLinks(tenantId: string, input: EmployeeInput, selfId?: string): Promise<void> {
    const checks: Array<[string | null, () => Promise<number>, string]> = [
      [input.departmentId, () => prisma.department.count({ where: { id: input.departmentId ?? '', tenantId } }), 'Department'],
      [input.gradeId, () => prisma.grade.count({ where: { id: input.gradeId ?? '', tenantId } }), 'Grade'],
      [input.roleId, () => prisma.role.count({ where: { id: input.roleId ?? '', tenantId } }), 'Role'],
      [input.managerId, () => prisma.employee.count({ where: { id: input.managerId ?? '', tenantId } }), 'Manager'],
    ];
    for (const [id, count, label] of checks) {
      if (id && (await count()) !== 1) throw new AdminError(`${label} not found.`, 400);
    }
    if (input.categoryIds.length > 0) {
      const found = await prisma.serviceCategory.count({ where: { id: { in: input.categoryIds }, tenantId } });
      if (found !== input.categoryIds.length) throw new AdminError('Service category not found.', 400);
    }

    // A manager chain must never loop back to the employee.
    if (selfId && input.managerId) {
      if (input.managerId === selfId) throw new AdminError('An employee cannot be their own manager.', 400);
      let cursor: string | null = input.managerId;
      for (let i = 0; cursor && i < MAX_MANAGER_CHAIN; i += 1) {
        const up: { managerId: string | null } | null = await prisma.employee.findFirst({
          where: { id: cursor, tenantId },
          select: { managerId: true },
        });
        cursor = up?.managerId ?? null;
        if (cursor === selfId) throw new AdminError('That would make a loop of managers.', 400);
      }
    }
  }

  public static list(tenantId: string) {
    return prisma.employee.findMany({ where: { tenantId }, orderBy: { fullName: 'asc' }, take: 1000, include });
  }

  /** The system hands out the code: EMP-0001, EMP-0002, ... The counter and the insert are one transaction. */
  public static async create(tenantId: string, input: EmployeeInput) {
    await EmployeeService.checkLinks(tenantId, input);
    return prisma.$transaction(async (tx) => {
      const bumped = await tx.tenant.update({
        where: { id: tenantId },
        data: { employeeSeq: { increment: 1 } },
        select: { employeeSeq: true },
      });
      const code = `EMP-${String(bumped.employeeSeq).padStart(4, '0')}`;
      const { categoryIds, workingHours, ...rest } = input;
      return tx.employee.create({
        data: {
          ...rest,
          tenantId,
          code,
          workingHours: workingHours === null ? Prisma.DbNull : (workingHours as unknown as Prisma.InputJsonValue),
          categories: { connect: categoryIds.map((id) => ({ id })) },
        },
        include,
      });
    });
  }

  public static async update(tenantId: string, id: string, input: EmployeeInput) {
    await EmployeeService.checkLinks(tenantId, input, id);
    const { categoryIds, workingHours, ...rest } = input;
    const result = await prisma.employee.updateMany({
      where: { id, tenantId },
      data: { ...rest, workingHours: workingHours === null ? Prisma.DbNull : (workingHours as unknown as Prisma.InputJsonValue) },
    });
    if (result.count !== 1) throw new AdminError('Employee not found.', 404);
    // The employee is now known to belong to this tenant, and the categories were checked above.
    await prisma.employee.update({ where: { id }, data: { categories: { set: categoryIds.map((c) => ({ id: c })) } } });
    // Their times change, so times already worked out must not be served.
    slotCacheService.invalidate(`slots:${tenantId}:`);
    return prisma.employee.findFirst({ where: { id, tenantId }, include });
  }

  // ── Days off (whole days, in the business time zone) ────────────────────

  public static async listTimeOff(tenantId: string, employeeId: string) {
    return prisma.employeeTimeOff.findMany({ where: { tenantId, employeeId }, orderBy: { startDate: 'asc' }, take: 500 });
  }

  public static async addTimeOff(tenantId: string, employeeId: string, input: TimeOffInput) {
    if ((await prisma.employee.count({ where: { id: employeeId, tenantId } })) !== 1) throw new AdminError('Employee not found.', 404);
    const row = await prisma.employeeTimeOff.create({
      data: { tenantId, employeeId, startDate: new Date(`${input.startDate}T00:00:00Z`), endDate: new Date(`${input.endDate}T00:00:00Z`), note: input.note },
    });
    slotCacheService.invalidate(`slots:${tenantId}:`);
    return row;
  }

  public static async removeTimeOff(tenantId: string, id: string): Promise<void> {
    const result = await prisma.employeeTimeOff.deleteMany({ where: { id, tenantId } });
    if (result.count !== 1) throw new AdminError('Day off not found.', 404);
    slotCacheService.invalidate(`slots:${tenantId}:`);
  }
}
