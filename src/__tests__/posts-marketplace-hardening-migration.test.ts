import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260406173000_harden_posts_marketplace_security.sql'
);

describe('posts + marketplace hardening migration', () => {
  it('locks raw post activity reads behind the new visibility contract', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE POLICY "Users can view their own post saves"');
    expect(migration).not.toContain('CREATE POLICY "Post share events are viewable by everyone"');
    expect(migration).toContain('DROP POLICY IF EXISTS "Post share events are viewable by everyone"');
  });

  it('makes marketplace purchase accounting conditional on a newly inserted entitlement row', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('ON CONFLICT (asset_id, buyer_user_id) DO NOTHING');
    expect(migration).toContain('RETURNING id INTO v_purchase_id;');
    expect(migration).toContain('IF v_purchase_id IS NULL THEN');
    expect(migration).toContain('SET sales_count = sales_count + 1,');
  });
});
