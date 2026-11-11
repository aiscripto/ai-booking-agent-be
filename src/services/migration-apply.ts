import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { findMigrationGaps, migrationsOnDisk } from './schema-check';

/**
 * Applies the migrations in prisma/migrations that the database has not recorded yet, and records
 * them the way `prisma migrate deploy` does. Needed because the production image has no Prisma
 * command line. Each migration runs in ONE transaction: it is applied completely or not at all.
 *
 * Plain SQL only. A migration with dollar-quoted blocks ($$) is refused: apply it by hand.
 */

export interface SqlClient {
  $transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
export interface SqlTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export class MigrationError extends Error {}

/** Splits a migration file into single statements. Comment lines are dropped. */
export function splitStatements(sql: string): string[] {
  if (sql.includes('$$')) throw new MigrationError('This migration uses $$ blocks, which this runner cannot split. Apply it by hand.');
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checksumOf(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

/** Returns the names of the migrations it applied (empty when the database is up to date). */
export async function applyMigrations(
  client: SqlClient,
  dir: string = path.join(process.cwd(), 'prisma', 'migrations'),
  log: (line: string) => void = () => undefined,
): Promise<string[]> {
  const table = await client.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass('_prisma_migrations')::text AS found`);
  if (!table[0]?.found) throw new MigrationError('The table _prisma_migrations does not exist. This database was never set up with migrations.');

  const rows = await client.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>(
    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations',
  );
  const unfinished = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null).map((r) => r.migration_name);
  if (unfinished.length) throw new MigrationError(`These migrations started but did not finish: ${unfinished.join(', ')}. Fix them by hand first.`);

  const recorded = rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null).map((r) => r.migration_name);
  const gaps = findMigrationGaps(migrationsOnDisk(dir), recorded);
  if (gaps.unknown.length) throw new MigrationError(`The database records migrations that are not in the code: ${gaps.unknown.join(', ')}.`);

  // A migration older than one already applied would run out of order.
  const newest = [...recorded].sort().pop() ?? '';
  const outOfOrder = gaps.notRecorded.filter((name) => name < newest);
  if (outOfOrder.length) throw new MigrationError(`Out-of-order migrations (older than one already applied): ${outOfOrder.join(', ')}.`);

  const applied: string[] = [];
  for (const name of gaps.notRecorded) {
    const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8');
    const statements = splitStatements(sql);
    log(`Applying ${name} (${statements.length} statements)...`);
    await client.$transaction(async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
        crypto.randomUUID(),
        checksumOf(sql),
        name,
      );
    });
    applied.push(name);
  }
  return applied;
}
