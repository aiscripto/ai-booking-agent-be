import { prisma } from '../db.service';
import { AdminError, isDuplicate } from './admin-error';
import type { CategoryInput } from '../../schemas/admin.schema';

const DUPLICATE = 'A service category with this name already exists.';

export class CategoryService {
  public static async list(tenantId: string) {
    const rows = await prisma.serviceCategory.findMany({
      where: { tenantId },
      orderBy: { name: 'asc' },
      take: 500,
      include: { _count: { select: { employees: true } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, consultantCount: _count.employees }));
  }

  public static async create(tenantId: string, input: CategoryInput) {
    try {
      return await prisma.serviceCategory.create({ data: { ...input, tenantId } });
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
  }

  public static async update(tenantId: string, id: string, input: CategoryInput) {
    try {
      const result = await prisma.serviceCategory.updateMany({ where: { id, tenantId }, data: input });
      if (result.count !== 1) throw new AdminError('Service category not found.', 404);
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError(DUPLICATE, 409);
      throw error;
    }
    return prisma.serviceCategory.findFirst({ where: { id, tenantId } });
  }

  public static async remove(tenantId: string, id: string): Promise<void> {
    const inUse = await prisma.employee.count({ where: { tenantId, categories: { some: { id } } } });
    if (inUse > 0) throw new AdminError(`${inUse} consultant(s) offer this service. Make it inactive instead.`, 409);
    // Old appointments keep their record; only the link to the category is removed.
    const result = await prisma.serviceCategory.deleteMany({ where: { id, tenantId } });
    if (result.count !== 1) throw new AdminError('Service category not found.', 404);
  }
}
