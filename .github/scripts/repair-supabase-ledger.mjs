// Make production's migration ledger reproduce the repository.
//
// Production records every applied migration in
// `supabase_migrations.schema_migrations` as (version, name, statements).
// A Supabase preview branch is built by replaying *those recorded statements*,
// not the files in this repository — so the ledger, not `supabase/migrations`,
// is what decides whether the history can rebuild the database.
//
// Production's ledger cannot:
//   * nine rows carry NULL statements, including the base `remote_schema`,
//     because they were marked applied rather than applied through the CLI.
//     `supabase migration repair` records a version and a name and nothing
//     else, which is exactly how a row ends up building nothing.
//   * `20260317090245_showcase_security_and_backfill` recorded a backfill
//     against `generations.category`, a column the recorded history only
//     creates one migration later, so a replay halts there.
//
// Both are the same defect: the ledger drifted away from the files. This
// rewrites every row from the file that produced it, so replaying the ledger
// and replaying the repository are the same operation — and `db reset --local`
// already proves the repository replays.
//
// It runs over the Management API rather than the Postgres wire protocol
// because no database password exists in this repository's secrets, so
// `supabase migration repair` cannot authenticate from CI or from a developer
// machine. The API path is the one `apply-supabase-migrations.mjs` already
// uses to release.
//
// Nothing here executes migration SQL. It only rewrites the bookkeeping rows
// that record which migrations ran, so production's schema is untouched.
//
// Usage:
//   node .github/scripts/repair-supabase-ledger.mjs            # report only
//   node .github/scripts/repair-supabase-ledger.mjs --apply    # rewrite
//   node .github/scripts/repair-supabase-ledger.mjs --verify   # re-check

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();

if (!accessToken || !projectRef) {
  throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.');
}

const shouldApply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');
const migrationsDirectory = path.resolve('supabase/migrations');
const migrationFilePattern = /^(\d{14})_(.+)\.sql$/;
const queryUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/database/query`;

// The endpoint rejects oversized bodies, and the whole corpus is ~1.4 MB, so
// inserts are batched. Every batch is idempotent against the staging table,
// which means a failed run can simply be run again.
const MAX_BATCH_BYTES = 300_000;

async function query(sql) {
  const response = await fetch(queryUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Management API query failed (${response.status}): ${text.slice(0, 600)}`);
  }

  return text ? JSON.parse(text) : null;
}

// standard_conforming_strings is on, so a backslash is a literal backslash and
// only the quote needs doubling. Dollar quoting is unusable here because the
// migrations are full of `$$` function bodies.
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

const digestOf = (sql) => crypto.createHash('md5').update(sql, 'utf8').digest('hex');

async function readDesiredLedger() {
  const fileNames = (await fs.readdir(migrationsDirectory)).filter((name) =>
    migrationFilePattern.test(name),
  );

  const migrations = await Promise.all(
    fileNames.map(async (fileName) => {
      const [, version, name] = migrationFilePattern.exec(fileName);
      const sql = await fs.readFile(path.join(migrationsDirectory, fileName), 'utf8');
      return { fileName, version, name, sql, digest: digestOf(sql) };
    }),
  );

  migrations.sort((left, right) => left.version.localeCompare(right.version));

  const duplicates = migrations.filter(
    (migration, index) => index > 0 && migrations[index - 1].version === migration.version,
  );
  if (duplicates.length > 0) {
    throw new Error(`Duplicate migration versions: ${duplicates.map((d) => d.version).join(', ')}`);
  }

  return migrations;
}

async function readCurrentLedger() {
  // array_to_string over a single-element array returns that element, so this
  // digest is directly comparable to the digest of the file once repaired.
  const rows = await query(`
    select version,
           coalesce(name, '') as name,
           case when statements is null then '' else md5(array_to_string(statements, '')) end as digest,
           (statements is null) as null_statements
    from supabase_migrations.schema_migrations
    order by version;
  `);
  return Array.isArray(rows) ? rows : [];
}

function describeDrift(desired, current) {
  const currentByVersion = new Map(current.map((row) => [row.version, row]));
  const desiredByVersion = new Map(desired.map((row) => [row.version, row]));

  const versionMissingFromLedger = desired.filter((row) => !currentByVersion.has(row.version));
  const versionOnlyInLedger = current.filter((row) => !desiredByVersion.has(row.version));
  const nameDrift = [];
  const statementDrift = [];
  const nullStatements = current.filter((row) => row.null_statements);

  for (const row of desired) {
    const found = currentByVersion.get(row.version);
    if (!found) continue;
    if (found.name !== row.name) nameDrift.push(`${row.version}: ${found.name} -> ${row.name}`);
    if (found.digest !== row.digest) statementDrift.push(`${row.version}_${row.name}`);
  }

  return {
    versionMissingFromLedger,
    versionOnlyInLedger,
    nameDrift,
    statementDrift,
    nullStatements,
    clean:
      versionMissingFromLedger.length === 0 &&
      versionOnlyInLedger.length === 0 &&
      nameDrift.length === 0 &&
      statementDrift.length === 0,
  };
}

