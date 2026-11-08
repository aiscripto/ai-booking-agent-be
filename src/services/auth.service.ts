import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from './db.service';
import { AuthCache } from './auth-cache';

export type StaffRole = 'ADMIN' | 'PROVIDER' | 'FRONT_DESK' | 'PATIENT';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: StaffRole;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: StaffRole;
  tenantId: string;
}

const ISSUER = 'booking-agent';
const REFRESH_AUDIENCE = 'refresh';
// A session can never be renewed past this many days from the original sign-in.
const SESSION_MAX_DAYS = 30;
const DAY_SECONDS = 24 * 60 * 60;

// Refresh tokens use their own key, derived from the secret, so an access token can never be
// accepted as a refresh token or the other way round.
function refreshKey(): Buffer {
  return crypto.createHash('sha256').update(`refresh-token:${config.JWT_SECRET}`).digest();
}
// 12 rounds in real use. Tests use the minimum so they stay fast on a busy machine.
const BCRYPT_ROUNDS = config.NODE_ENV === 'test' ? 4 : 12;

// Compared against when the email is unknown, so a wrong email and a wrong password take
// about the same time and cannot be told apart. Made once, on first use, not at import.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('not-a-real-password', BCRYPT_ROUNDS);
  return dummyHash;
}

/** Shared by every request in this process. See auth-cache.ts for the trade-off. */
export const authCache = new AuthCache(config.AUTH_CACHE_SECONDS);

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: PublicUser;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class AuthService {
  public static hashPassword(password: string, rounds: number = BCRYPT_ROUNDS): Promise<string> {
    return bcrypt.hash(password, rounds);
  }

  /**
   * Checks an email and password. Returns the user and a signed token.
   * Throws AuthError with one fixed message for every failure.
   */
  public static async login(email: string, password: string): Promise<AuthResult> {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, isActive: true },
    });

    const matches = await bcrypt.compare(password, user ? user.passwordHash : await getDummyHash());
    if (!user || !matches) {
      throw new AuthError('Invalid email or password.');
    }

    const ctx: AuthContext = { userId: user.id, tenantId: user.tenantId, role: user.role };
    return {
      token: AuthService.signToken(ctx),
      refreshToken: AuthService.signRefreshToken(ctx, user.updatedAt, Math.floor(Date.now() / 1000)),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      },
    };
  }

  /**
   * A refresh token is signed with a different key and audience from an access token, so one
   * can never be used as the other. It carries the user row's last-updated time (`uv`), so a
   * change to the user (password reset, deactivation, logout-everywhere) makes older refresh
   * tokens stop working. `ss` is when the session began, so renewals cannot go on forever.
   */
  private static signRefreshToken(ctx: AuthContext, userUpdatedAt: Date, sessionStartSeconds: number): string {
    return jwt.sign({ tid: ctx.tenantId, uv: userUpdatedAt.getTime(), ss: sessionStartSeconds }, refreshKey(), {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: REFRESH_AUDIENCE,
      subject: ctx.userId,
      expiresIn: config.REFRESH_TOKEN_DAYS * DAY_SECONDS,
    });
  }

  private static readRefreshToken(token: string): { sub: string; tid: string; uv: number; ss: number } | null {
    try {
      const decoded = jwt.verify(token, refreshKey(), {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: REFRESH_AUDIENCE,
      });
      if (typeof decoded === 'string') return null;
      const { sub, tid, uv, ss } = decoded as jwt.JwtPayload;
      if (typeof sub !== 'string' || typeof tid !== 'string' || typeof uv !== 'number' || typeof ss !== 'number') {
        return null;
      }
      return { sub, tid, uv, ss };
    } catch {
      return null;
    }
  }

  /**
   * Trades a valid refresh token for a new access token and a new refresh token (rotation).
   * Throws AuthError for anything that is not valid, expired, revoked or too old.
   */
  public static async refresh(refreshToken: string): Promise<AuthResult> {
    const claims = AuthService.readRefreshToken(refreshToken);
    if (!claims) throw new AuthError('Please sign in again.');

    if (Date.now() - claims.ss * 1000 > SESSION_MAX_DAYS * DAY_SECONDS * 1000) {
      throw new AuthError('Please sign in again.');
    }

    const user = await prisma.user.findFirst({
      where: { id: claims.sub, tenantId: claims.tid, isActive: true },
    });
    // The user must still be active and unchanged since this token was issued.
    if (!user || user.updatedAt.getTime() !== claims.uv) {
      throw new AuthError('Please sign in again.');
    }

    const ctx: AuthContext = { userId: user.id, tenantId: user.tenantId, role: user.role };
    return {
      token: AuthService.signToken(ctx),
      refreshToken: AuthService.signRefreshToken(ctx, user.updatedAt, claims.ss),
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId },
    };
  }

  /**
   * Logs the user out everywhere: touching the user row changes its last-updated time, so every
   * refresh token issued before now stops working. Access tokens already issued still work until
   * they expire (15 minutes by default). A token that is not valid does nothing.
   */
  public static async revokeSessions(refreshToken: string): Promise<void> {
    const claims = AuthService.readRefreshToken(refreshToken);
    if (!claims) return;
    await prisma.user.updateMany({
      where: { id: claims.sub, tenantId: claims.tid },
      data: { updatedAt: new Date() },
    });
    authCache.invalidateUser(claims.sub);
  }

  public static signToken(ctx: AuthContext): string {
    return jwt.sign({ tid: ctx.tenantId, role: ctx.role }, config.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: ISSUER,
      subject: ctx.userId,
      // jsonwebtoken types this as a template string; the value is validated by jsonwebtoken itself.
      expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
  }

  /**
   * Verifies the token and then re-reads the user, so a disabled user or a changed role takes
   * effect at once, not when the token expires. Returns null for anything that is not valid.
   */
  public static async authenticate(token: string): Promise<AuthContext | null> {
    let claims: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
      if (typeof decoded === 'string') return null;
      claims = decoded;
    } catch {
      return null;
    }

    if (typeof claims.sub !== 'string' || typeof claims.tid !== 'string') return null;

    const cached = authCache.get(claims.sub, claims.tid);
    if (cached) return cached;

    const user = await prisma.user.findFirst({
      where: { id: claims.sub, tenantId: claims.tid, isActive: true },
      select: { id: true, tenantId: true, role: true },
    });
    if (!user) return null;

    const ctx: AuthContext = { userId: user.id, tenantId: user.tenantId, role: user.role };
    authCache.set(ctx);
    return ctx;
  }

  /**
   * Creates a staff user, or resets the password of an existing user in the SAME tenant.
   * Used by the create-user script. Returns what happened.
   */
  public static async createUser(input: {
    tenantId: string;
    email: string;
    name?: string | null;
    role: StaffRole;
    password: string;
    resetIfExists?: boolean;
    /**
     * Allow a short, easy-to-guess password (at least 4 characters). Off by default. Only for a test
     * system where the owner has decided to accept that anyone who guesses it gets in.
     */
    allowWeakPassword?: boolean;
  }): Promise<{ action: 'created' | 'password-reset'; user: PublicUser }> {
    const minimum = input.allowWeakPassword ? 4 : 12;
    if (input.password.length < minimum) {
      throw new AuthError(`The password must be at least ${minimum} characters.`);
    }
    if (Buffer.byteLength(input.password, 'utf8') > 72) {
      throw new AuthError('The password must be at most 72 bytes.');
    }

    const email = input.email.trim().toLowerCase();
    const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true } });
    if (!tenant) {
      throw new AuthError('Tenant not found.');
    }

    const passwordHash = await AuthService.hashPassword(input.password);
    const select = { id: true, email: true, name: true, role: true, tenantId: true } as const;

    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, tenantId: true },
    });

    if (existing) {
      if (existing.tenantId !== input.tenantId) {
        throw new AuthError('That email already belongs to a user in another tenant.');
      }
      if (!input.resetIfExists) {
        throw new AuthError('That email already exists. Use the reset option to change its password.');
      }
      const updated = await prisma.user.updateMany({
        where: { id: existing.id, tenantId: input.tenantId },
        data: { passwordHash, isActive: true },
      });
      if (updated.count !== 1) throw new AuthError('Could not update the user.');
      const user = await prisma.user.findFirst({ where: { id: existing.id, tenantId: input.tenantId }, select });
      if (!user) throw new AuthError('Could not read the user.');
      return { action: 'password-reset', user };
    }

    const user = await prisma.user.create({
      data: { tenantId: input.tenantId, email, name: input.name ?? null, role: input.role, passwordHash },
      select,
    });
    return { action: 'created', user };
  }

  public static async getPublicUser(ctx: AuthContext): Promise<PublicUser | null> {
    return prisma.user.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId, isActive: true },
      select: { id: true, email: true, name: true, role: true, tenantId: true },
    });
  }
}
