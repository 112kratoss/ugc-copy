import { describe, expect, it } from 'vitest';

import {
  formatMigrationDrift,
  parseMigrationListOutput,
  summarizeMigrationDrift,
} from '../../scripts/check-supabase-migration-drift.mjs';

describe('Supabase migration drift checker', () => {
  it('detects migrations that exist locally but are missing from remote history', () => {
    const rows = parseMigrationListOutput(`
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260621085846 | 20260621085846 | 2026-06-21 08:58:46
   20260621201100 |                | 2026-06-21 20:11:00
`);

    const summary = summarizeMigrationDrift(rows);

    expect(summary).toEqual({
      localOnly: ['20260621201100'],
      remoteOnly: [],
      alignedCount: 1,
      hasDrift: true,
    });
    expect(formatMigrationDrift(summary)).toContain('Local only: 20260621201100');
  });

  it('detects migrations that exist remotely but are missing locally', () => {
    const rows = parseMigrationListOutput(`
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
                  | 20260622010101 | 2026-06-22 01:01:01
   20260622020202 | 20260622020202 | 2026-06-22 02:02:02
`);

    const summary = summarizeMigrationDrift(rows);

    expect(summary).toMatchObject({
      localOnly: [],
      remoteOnly: ['20260622010101'],
      alignedCount: 1,
      hasDrift: true,
    });
    expect(formatMigrationDrift(summary)).toContain('Remote only: 20260622010101');
  });

  it('reports clean migration history when local and remote versions align', () => {
    const rows = parseMigrationListOutput(`
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260621085846 | 20260621085846 | 2026-06-21 08:58:46
`);

    const summary = summarizeMigrationDrift(rows);

    expect(summary).toEqual({
      localOnly: [],
      remoteOnly: [],
      alignedCount: 1,
      hasDrift: false,
    });
    expect(formatMigrationDrift(summary)).toBe('Supabase migration history is aligned (1 migrations).');
  });
});
