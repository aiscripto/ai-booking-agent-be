import { Router } from 'express';
import { AdminController as C } from '../controllers/admin.controller';
import { requireAnyPermission, requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// The setup panel. Every route needs a signed-in user; the tenant comes from the verified token.
router.use(requireAuth);

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

export const adminRouter = router;
