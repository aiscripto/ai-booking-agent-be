import { Router } from 'express';
import { TenantController } from '../controllers/tenant.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// Every tenant route needs a signed-in user. The tenant comes from the verified token.
router.use(requireAuth);

// Reading: anyone allowed on the dashboard
router.get('/vocabulary', requirePermission('dashboard.view'), TenantController.getVocabulary);
router.get('/consultants', requirePermission('dashboard.view'), TenantController.getConsultants);
router.get('/branding', requirePermission('dashboard.view'), TenantController.getBranding);

// Changing the tenant: only roles that are allowed to
router.put('/branding', requirePermission('settings.business'), TenantController.updateBranding);
router.post('/resources', requirePermission('providers.manage'), TenantController.onboardResource);
router.delete('/resources/:id', requirePermission('providers.manage'), TenantController.offboardResource);

export const tenantRouter = router;
