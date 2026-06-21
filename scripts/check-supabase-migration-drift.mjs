#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIGRATION_VERSION_PATTERN = /^\d{14}$/;

export function parseMigrationListOutput(output) {
  return String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts.length >= 2)
    .map(([local, remote]) => ({
      local: MIGRATION_VERSION_PATTERN.test(local) ? local : '',
      remote: MIGRATION_VERSION_PATTERN.test(remote) ? remote : '',
    }))
    .filter((row) => row.local || row.remote);
}

export function summarizeMigrationDrift(rows) {
  const localOnly = [];
  const remoteOnly = [];
  let alignedCount = 0;

  for (const row of rows) {
    if (row.local && row.remote && row.local === row.remote) {
      alignedCount += 1;
      continue;
    }

    if (row.local) localOnly.push(row.local);
    if (row.remote) remoteOnly.push(row.remote);
  }

  return {
    localOnly,
    remoteOnly,
    alignedCount,
    hasDrift: localOnly.length > 0 || remoteOnly.length > 0,
  };
}

export function formatMigrationDrift(summary) {
  if (!summary.hasDrift) {
    return `Supabase migration history is aligned (${summary.alignedCount} migrations).`;
  }

  const lines = [
    'Supabase migration history drift detected.',
    `Aligned migrations: ${summary.alignedCount}`,
  ];

  if (summary.localOnly.length > 0) {
    lines.push(`Local only: ${summary.localOnly.join(', ')}`);
  }

  if (summary.remoteOnly.length > 0) {
    lines.push(`Remote only: ${summary.remoteOnly.join(', ')}`);
  }

  return lines.join('\n');
}

function main() {
  const result = spawnSync('supabase', ['migration', 'list', '--linked'], {
    encoding: 'utf8',
  });

  if (result.error) {
    console.error(`Failed to run Supabase CLI: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const summary = summarizeMigrationDrift(parseMigrationListOutput(result.stdout));
  const message = formatMigrationDrift(summary);

  if (summary.hasDrift) {
    console.error(message);
    process.exit(1);
  }

  console.log(message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
