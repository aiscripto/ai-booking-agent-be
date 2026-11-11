/**
 * Applies the migrations the database has not got yet, then exits. Used by deploy.sh.
 *
 *   docker compose exec -T api node dist/scripts/apply-migrations.js
 *
 * Safe to run again: with nothing new it does nothing. Not imported by runtime code.
 */
import { prisma } from '../services/db.service';
import { applyMigrations } from '../services/migration-apply';

applyMigrations(prisma as never, undefined, (line) => console.log(line))
  .then((applied) => {
    console.log(applied.length === 0 ? 'OK   no new migrations to apply.' : `OK   applied: ${applied.join(', ')}`);
  })
  .catch((error: unknown) => {
    console.error('FAIL migrations:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
