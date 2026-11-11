import { Request, Response, NextFunction } from 'express';
import { google } from 'googleapis';
import { config } from '../config';
import { prisma } from '../services/db.service';
import { z } from 'zod';

const REFRESH_COOKIE = 'refresh_token';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Reads one cookie from the Cookie header (no extra package needed). */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The refresh token lives only in this cookie: JavaScript cannot read it (httpOnly), it is only
 * sent to the auth endpoints (path), and never on requests from other sites (SameSite=Strict).
 * `secure` follows the connection: on plain http (today's VM address) a Secure cookie would be
 * dropped by the browser, so it is turned on automatically once the site is served over https.
 */
function setRefreshCookie(req: Request, res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: REFRESH_COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(req: Request, res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: REFRESH_COOKIE_PATH });
}

/** Extra defence against cross-site requests: browsers only let a site add this header itself. */
function hasCsrfHeader(req: Request): boolean {
  return req.headers['x-requested-with'] === 'fetch';
}
import { OAuthStateService } from '../services/oauth-state.service';
import { AuthError, AuthService } from '../services/auth.service';
import { GoogleCalendarService } from '../services/google-calendar.service';
import { loginSchema } from '../schemas/auth.schema';

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class AuthController {
  /**
   * POST /api/v1/auth/login
   * Body: { email, password }. Returns { token, user }.
   */
  public static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ status: 'error', message: 'A valid email and password are required.' });
        return;
      }

      const { token, refreshToken, user } = await AuthService.login(parsed.data.email, parsed.data.password, req.ip);
      setRefreshCookie(req, res, refreshToken);
      res.status(200).json({ status: 'success', data: { token, user } });
    } catch (error) {
      if (error instanceof AuthError) {
        res.status(401).json({ status: 'error', message: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/v1/auth/refresh
   * Uses the refresh cookie to issue a new access token and a new refresh cookie (rotation).
   */
  public static async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!hasCsrfHeader(req)) {
        res.status(400).json({ status: 'error', message: 'Invalid request.' });
        return;
      }

      const cookie = readCookie(req, REFRESH_COOKIE);
      if (!cookie) {
        res.status(401).json({ status: 'error', message: 'Please sign in again.' });
        return;
      }

      const { token, refreshToken, user } = await AuthService.refresh(cookie);
      setRefreshCookie(req, res, refreshToken);
      res.status(200).json({ status: 'success', data: { token, user } });
    } catch (error) {
      if (error instanceof AuthError) {
        clearRefreshCookie(req, res);
        res.status(401).json({ status: 'error', message: error.message });
        return;
      }
      next(error);
    }
  }

  /**
   * POST /api/v1/auth/logout
   * Clears the refresh cookie and signs the user out on every device (see revokeSessions).
   */
  public static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!hasCsrfHeader(req)) {
        res.status(400).json({ status: 'error', message: 'Invalid request.' });
        return;
      }

      const cookie = readCookie(req, REFRESH_COOKIE);
      if (cookie) {
        await AuthService.revokeSessions(cookie, req.ip);
      }
      clearRefreshCookie(req, res);
      res.status(200).json({ status: 'success', data: null });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/auth/google/status
   * Which Google account the signed-in user's tenant uses for its calendar. Never returns a token.
   */
  public static async googleStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.auth?.tenantId;
      if (!tenantId) {
        res.status(401).json({ status: 'error', message: 'Authentication required.' });
        return;
      }
      const { source } = await GoogleCalendarService.getConnectionStatus(tenantId);
      res.status(200).json({ status: 'success', data: { source } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/auth/me
   * Returns the signed-in user. Used by the frontend to check that a stored token still works.
   */
  public static async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = req.auth ? await AuthService.getPublicUser(req.auth) : null;
      if (!user) {
        res.status(401).json({ status: 'error', message: 'Authentication required.' });
        return;
      }
      res.status(200).json({ status: 'success', data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Generates the Google Calendar OAuth Consent URL for the signed-in admin's own tenant.
   * The tenant comes from the verified login token, never from the request.
   */
  public static async getAuthUrl(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const tenantId = req.auth?.tenantId;
      if (!tenantId) {
        res.status(401).json({ status: 'error', message: 'Authentication required.' });
        return;
      }

      // Verify the tenant exists before generating the URL
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant) {
        res.status(404).json({
          status: 'error',
          message: 'Tenant not found.',
        });
        return;
      }

      const isGoogleConfigured = 
        config.GOOGLE_CLIENT_ID && 
        config.GOOGLE_CLIENT_ID !== 'your-google-client-id' && 
        !config.GOOGLE_CLIENT_ID.includes('mock') && 
        config.GOOGLE_CLIENT_SECRET && 
        config.GOOGLE_CLIENT_SECRET !== 'your-google-client-secret' && 
        !config.GOOGLE_CLIENT_SECRET.includes('mock');

      if (!isGoogleConfigured) {
        if (config.NODE_ENV === 'production') {
          res.status(503).json({
            status: 'error',
            message: 'Google Calendar integration is not configured.',
          });
          return;
        }
        const backendUrl = `${req.protocol}://${req.get('host')}`;
        const authUrl = `${backendUrl}/api/v1/auth/google/callback?code=mock-code&state=${encodeURIComponent(OAuthStateService.create(tenantId))}`;
        res.status(200).json({
          status: 'success',
          authUrl,
        });
        return;
      }

      const oauth2Client = new google.auth.OAuth2(
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET,
        config.GOOGLE_CALLBACK_URL
      );

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Request permanent refresh token
        prompt: 'consent',     // Force consent screen to guarantee refresh token is returned
        scope: ['https://www.googleapis.com/auth/calendar.events'],
        state: OAuthStateService.create(tenantId), // Signed, expiring, single-use
      });

      res.status(200).json({
        status: 'success',
        authUrl,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Handles Google OAuth callback redirect.
   * Trades the auth code for access/refresh tokens and stores them in the database.
   */
  public static async googleCallback(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { code, state, error } = req.query;

      if (error) {
        res.status(400).send(`
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px; background-color: #f8fafc;">
              <h2 style="color: #ef4444;">OAuth Authentication Failed</h2>
              <p>${escapeHtml(error)}</p>
            </body>
          </html>
        `);
        return;
      }

      // The state must be one we issued: signed, not expired, and not used before.
      const tenantId = OAuthStateService.consume(state);

      if (!code || !tenantId || !z.string().uuid().safeParse(tenantId).success) {
        res.status(400).send(`
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px; background-color: #f8fafc;">
              <h2 style="color: #ef4444;">Invalid Request</h2>
              <p>Missing auth code, or the sign-in link is invalid, expired or already used. Please start again from the dashboard.</p>
            </body>
          </html>
        `);
        return;
      }

      if (code === 'mock-code') {
        // Local development only. Never allowed in production, and it never
        // replaces a real credential that is already stored for the tenant.
        if (config.NODE_ENV === 'production') {
          res.status(400).send(`
          <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px; background-color: #f8fafc;">
              <h2 style="color: #ef4444;">Invalid Request</h2>
              <p>Missing auth code or invalid tenant session ID.</p>
            </body>
          </html>
        `);
          return;
        }
        const existing = await prisma.googleCredential.findUnique({ where: { tenantId } });
        if (!existing) {
          const expiryDate = new Date(Date.now() + 365 * 24 * 3600 * 1000); // 1 year
          await prisma.googleCredential.create({
            data: {
              tenantId,
              accessToken: 'mock-access-token',
              refreshToken: 'mock-refresh-token',
              expiryDate,
            },
          });
        }
      } else {
        // Initialize OAuth2 client
        const oauth2Client = new google.auth.OAuth2(
          config.GOOGLE_CLIENT_ID,
          config.GOOGLE_CLIENT_SECRET,
          config.GOOGLE_CALLBACK_URL
        );

        // Exchange authorization code for tokens
        const { tokens } = await oauth2Client.getToken(code as string);

        if (!tokens.access_token) {
          throw new Error('Google did not return an access token.');
        }

        const expiryDate = tokens.expiry_date 
          ? new Date(tokens.expiry_date) 
          : new Date(Date.now() + 3600 * 1000);

        // Save tokens securely in Postgres (Rule of least privilege: tenantId matching isolation)
        await prisma.googleCredential.upsert({
          where: { tenantId },
          update: {
            accessToken: tokens.access_token,
            // Only update refresh token if Google returned it, otherwise preserve existing
            ...(tokens.refresh_token && { refreshToken: tokens.refresh_token }),
            expiryDate,
          },
          create: {
            tenantId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || '', // Handled if consent wasn't forced (though prompt: 'consent' forces it)
            expiryDate,
          },
        });
      }

      // Respond with a clean, beautifully styled page
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Google Calendar Connected</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
              background-color: #0f172a;
              color: #f8fafc;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
            }
            .card {
              background-color: #1e293b;
              padding: 40px;
              border-radius: 16px;
              box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3), 0 8px 10px -6px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 400px;
              width: 90%;
            }
            .icon {
              font-size: 48px;
              margin-bottom: 20px;
            }
            h2 {
              margin-top: 0;
              color: #38bdf8;
              font-weight: 600;
            }
            p {
              color: #94a3b8;
              font-size: 16px;
              line-height: 1.5;
            }
            .btn {
              display: inline-block;
              margin-top: 24px;
              padding: 10px 20px;
              background-color: #0284c7;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 500;
              transition: background-color 0.2s;
            }
            .btn:hover {
              background-color: #0369a1;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">📅</div>
            <h2>Calendar Connected!</h2>
            <p>Your Google Calendar has been successfully integrated with your Voice Agent account.</p>
            <p>You can now safely close this window and return to the dashboard.</p>
          </div>
        </body>
        </html>
      `);
    } catch (error: any) {
      console.error('[AuthController.googleCallback] Error during OAuth redirect handling:', error);
      res.status(500).send(`
        <html>
          <body style="font-family: Arial, sans-serif; text-align: center; padding-top: 100px; background-color: #f8fafc; color: #334155;">
            <h2 style="color: #ef4444;">Server Error</h2>
            <p>Failed to connect Google Calendar. Please try again.</p>
          </body>
        </html>
      `);
    }
  }
}
