import { prisma } from '../db.service';
import { authCache } from '../auth.service';
import { ALL_PERMISSIONS, BUILT_IN_ROLES, BuiltInRole } from '../../config/permissions';
import { AdminError, isDuplicate } from './admin-error';
import type { RoleInput } from '../../schemas/admin.schema';

const BUILT_IN_CODES = Object.keys(BUILT_IN_ROLES) as BuiltInRole[];

export function isBuiltInCode(code: string): code is BuiltInRole {
  return (BUILT_IN_CODES as string[]).includes(code);
}

export class RoleService {
  /** Makes sure the four built-in roles exist as rows for this tenant, so they can be shown and edited. */
  public static async ensureBuiltIn(tenantId: string): Promise<void> {
    await prisma.role.createMany({
      data: BUILT_IN_CODES.map((code) => ({
        tenantId,
        code,
        name: BUILT_IN_ROLES[code].name,
        description: BUILT_IN_ROLES[code].description,
        permissions: BUILT_IN_ROLES[code].permissions,
        isSystem: true,
      })),
      skipDuplicates: true,
    });
  }

  public static async list(tenantId: string) {
    await RoleService.ensureBuiltIn(tenantId);
    const rows = await prisma.role.findMany({
      where: { tenantId },
      take: 500,
      include: { _count: { select: { users: true, employees: true } } },
    });
    // Built-in roles first, in a fixed order, then custom roles by name.
    const order = (code: string, system: boolean) => (system ? BUILT_IN_CODES.indexOf(code as BuiltInRole) : 100);
    rows.sort((a, b) => order(a.code, a.isSystem) - order(b.code, b.isSystem) || a.name.localeCompare(b.name));
    return rows.map(({ _count, ...r }) => ({ ...r, userCount: _count.users, employeeCount: _count.employees }));
  }

  public static async create(tenantId: string, input: RoleInput) {
    if (isBuiltInCode(input.code)) throw new AdminError('That code is reserved for a built-in role.', 409);
    try {
      return await prisma.role.create({ data: { ...input, tenantId, isSystem: false } });
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError('A role with this code already exists.', 409);
      throw error;
    }
  }

  /** Built-in roles keep their code. ADMIN always keeps every permission and stays active. */
  public static async update(tenantId: string, id: string, input: RoleInput) {
    const role = await prisma.role.findFirst({ where: { id, tenantId } });
    if (!role) throw new AdminError('Role not found.', 404);

    if (role.isSystem && input.code !== role.code) throw new AdminError('The code of a built-in role cannot change.', 400);
    if (!role.isSystem && isBuiltInCode(input.code)) throw new AdminError('That code is reserved for a built-in role.', 409);

    const locked = role.isSystem && role.code === 'ADMIN';
    if (locked && !input.isActive) throw new AdminError('The Admin role cannot be turned off.', 400);

    if (!input.isActive && role.isActive) {
      const users = await prisma.user.count({ where: { roleId: id, tenantId, isActive: true } });
      if (users > 0) throw new AdminError(`${users} active user(s) have this role. Move them to another role first.`, 409);
    }

    try {
      await prisma.role.updateMany({
        where: { id, tenantId },
        data: {
          code: input.code,
          name: input.name,
          description: input.description,
          isActive: input.isActive,
          permissions: locked ? ALL_PERMISSIONS : input.permissions,
        },
      });
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError('A role with this code already exists.', 409);
      throw error;
    }
    // Take effect now, not after the short auth cache runs out.
    authCache.clear();
    return prisma.role.findFirst({ where: { id, tenantId } });
  }

  public static async remove(tenantId: string, id: string): Promise<void> {
    const role = await prisma.role.findFirst({ where: { id, tenantId } });
    if (!role) throw new AdminError('Role not found.', 404);
    if (role.isSystem) throw new AdminError('A built-in role cannot be deleted.', 400);
    const [users, employees] = await Promise.all([
      prisma.user.count({ where: { roleId: id, tenantId } }),
      prisma.employee.count({ where: { roleId: id, tenantId } }),
    ]);
    if (users + employees > 0) {
      throw new AdminError(`This role is used by ${users} user(s) and ${employees} employee(s). Move them first.`, 409);
    }
    await prisma.role.deleteMany({ where: { id, tenantId } });
    authCache.clear();
  }
}
