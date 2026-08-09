import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationFilePattern = /^(\d{14})_(.+)\.sql$/;

export function parseMigrationFileNames(fileNames) {
  return fileNames
    .map((fileName) => {
      const match = migrationFilePattern.exec(fileName);
      if (!match) {
        return null;
      }

      return {
        fileName,
        version: match[1],
        name: match[2],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.version.localeCompare(right.version));
}

/**
 * Decide what a release still has to apply.
 *
 * A migration counts as applied when the ledger holds its version, or — only
 * when the name is unambiguous in the repository — when the ledger holds its
 * name. The name fallback exists because migrations applied through the
 * Management API are recorded under a version the API generates rather than
 * the one in the file name, so the ledger's versions can drift away from the
 * repository's while describing the same history.
 *
 * That fallback is a safety net, not a foundation: it cannot help a name that
 * repeats (`remote_schema` appears four times), so a ledger whose versions
 * have drifted is one rename away from a release re-applying history
 * production already has. Repairing the ledger to carry the repository's own
 * versions is what removes that exposure.
 */
export function planMigrations({ migrationFiles, appliedMigrations, candidates = migrationFiles }) {
  const localNameCounts = migrationFiles.reduce((counts, migration) => {
    counts.set(migration.name, (counts.get(migration.name) ?? 0) + 1);
    return counts;
  }, new Map());

  const appliedVersions = new Set(appliedMigrations.map((migration) => migration.version));
  const appliedNames = new Set(appliedMigrations.map((migration) => migration.name));

  const isApplied = (migration) =>
    appliedVersions.has(migration.version) ||
    (localNameCounts.get(migration.name) === 1 && appliedNames.has(migration.name));

  const localVersionByName = new Map(
    migrationFiles
      .filter((migration) => localNameCounts.get(migration.name) === 1)
      .map((migration) => [migration.name, migration.version]),
  );

  const latestAppliedLocalVersion = appliedMigrations.reduce((latest, migration) => {
    const exactLocalMigration = migrationFiles.find(
      (localMigration) => localMigration.version === migration.version,
    );
    const localVersion = exactLocalMigration?.version ?? localVersionByName.get(migration.name);
    return localVersion && localVersion > latest ? localVersion : latest;
  }, '');

  // `candidates` defaults to the whole repository. The post-apply check narrows
  // it to the migrations this run applied, while name uniqueness stays scoped
  // to every file — the same scoping the pre-apply pass used.
  const pending = candidates.filter((migration) => !isApplied(migration));

  const outOfOrder = pending.find(
    (migration) => latestAppliedLocalVersion && migration.version <= latestAppliedLocalVersion,
  );

  return { pending, outOfOrder: outOfOrder ?? null, latestAppliedLocalVersion };
}

async function main() {
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();

  if (!accessToken || !projectRef) {
    throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.');
  }

  const migrationsDirectory = path.resolve('supabase/migrations');
  const apiUrl = `https://api.supabase.com/v1/projects/${encodeURIComponent(
    projectRef,
  )}/database/migrations`;

  async function request(method, body) {
    const response = await fetch(apiUrl, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `Supabase migration API ${method} failed with status ${response.status}.`,
      );
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  const migrationFiles = parseMigrationFileNames(await fs.readdir(migrationsDirectory));

  const appliedMigrations = await request('GET');
  if (!Array.isArray(appliedMigrations)) {
    throw new Error('Supabase returned an invalid migration history response.');
  }

  const { pending, outOfOrder } = planMigrations({ migrationFiles, appliedMigrations });

  if (outOfOrder) {
    throw new Error(`Refusing to apply out-of-order migration ${outOfOrder.fileName}.`);
  }

  if (pending.length === 0) {
    console.log('Supabase migration history is already current.');
    return;
  }

  console.log(`Applying ${pending.length} pending migration(s).`);

  for (const migration of pending) {
    const query = await fs.readFile(
      path.join(migrationsDirectory, migration.fileName),
      'utf8',
    );

    await request('POST', { name: migration.name, query });
    console.log(`Applied ${migration.fileName}.`);
  }

  const verifiedMigrations = await request('GET');
  const stillPending = planMigrations({
    migrationFiles,
    appliedMigrations: verifiedMigrations,
    candidates: pending,
  }).pending;

  if (stillPending.length > 0) {
    throw new Error('Supabase migration history verification failed.');
  }

  console.log('Supabase migration history verified.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
