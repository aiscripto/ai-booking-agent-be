import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PERMISSIONS } from '../config/permissions';
import {
  businessSchema,
  categorySchema,
  timeOffSchema,
  createUserSchema,
  departmentSchema,
  employeeSchema,
  gradeSchema,
  idParamSchema,
  roleSchema,
  updateUserSchema,
} from '../schemas/admin.schema';
import { BusinessService } from '../services/admin/business.service';
import { GradeService } from '../services/admin/grade.service';
import { CategoryService } from '../services/admin/category.service';
import { DepartmentService } from '../services/admin/department.service';
import { EmployeeService } from '../services/admin/employee.service';
import { RoleService } from '../services/admin/role.service';
import { UserAdminService } from '../services/admin/user-admin.service';

type Handler = (req: Request, res: Response, tenantId: string, actorId: string) => Promise<void>;

/** Every admin route: the tenant and the actor come from the verified login, never from the request. */
function admin(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) {
        res.status(401).json({ status: 'error', message: 'Authentication required.' });
        return;
      }
      await handler(req, res, req.auth.tenantId, req.auth.userId);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          status: 'error',
          message: error.issues[0]?.message ?? 'Invalid input.',
          issues: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        });
        return;
      }
      next(error);
    }
  };
}

const ok = (res: Response, data: unknown, status = 200): void => {
  res.status(status).json({ status: 'success', data });
};
const idOf = (req: Request) => idParamSchema.parse(req.params).id;

export class AdminController {
  public static permissions = admin(async (_req, res) => ok(res, PERMISSIONS));

  public static getBusiness = admin(async (_req, res, tenantId) => ok(res, await BusinessService.get(tenantId)));
  public static updateBusiness = admin(async (req, res, tenantId) =>
    ok(res, await BusinessService.update(tenantId, businessSchema.parse(req.body))));

  public static listGrades = admin(async (_req, res, tenantId) => ok(res, await GradeService.list(tenantId)));
  public static createGrade = admin(async (req, res, tenantId) =>
    ok(res, await GradeService.create(tenantId, gradeSchema.parse(req.body)), 201));
  public static updateGrade = admin(async (req, res, tenantId) =>
    ok(res, await GradeService.update(tenantId, idOf(req), gradeSchema.parse(req.body))));
  public static deleteGrade = admin(async (req, res, tenantId) => {
    await GradeService.remove(tenantId, idOf(req));
    ok(res, { deleted: true });
  });

  public static listDepartments = admin(async (_req, res, tenantId) => ok(res, await DepartmentService.list(tenantId)));
  public static createDepartment = admin(async (req, res, tenantId) =>
    ok(res, await DepartmentService.create(tenantId, departmentSchema.parse(req.body)), 201));
  public static updateDepartment = admin(async (req, res, tenantId) =>
    ok(res, await DepartmentService.update(tenantId, idOf(req), departmentSchema.parse(req.body))));
  public static deleteDepartment = admin(async (req, res, tenantId) => {
    await DepartmentService.remove(tenantId, idOf(req));
    ok(res, { deleted: true });
  });

  public static listEmployees = admin(async (_req, res, tenantId) => ok(res, await EmployeeService.list(tenantId)));
  public static createEmployee = admin(async (req, res, tenantId) =>
    ok(res, await EmployeeService.create(tenantId, employeeSchema.parse(req.body)), 201));
  public static updateEmployee = admin(async (req, res, tenantId) =>
    ok(res, await EmployeeService.update(tenantId, idOf(req), employeeSchema.parse(req.body))));

  public static listCategories = admin(async (_req, res, tenantId) => ok(res, await CategoryService.list(tenantId)));
  public static createCategory = admin(async (req, res, tenantId) =>
    ok(res, await CategoryService.create(tenantId, categorySchema.parse(req.body)), 201));
  public static updateCategory = admin(async (req, res, tenantId) =>
    ok(res, await CategoryService.update(tenantId, idOf(req), categorySchema.parse(req.body))));
  public static deleteCategory = admin(async (req, res, tenantId) => {
    await CategoryService.remove(tenantId, idOf(req));
    ok(res, { deleted: true });
  });

  public static listTimeOff = admin(async (req, res, tenantId) => ok(res, await EmployeeService.listTimeOff(tenantId, idOf(req))));
  public static addTimeOff = admin(async (req, res, tenantId) =>
    ok(res, await EmployeeService.addTimeOff(tenantId, idOf(req), timeOffSchema.parse(req.body)), 201));
  public static removeTimeOff = admin(async (req, res, tenantId) => {
    await EmployeeService.removeTimeOff(tenantId, idOf(req));
    ok(res, { deleted: true });
  });

  public static listRoles = admin(async (_req, res, tenantId) => ok(res, await RoleService.list(tenantId)));
  public static createRole = admin(async (req, res, tenantId) =>
    ok(res, await RoleService.create(tenantId, roleSchema.parse(req.body)), 201));
  public static updateRole = admin(async (req, res, tenantId) =>
    ok(res, await RoleService.update(tenantId, idOf(req), roleSchema.parse(req.body))));
  public static deleteRole = admin(async (req, res, tenantId) => {
    await RoleService.remove(tenantId, idOf(req));
    ok(res, { deleted: true });
  });

  public static listUsers = admin(async (_req, res, tenantId) => ok(res, await UserAdminService.list(tenantId)));
  public static createUser = admin(async (req, res, tenantId) =>
    ok(res, await UserAdminService.create(tenantId, createUserSchema.parse(req.body)), 201));
  public static updateUser = admin(async (req, res, tenantId, actorId) =>
    ok(res, await UserAdminService.update(tenantId, actorId, idOf(req), updateUserSchema.parse(req.body))));
}
