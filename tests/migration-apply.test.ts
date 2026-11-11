import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/services/db.service';
import { applyMigrations, checksumOf, MigrationError, splitStatements } from '../src/services/migration-apply';

describe('splitStatements', () => {
  it('splits plain SQL, drops comments, and refuses $$ blocks', () => {
    const sql = '-- hello\nCREATE TABLE a (id INT);\n\n-- next\nALTER TABLE a ADD COLUMN b TEXT,\nADD COLUMN c TEXT;\n';
    expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id INT)', 'ALTER TABLE a ADD COLUMN b TEXT,\nADD COLUMN c TEXT']);
    expect(() => splitStatements('DO $$ BEGIN END $$;')).toThrow(MigrationError);
  });
});

describe('applyMigrations on an empty scratch database', () => {
  const name = `migtest_${crypto.randomBytes(5).toString('hex')}`;
  let scratch: PrismaClient;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.pathname = `/${name}`;
    scratch = new PrismaClient({ datasourceUrl: url.toString() });
  });

  afterAll(async () => {
    await scratch.$disconnect();
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });

  it('refuses a database that was never set up with migrations', async () => {
    await expect(applyMigrations(scratch)).rejects.toBeInstanceOf(MigrationError);
  });

  it('applies every migration once, records them, and does nothing the second time', async () => {
    await scratch.$executeRawUnsafe(
      `CREATE TABLE _prisma_migrations (id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`,
    );
    const dir = path.join(process.cwd(), 'prisma', 'migrations');
    const expected = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

    const applied = await applyMigrations(scratch, dir);
    expect(applied).toEqual(expected);

    const tables = await scratch.$queryRawUnsafe<Array<{ t: string }>>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
    expect(tables.map((r) => r.t)).toEqual(expect.arrayContaining(['tenants', 'users', 'roles', 'employees', 'grades']));

    const rows = await scratch.$queryRawUnsafe<Array<{ migration_name: string; checksum: string }>>('SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name');
    expect(rows.map((r) => r.migration_name)).toEqual(expected);
    // The checksum matches what Prisma computes (sha256 of the file), so `prisma migrate` accepts the record.
    const last = expected[expected.length - 1];
    expect(rows[rows.length - 1].checksum).toBe(checksumOf(fs.readFileSync(path.join(dir, last, 'migration.sql'), 'utf8')));

    expect(await applyMigrations(scratch, dir)).toEqual([]);
  });

  it('rolls a failed migration back completely and records nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const first = path.join(dir, '20990101000000_ok');
    fs.mkdirSync(first);
    fs.writeFileSync(path.join(first, 'migration.sql'), 'CREATE TABLE should_not_stay (id INT);\nSELECT * FROM table_that_does_not_exist;\n');
    // The scratch database already has migrations recorded from the real folder, so add the real ones to this temp folder
    const realDir = path.join(process.cwd(), 'prisma', 'migrations');
    for (const e of fs.readdirSync(realDir, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      fs.cpSync(path.join(realDir, e.name), path.join(dir, e.name), { recursive: true });
    }
    await expect(applyMigrations(scratch, dir)).rejects.toThrow();
    const left = await scratch.$queryRawUnsafe<Array<{ t: string }>>(`SELECT tablename AS t FROM pg_tables WHERE tablename = 'should_not_stay'`);
    expect(left).toEqual([]);
    const recorded = await scratch.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM _prisma_migrations WHERE migration_name LIKE '%_ok'`);
    expect(recorded[0].n).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
