import fs from 'node:fs/promises';
import path from 'node:path';

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();

if (!accessToken || !projectRef) {
  throw new Error(
    'SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.',
  );
}

const migrationsDirectory = path.resolve('supabase/migrations');
const migrationFilePattern = /^(\d{14})_(.+)\.sql$/;
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

const migrationFiles = (await fs.readdir(migrationsDirectory))
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

const appliedMigrations = await request('GET');
if (!Array.isArray(appliedMigrations)) {
  throw new Error('Supabase returned an invalid migration history response.');
}

const localNameCounts = migrationFiles.reduce((counts, migration) => {
  counts.set(migration.name, (counts.get(migration.name) ?? 0) + 1);
  return counts;
}, new Map());
const appliedVersions = new Set(
  appliedMigrations.map((migration) => migration.version),
);
const appliedNames = new Set(appliedMigrations.map((migration) => migration.name));
const isApplied = (migration, versions, names) =>
  versions.has(migration.version) ||
  (localNameCounts.get(migration.name) === 1 && names.has(migration.name));
const localVersionByName = new Map(
  migrationFiles
    .filter((migration) => localNameCounts.get(migration.name) === 1)
    .map((migration) => [migration.name, migration.version]),
);
const latestAppliedLocalVersion = appliedMigrations.reduce(
  (latest, migration) => {
    const exactLocalMigration = migrationFiles.find(
      (localMigration) => localMigration.version === migration.version,
    );
    const localVersion =
      exactLocalMigration?.version ?? localVersionByName.get(migration.name);
    return localVersion && localVersion > latest ? localVersion : latest;
  },
  '',
);
const pendingMigrations = migrationFiles.filter(
  (migration) => !isApplied(migration, appliedVersions, appliedNames),
);

const outOfOrderMigration = pendingMigrations.find(
  (migration) =>
    latestAppliedLocalVersion &&
    migration.version <= latestAppliedLocalVersion,
);

if (outOfOrderMigration) {
  throw new Error(
    `Refusing to apply out-of-order migration ${outOfOrderMigration.fileName}.`,
  );
}

if (pendingMigrations.length === 0) {
  console.log('Supabase migration history is already current.');
  process.exit(0);
}

console.log(`Applying ${pendingMigrations.length} pending migration(s).`);

for (const migration of pendingMigrations) {
  const query = await fs.readFile(
    path.join(migrationsDirectory, migration.fileName),
    'utf8',
  );

  await request('POST', {
    name: migration.name,
    query,
  });
  console.log(`Applied ${migration.fileName}.`);
}

const verifiedMigrations = await request('GET');
const verifiedVersions = new Set(
  verifiedMigrations.map((migration) => migration.version),
);
const verifiedNames = new Set(
  verifiedMigrations.map((migration) => migration.name),
);
const missingNames = pendingMigrations
  .filter(
    (migration) =>
      !isApplied(migration, verifiedVersions, verifiedNames),
  )
  .map((migration) => migration.name);

if (missingNames.length > 0) {
  throw new Error('Supabase migration history verification failed.');
}

console.log('Supabase migration history verified.');
