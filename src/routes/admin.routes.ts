import { Router } from 'express';
import { AdminController as C } from '../controllers/admin.controller';
import { auditRequests } from '../middlewares/audit.middleware';
import { requireAnyPermission, requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// The setup panel. Every route needs a signed-in user; the tenant comes from the verified token.
router.use(requireAuth, auditRequests);

// Business details
router.get('/business', requirePermission('settings.business'), C.getBusiness);
router.put('/business', requirePermission('settings.business'), C.updateBusiness);

// Organization: grades, departments, employees
const org = requirePermission('organization.manage');
router.get('/grades', org, C.listGrades);
router.post('/grades', org, C.createGrade);
router.put('/grades/:id', org, C.updateGrade);
router.delete('/grades/:id', org, C.deleteGrade);

router.get('/departments', org, C.listDepartments);
router.post('/departments', org, C.createDepartment);
router.put('/departments/:id', org, C.updateDepartment);
router.delete('/departments/:id', org, C.deleteDepartment);

router.get('/categories', org, C.listCategories);
router.post('/categories', org, C.createCategory);
router.put('/categories/:id', org, C.updateCategory);
router.delete('/categories/:id', org, C.deleteCategory);

router.get('/employees/:id/time-off', org, C.listTimeOff);
router.post('/employees/:id/time-off', org, C.addTimeOff);
router.delete('/time-off/:id', org, C.removeTimeOff);

// The employee list is also needed to link a user account, and the role list to set an employee's role.
router.get('/employees', requireAnyPermission('organization.manage', 'users.manage'), C.listEmployees);
router.post('/employees', org, C.createEmployee);
router.put('/employees/:id', org, C.updateEmployee);

// User management: roles and user accounts
const people = requirePermission('users.manage');
router.get('/permissions', people, C.permissions);
router.get('/roles', requireAnyPermission('organization.manage', 'users.manage'), C.listRoles);
router.post('/roles', people, C.createRole);
router.put('/roles/:id', people, C.updateRole);
router.delete('/roles/:id', people, C.deleteRole);

router.get('/users', people, C.listUsers);
router.post('/users', people, C.createUser);
router.put('/users/:id', people, C.updateUser);

// The audit log: read only. Nothing here can change or delete an entry.
router.get('/audit', requirePermission('audit.view'), C.listAudit);

export const adminRouter = router;
