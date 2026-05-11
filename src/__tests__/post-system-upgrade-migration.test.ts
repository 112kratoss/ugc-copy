import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260508120000_post_system_marketplace_reliability.sql'
);
const qualityMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260509054316_marketplace_quality_search.sql'
);

describe('post system marketplace reliability migration', () => {
  it('adds transactional publish functions for posts and generation-backed posts', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.upsert_post_with_resource_bundle');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.update_post_with_resource_bundle');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.publish_generation_post_with_resource_bundle');
    expect(migration).toContain('public.apply_post_resource_bundle_mutation');
  });

  it('filters public unlock listings through linked visible posts in SQL', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles');
    expect(migration).toContain('JOIN public.posts posts ON posts.id = bundles.post_id');
    expect(migration).toContain("coalesce(posts.review_status, 'visible') <> 'hidden'");
    expect(migration).toContain('p_resource_filter = \'prompt\'');
  });

  it('enforces resource content and safe attachment ownership in the database', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.validate_post_resource_bundle_write');
    expect(migration).toContain('Add content for at least one unlock item before publishing');
    expect(migration).toContain('Workflow links must start with http:// or https://');
    expect(migration).toContain('Uploaded unlock files must belong to the creator publishing this post');
  });

  it('adds marketplace quality filtering, search, and price sorting', () => {
    const migration = fs.readFileSync(qualityMigrationPath, 'utf8');

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.marketplace_resource_bundle_quality_issue');
    expect(migration).toContain('Improve this unlock before publishing');
    expect(migration).toContain('p_query text DEFAULT NULL');
    expect(migration).toContain("p_sort = 'price-low'");
    expect(migration).toContain("p_sort = 'price-high'");
    expect(migration).toContain('profiles.username');
    expect(migration).toContain('marketplace_resource_bundle_quality_issue');
  });
});
