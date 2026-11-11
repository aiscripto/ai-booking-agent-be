import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';
import { loginLimitPerAccount, loginLimitPerAddress, refreshLimitPerAddress } from '../middlewares/login-rate-limit';

const router = Router();

// Sign in with email and password. Failed attempts are rate limited.
router.post('/login', loginLimitPerAddress, loginLimitPerAccount, AuthController.login);

// Renew the access token from the refresh cookie (rotates the cookie)
router.post('/refresh', refreshLimitPerAddress, AuthController.refresh);

// Sign out: clears the cookie and ends the user's sessions on every device
router.post('/logout', refreshLimitPerAddress, AuthController.logout);

// Who am I (checks that the stored token still works)
router.get('/me', requireAuth, AuthController.me);

// Which Google account the calendar uses for the signed-in user's tenant (anyone allowed on the dashboard)
router.get('/google/status', requireAuth, requirePermission('dashboard.view'), AuthController.googleStatus);

// Endpoint to generate Google OAuth Consent screen URL (needs the business-settings permission, own tenant)
router.get('/google', requireAuth, requirePermission('settings.business'), AuthController.getAuthUrl);

// Google OAuth redirect callback endpoint. Public on purpose: Google redirects the browser here.
// It is protected by the signed, expiring, single-use `state` value.
router.get('/google/callback', AuthController.googleCallback);

export const authRouter = router;
