import { Prisma } from '@prisma/client';
import { prisma } from '../db.service';
import { AuthService, authCache } from '../auth.service';
import { AdminError, isDuplicate } from './admin-error';
import { RoleService, isBuiltInCode } from './role.service';
import type { CreateUserInput, UpdateUserInput } from '../../schemas/admin.schema';

const view = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  createdAt: true,
  roleId: true,
  roleRef: { select: { id: true, code: true, name: true } },
  role: true,
  employee: { select: { id: true, code: true, fullName: true } },
} as const;

type Row = Prisma.UserGetPayload<{ select: typeof view }>;

function toView(row: Row) {
  const { email, roleRef, role, ...rest } = row;
  return {
    ...rest,
    username: email,
    role: roleRef ?? { id: null, code: role, name: role },
  };
}

export class UserAdminService {
  /** The role a user will get: it must belong to the tenant. Custom roles store PATIENT (no access) as the fallback. */
  private static async resolveRole(tenantId: string, roleId: string) {
    await RoleService.ensureBuiltIn(tenantId);
    const role = await prisma.role.findFirst({ where: { id: roleId, tenantId } });
    if (!role) throw new AdminError('Role not found.', 400);
    if (!role.isActive) throw new AdminError('That role is turned off.', 400);
    const builtIn = role.isSystem && isBuiltInCode(role.code) ? role.code : 'PATIENT';
    return { role, builtIn };
  }

  private static async checkEmployee(tenantId: string, employeeId: string | null, selfId?: string): Promise<void> {
    if (!employeeId) return;
    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, tenantId },
      select: { user: { select: { id: true } } },
    });
    if (!employee) throw new AdminError('Employee not found.', 400);
    if (employee.user && employee.user.id !== selfId) {
      throw new AdminError('That employee already has a user account.', 409);
    }
  }

  /** How many other active users could still manage users and roles (so the last one is never removed). */
  private static countOtherManagers(tenantId: string, excludeUserId: string): Promise<number> {
    return prisma.user.count({
      where: {
        tenantId,
        isActive: true,
        id: { not: excludeUserId },
        OR: [
          { roleRef: { is: { code: 'ADMIN', isSystem: true } } },
          { roleRef: { is: { isActive: true, permissions: { has: 'users.manage' } } } },
          { roleRef: null, role: 'ADMIN' },
        ],
      },
    });
  }

  public static async list(tenantId: string) {
    await RoleService.ensureBuiltIn(tenantId);
    const rows = await prisma.user.findMany({ where: { tenantId }, orderBy: { email: 'asc' }, take: 1000, select: view });
    return rows.map(toView);
  }

  public static async create(tenantId: string, input: CreateUserInput) {
    const { role, builtIn } = await UserAdminService.resolveRole(tenantId, input.roleId);
    await UserAdminService.checkEmployee(tenantId, input.employeeId);
    const passwordHash = await AuthService.hashPassword(input.password);
    try {
      const row = await prisma.user.create({
        data: {
          tenantId,
          email: input.username,
          passwordHash,
          name: input.name,
          role: builtIn,
          roleId: role.id,
          employeeId: input.employeeId,
          isActive: input.isActive,
        },
        select: view,
      });
      return toView(row);
    } catch (error) {
      // One message whether the name is used here or in another tenant (the column is unique across tenants).
      if (isDuplicate(error)) throw new AdminError('That user name is already taken.', 409);
      throw error;
    }
  }

  public static async update(tenantId: string, actorId: string, id: string, input: UpdateUserInput) {
    const current = await prisma.user.findFirst({ where: { id, tenantId }, select: { id: true, isActive: true } });
    if (!current) throw new AdminError('User not found.', 404);

    const { role, builtIn } = await UserAdminService.resolveRole(tenantId, input.roleId);
    await UserAdminService.checkEmployee(tenantId, input.employeeId, id);

    // Lock-out guards: nobody can switch off or demote their own account, and the last manager stays.
    const willManage = input.isActive && (role.code === 'ADMIN' || role.permissions.includes('users.manage'));
    if (id === actorId && (!input.isActive || !willManage)) {
      throw new AdminError('You cannot switch off or demote your own account.', 409);
    }
    if (!willManage && (await UserAdminService.countOtherManagers(tenantId, id)) === 0) {
      throw new AdminError('At least one active user must be able to manage users and roles.', 409);
    }

    const data: Prisma.UserUncheckedUpdateManyInput = {
      name: input.name,
      role: builtIn,
      roleId: role.id,
      employeeId: input.employeeId,
      isActive: input.isActive,
    };
    if (input.password) data.passwordHash = await AuthService.hashPassword(input.password);

    // Touching the row also changes updatedAt, which ends this user's refresh tokens (sessions).
    try {
      const result = await prisma.user.updateMany({ where: { id, tenantId }, data });
      if (result.count !== 1) throw new AdminError('User not found.', 404);
    } catch (error) {
      if (isDuplicate(error)) throw new AdminError('That employee already has a user account.', 409);
      throw error;
    }
    authCache.invalidateUser(id);

    const row = await prisma.user.findFirst({ where: { id, tenantId }, select: view });
    if (!row) throw new AdminError('User not found.', 404);
    return toView(row);
  }
}
