import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('source tool catalog creation migration', () => {
  it('adds audited, rate-limited transactional catalog persistence', () => {
    const migrationsDirectory = path.join(process.cwd(), 'supabase', 'migrations');
    const migrationName = fs.readdirSync(migrationsDirectory)
      .find((name) => name.endsWith('_source_tool_catalog_creation.sql'));

    expect(migrationName).toBeDefined();

    const sql = fs.readFileSync(path.join(migrationsDirectory, migrationName!), 'utf8');
    expect(sql).toMatch(/created_by_user_id uuid/i);
    expect(sql).toMatch(/save_post_source_tools_with_catalog/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/interval '24 hours'/i);
    expect(sql).toMatch(/>= 10/);
    expect(sql).toMatch(/>= 30/);
    expect(sql).toMatch(/revoke all on function[\s\S]+from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function[\s\S]+to service_role/i);
  });
});
