import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { STORAGE_BUCKET_IDS } from '@/lib/storage-buckets';

/** Every bucket id a migration inserts into storage.buckets. */
function bucketsCreatedByMigrations(): Set<string> {
  const directory = path.resolve(process.cwd(), 'supabase/migrations');
  const ids = new Set<string>();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const insert of sql.matchAll(/insert\s+into\s+storage\.buckets\s*\(([^)]*)\)\s*values\s*\(\s*'([a-z0-9_-]+)'/gi)) {
      const columns = insert[1].split(',').map((column) => column.trim().toLowerCase());
      // The first value is the first column's: every insert names `id` first.
      expect(columns[0]).toBe('id');
      ids.add(insert[2]);
    }
  }
  return ids;
}

describe('the storage buckets', () => {
  it('lists every bucket the migrations create, and nothing else', () => {
    const created = bucketsCreatedByMigrations();

    expect(created.size).toBeGreaterThanOrEqual(11);
    expect([...STORAGE_BUCKET_IDS].sort()).toEqual([...created].sort());
  });
});
