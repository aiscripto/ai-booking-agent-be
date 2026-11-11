import { prisma } from '../db.service';
import { AdminError, isDuplicate } from './admin-error';
import type { DepartmentInput } from '../../schemas/admin.schema';

const DUPLICATE = 'A department with this name already exists.';

/** The form calls it "location"; the database column is buildingLocation. */
function toData(input: DepartmentInput) {
  const { location, ...rest } = input;
  return { ...rest, buildingLocation: location };
}

function toView<T extends { buildingLocation: string | null }>(row: T) {
  const { buildingLocation, ...rest } = row;
  return { ...rest, location: buildingLocation };
}

export class DepartmentService {
  public static async list(tenantId: string) {
    const rows = await prisma.department.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      take: 1000,
      include: { _count: { select: { employees: true, resources: true } } },
    });
    return rows.map(({ _count, ...d }) => ({ ...toView(d), employeeCount: _count.employees, providerCount: _count.resources }));
  }

  public static async create(tenantId: string, input: DepartmentInput) {
    try {
      return toView(await prisma.department.create({ data: { ...toData(input), tenantId } }));
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
  }

  public static async update(tenantId: string, id: string, input: DepartmentInput) {
    try {
      const result = await prisma.department.updateMany({ where: { id, tenantId }, data: toData(input) });
      if (result.count !== 1) throw new AdminError('Department not found.', 404);
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
    const row = await prisma.department.findFirst({ where: { id, tenantId } });
    return row ? toView(row) : null;
  }

  public static async remove(tenantId: string, id: string): Promise<void> {
    const [employees, providers] = await Promise.all([
      prisma.employee.count({ where: { departmentId: id, tenantId } }),
      prisma.resource.count({ where: { departmentId: id, tenantId } }),
    ]);
    if (employees + providers > 0) {
      throw new AdminError(
        `This department has ${employees} employee(s) and ${providers} provider(s). Make it inactive instead.`,
        409,
      );
    }
    const result = await prisma.department.deleteMany({ where: { id, tenantId } });
    if (result.count !== 1) throw new AdminError('Department not found.', 404);
  }
}