function report(drift, desired, current) {
  console.log(`Repository migrations: ${desired.length}`);
  console.log(`Ledger rows:           ${current.length}`);
  console.log(`Rows with NULL statements: ${drift.nullStatements.length}`);
  console.log('');

  const section = (title, items, format = (item) => item) => {
    console.log(`${title}: ${items.length}`);
    for (const item of items.slice(0, 12)) console.log(`  ${format(item)}`);
    if (items.length > 12) console.log(`  ... and ${items.length - 12} more`);
  };

  section('Versions in the repository but not the ledger', drift.versionMissingFromLedger, (m) => m.fileName);
  section('Versions in the ledger but not the repository', drift.versionOnlyInLedger, (r) => `${r.version}_${r.name}`);
  section('Rows whose recorded name differs', drift.nameDrift);
  section('Rows whose recorded statements differ', drift.statementDrift);
}

async function writeStagingTable(desired) {
  await query(`
    drop table if exists supabase_migrations.schema_migrations_rebuild;
    create table supabase_migrations.schema_migrations_rebuild (
      version text primary key,
      name text,
      statements text[]
    );
  `);

  let batch = [];
  let batchBytes = 0;
  let written = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await query(
      `insert into supabase_migrations.schema_migrations_rebuild (version, name, statements) values\n` +
        batch.join(',\n') +
        `\non conflict (version) do update set name = excluded.name, statements = excluded.statements;`,
    );
    written += batch.length;
    console.log(`  staged ${written}/${desired.length}`);
    batch = [];
    batchBytes = 0;
  };

  for (const migration of desired) {
    // One element holding the whole file. Splitting a file into statements is
    // what a `$$`-quoted function body defeats, and no migration here uses
    // explicit transaction control or CREATE INDEX CONCURRENTLY, so a file
    // replays correctly as a single multi-statement batch.
    const row = `(${literal(migration.version)}, ${literal(migration.name)}, array[${literal(migration.sql)}]::text[])`;
    if (batchBytes + row.length > MAX_BATCH_BYTES) await flush();
    batch.push(row);
    batchBytes += row.length;
  }

  await flush();
}

async function verifyAgainstRepository(desired, table) {
  const rows = await query(`
    select version,
           coalesce(name, '') as name,
           case when statements is null then '' else md5(array_to_string(statements, '')) end as digest
    from ${table}
    order by version;
  `);

  const byVersion = new Map(rows.map((row) => [row.version, row]));
  const problems = [];

  if (rows.length !== desired.length) {
    problems.push(`row count ${rows.length} != ${desired.length}`);
  }

  for (const migration of desired) {
    const row = byVersion.get(migration.version);
    if (!row) {
      problems.push(`missing ${migration.fileName}`);
      continue;
    }
    if (row.name !== migration.name) problems.push(`name ${migration.version}: ${row.name}`);
    if (row.digest !== migration.digest) problems.push(`statements ${migration.fileName}`);
  }

  return problems;
}

const desired = await readDesiredLedger();
const current = await readCurrentLedger();
const drift = describeDrift(desired, current);

report(drift, desired, current);

if (verifyOnly) {
  const problems = await verifyAgainstRepository(desired, 'supabase_migrations.schema_migrations');
  if (problems.length > 0) {
    console.error('\nLedger does not reproduce the repository:');
    for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log('\nLedger reproduces the repository exactly.');
  process.exit(0);
}

if (drift.clean) {
  console.log('\nLedger already reproduces the repository; nothing to repair.');
  process.exit(0);
}

if (!shouldApply) {
  console.log('\nRun with --apply to rewrite the ledger.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const backupTable = `supabase_migrations.schema_migrations_backup_${stamp}`;

console.log(`\nBacking the current ledger up to ${backupTable}`);
await query(`create table ${backupTable} as select * from supabase_migrations.schema_migrations;`);

console.log('Staging the rebuilt ledger');
await writeStagingTable(desired);

const stagingProblems = await verifyAgainstRepository(desired, 'supabase_migrations.schema_migrations_rebuild');
if (stagingProblems.length > 0) {
  console.error('Staged ledger does not match the repository; leaving production untouched:');
  for (const problem of stagingProblems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('Staged ledger matches the repository.');

// A multi-statement simple query runs inside one implicit transaction, so the
// live ledger is never observed empty and a failure rolls the swap back whole.
console.log('Swapping the rebuilt ledger in');
await query(`
  delete from supabase_migrations.schema_migrations;
  insert into supabase_migrations.schema_migrations (version, name, statements)
    select version, name, statements from supabase_migrations.schema_migrations_rebuild;
  drop table supabase_migrations.schema_migrations_rebuild;
`);

const finalProblems = await verifyAgainstRepository(desired, 'supabase_migrations.schema_migrations');
if (finalProblems.length > 0) {
  console.error(`Repair failed verification. The previous ledger is still in ${backupTable}:`);
  for (const problem of finalProblems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`\nLedger repaired: ${desired.length} rows now reproduce the repository.`);
console.log(`Previous ledger retained in ${backupTable}.`);
