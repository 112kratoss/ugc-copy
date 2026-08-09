import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseMigrationFileNames,
  planMigrations,
} from '../../.github/scripts/apply-supabase-migrations.mjs';

// Finding C's repair rewrites production's migration ledger. The release path
// reads that same ledger to decide what is still pending, so the two have to be
// reasoned about together: a ledger that disagrees with the repository is how a
// release re-applies history production already has. These tests pin the
// ordering rule that makes the repair safe to run.

// The release script is plain ESM with no declarations, so the shapes it hands
// back are named here rather than inferred as `any`.
type LedgerRow = { version: string; name: string };
type MigrationFile = LedgerRow & { fileName: string };
type Plan = { pending: MigrationFile[]; outOfOrder: MigrationFile | null };

const plan = (input: {
  migrationFiles: MigrationFile[];
  appliedMigrations: LedgerRow[];
}): Plan => planMigrations(input) as Plan;

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const repositoryMigrations: MigrationFile[] = parseMigrationFileNames(
  fs.readdirSync(migrationsDirectory),
);

/** The ledger as it would read once every row carries its own file's version. */
const repairedLedger = (): LedgerRow[] =>
  repositoryMigrations.map(({ version, name }): LedgerRow => ({ version, name }));

/**
 * The ledger as production actually holds it today: everything released through
 * the Management API is filed under a version the API generated, because
 * `POST /database/migrations` takes a name and a query and never the version.
 */
const driftedLedger = (driftCount: number): LedgerRow[] =>
  repositoryMigrations.map(({ version, name }, index): LedgerRow =>
    index >= repositoryMigrations.length - driftCount
      ? { version: `2026080914${String(5000 + index).padStart(4, '0')}`, name }
      : { version, name },
  );

describe('supabase migration ledger ordering', () => {
  it('reads the real migration history', () => {
    expect(repositoryMigrations.length).toBeGreaterThan(150);
    expect(repositoryMigrations[0].name).toBe('remote_schema');
  });

  it('applies nothing when the ledger already carries every file version', () => {
    const { pending, outOfOrder } = plan({
      migrationFiles: repositoryMigrations,
      appliedMigrations: repairedLedger(),
    });

    expect(pending).toEqual([]);
    expect(outOfOrder).toBeNull();
  });

  it('applies nothing against the drifted ledger the repair replaces', () => {
    // This is the state production is in before the repair. It survives only
    // because every drifted row's name happens to be unique in the repository.
    const { pending } = plan({
      migrationFiles: repositoryMigrations,
      appliedMigrations: driftedLedger(30),
    });

    expect(pending).toEqual([]);
  });

  it('cannot recognise a drifted row whose name repeats', () => {
    // `remote_schema` is used four times, so the name fallback is switched off
    // for it and only a matching version can mark it applied. A drifted version
    // on one of those rows would make a release try to re-run the base schema —
    // which is the exposure the repair removes by restoring file versions.
    const repeated = repositoryMigrations.filter((migration: MigrationFile) => migration.name === 'remote_schema');
    expect(repeated.length).toBeGreaterThan(1);

    const ledgerWithDriftedBase = repairedLedger().map((row: LedgerRow): LedgerRow =>
      row.version === repeated[0].version ? { ...row, version: '20260101000000' } : row,
    );

    const { pending } = plan({
      migrationFiles: repositoryMigrations,
      appliedMigrations: ledgerWithDriftedBase,
    });

    expect(pending.map((migration: MigrationFile) => migration.fileName)).toEqual([repeated[0].fileName]);
  });

  it('refuses rather than re-applies when a repaired ledger runs ahead of the checkout', () => {
    // The ordering hazard the repair workflow guards against: the ledger was
    // rewritten from a newer main than the one being released. The release must
    // fail closed, not replay migrations production already has.
    const behindByTen = repositoryMigrations.slice(0, repositoryMigrations.length - 10);

    const { outOfOrder } = plan({
      migrationFiles: behindByTen,
      appliedMigrations: repairedLedger().map((row: LedgerRow, index: number): LedgerRow =>
        index < 5 ? { version: `2027010100000${index}`, name: `unknown_${index}` } : row,
      ),
    });

    expect(outOfOrder).not.toBeNull();
  });

  it('still applies a genuinely new migration after the repair', () => {
    const withNewMigration: MigrationFile[] = [
      ...repositoryMigrations,
      { fileName: '20270101000000_new_thing.sql', version: '20270101000000', name: 'new_thing' },
    ];

    const { pending, outOfOrder } = plan({
      migrationFiles: withNewMigration,
      appliedMigrations: repairedLedger(),
    });

    expect(pending.map((migration: MigrationFile) => migration.fileName)).toEqual([
      '20270101000000_new_thing.sql',
    ]);
    expect(outOfOrder).toBeNull();
  });

  it('refuses a migration back-dated behind what the ledger already applied', () => {
    const backDated: MigrationFile[] = [
      ...repositoryMigrations,
      { fileName: '20260101000000_back_dated.sql', version: '20260101000000', name: 'back_dated' },
    ];

    const { outOfOrder } = plan({
      migrationFiles: backDated,
      appliedMigrations: repairedLedger(),
    });

    expect(outOfOrder?.fileName).toBe('20260101000000_back_dated.sql');
  });
});
