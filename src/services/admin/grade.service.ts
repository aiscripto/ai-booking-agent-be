import { prisma } from '../db.service';
import { AdminError, isDuplicate } from './admin-error';
import type { GradeInput } from '../../schemas/admin.schema';

const DUPLICATE = 'A grade with this code already exists.';

export class GradeService {
  public static async list(tenantId: string) {
    const rows = await prisma.grade.findMany({
      where: { tenantId },
      orderBy: { code: 'asc' },
      take: 1000,
      include: { _count: { select: { employees: true } } },
    });
    return rows.map(({ _count, ...g }) => ({ ...g, employeeCount: _count.employees }));
  }

  public static async create(tenantId: string, input: GradeInput) {
    try {
      return await prisma.grade.create({ data: { ...input, tenantId } });
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
  }

  public static async update(tenantId: string, id: string, input: GradeInput) {
    try {
      const result = await prisma.grade.updateMany({ where: { id, tenantId }, data: input });
      if (result.count !== 1) throw new AdminError('Grade not found.', 404);
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
    return prisma.grade.findFirst({ where: { id, tenantId } });
  }

  public static async remove(tenantId: string, id: string): Promise<void> {
    const inUse = await prisma.employee.count({ where: { gradeId: id, tenantId } });
    if (inUse > 0) throw new AdminError(`This grade is used by ${inUse} employee(s). Make it inactive instead.`, 409);
    const result = await prisma.grade.deleteMany({ where: { id, tenantId } });
    if (result.count !== 1) throw new AdminError('Grade not found.', 404);
  }
}
