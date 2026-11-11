/**
 * Copies the old providers into Employees who take appointments (consultants). Not imported by runtime code.
 *
 *   docker compose exec -T api node dist/scripts/migrate-providers.js            show what would happen
 *   docker compose exec -T api node dist/scripts/migrate-providers.js --yes      do it
 *
 * Safe to run again. The old provider rows are kept. After it runs, a business with at least one active
 * consultant books with consultants (see consultant.service.ts).
 */
import { prisma } from '../services/db.service';
import { migrateProvidersToEmployees } from '../services/admin/provider-migration.service';

async function main(): Promise<void> {
  const apply = process.argv.includes('--yes');
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  console.log(apply ? 'APPLYING' : 'DRY RUN (nothing is changed; add --yes to apply)');
  for (const tenant of tenants) {
    const result = await migrateProvidersToEmployees(tenant.id, apply);
    if (result.created.length + result.skipped.length === 0) continue;
    console.log(`\n${tenant.name}`);
    for (const c of result.created) console.log(`  ${apply ? 'created ' : 'would create'} ${c.code}  ${c.fullName}`);
    for (const s of result.skipped) console.log(`  skipped      ${s.name}: ${s.reason}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error('FAIL:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
