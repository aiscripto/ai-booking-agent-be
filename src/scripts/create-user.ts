/**
 * Creates a dashboard user, or resets the password of an existing one in the same tenant.
 *
 *   read -rs PW; printf %s "$PW" | node dist/scripts/create-user.js \
 *     --tenant <tenant-uuid> --email someone@clinic.com --name "Full Name" --role ADMIN --yes
 *
 * Add --reset to change the password of an existing user. Add --allow-weak-password to accept a
 * password shorter than 12 characters (at least 4); only for a test system. The password is read from stdin so it
 * never appears in shell history or in the process list. This writes to whatever database
 * DATABASE_URL points at, so it prints the target and needs --yes. Not imported by runtime code.
 */
import { parseArgs } from 'node:util';
import { config } from '../config';
import { prisma } from '../services/db.service';
import { AuthError, AuthService, StaffRole } from '../services/auth.service';

const ROLES: StaffRole[] = ['ADMIN', 'PROVIDER', 'FRONT_DESK', 'PATIENT'];

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/[\r\n]+$/, '');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string', default: 'ADMIN' },
      reset: { type: 'boolean', default: false },
      'allow-weak-password': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });

  if (!values.tenant || !values.email) {
    throw new AuthError('Required: --tenant <uuid> --email <address>. Password comes from stdin.');
  }
  const role = String(values.role).toUpperCase() as StaffRole;
  if (!ROLES.includes(role)) {
    throw new AuthError(`--role must be one of ${ROLES.join(', ')}.`);
  }

  // Show where this will write, with the credentials hidden.
  const target = new URL(config.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || '5432'}${target.pathname}`);
  console.log(`${values.reset ? 'Reset password for' : 'Create'}: ${values.email} (${role}) in tenant ${values.tenant}`);
  if (values['allow-weak-password']) {
    console.log('WARNING: a short password is allowed for this account. Anyone who guesses it can sign in.');
  }
  if (!values.yes) {
    console.log('Not done. Add --yes to continue.');
    return;
  }

  const password = await readStdin();
  const result = await AuthService.createUser({
    tenantId: values.tenant,
    email: values.email,
    name: values.name ?? null,
    role,
    password,
    resetIfExists: values.reset,
    allowWeakPassword: values['allow-weak-password'],
  });
  console.log(`Done: ${result.action} for ${result.user.email} (id ${result.user.id}).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof AuthError ? `Error: ${error.message}` : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
