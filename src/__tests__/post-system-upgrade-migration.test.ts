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
const visibilityAmbiguityMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260516100000_fix_post_bundle_cleanup_column_qualification.sql'
);
const resourceItemsMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260529083033_post_resource_items_and_smart_remix.sql'
);
const resourceSectionsMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260529144943_post_resource_sections.sql'
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

  it('qualifies post visibility references inside bundle transaction functions', () => {
    const migration = fs.readFileSync(visibilityAmbiguityMigrationPath, 'utf8');

    expect(migration).toContain('INSERT INTO public.posts AS target');
    expect(migration).toContain('RETURNING target.id, target.visibility INTO v_result_post_id, v_result_visibility');
    expect(migration).toContain("SET visibility = CASE WHEN v_patch ? 'visibility' THEN v_patch->>'visibility' ELSE target.visibility END");
    expect(migration).toContain('RETURNING target.id, target.visibility, target.title INTO v_result_post_id, v_result_visibility, v_result_title');
    expect(migration).toContain('UPDATE public.post_resource_bundles AS bundles');
    expect(migration).toContain('WHERE bundles.post_id = v_result_post_id');
    expect(migration).toContain('UPDATE public.marketplace_assets AS assets');
    expect(migration).toContain('WHERE assets.post_id = v_result_post_id');
    expect(migration).not.toContain('RETURNING id, visibility');
    expect(migration).not.toContain('WHERE post_id = v_result_post_id');
  });

  it('adds canonical resource items with a legacy bundle backfill', () => {
    const migration = fs.readFileSync(resourceItemsMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS resource_items jsonb');
    expect(migration).toContain('post_resource_bundles_resource_items_array_check');
    expect(migration).toContain('public.build_post_resource_items_from_legacy_bundle');
    expect(migration).toContain("jsonb_build_object('type', 'prompt'");
    expect(migration).toContain("jsonb_build_object('type', 'workflow'");
    expect(migration).toContain("jsonb_build_object('type', 'remix_access'");
    expect(migration).toContain("resource_items = public.build_post_resource_items_from_legacy_bundle");
    expect(migration).toContain("v_resource_items := coalesce(v_resources->'items', '[]'::jsonb)");
  });

  it('adds optional resource sections to bundle storage and write validation', () => {
    const migration = fs.readFileSync(resourceSectionsMigrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS resource_sections jsonb');
    expect(migration).toContain('post_resource_bundles_resource_sections_array_check');
    expect(migration).toContain("v_resource_sections := coalesce(v_resources->'sections', '[]'::jsonb)");
    expect(migration).toContain('resource_sections,');
    expect(migration).toContain('resource_sections = EXCLUDED.resource_sections');
    expect(migration).toContain("item->>'sectionId'");
    expect(migration).toContain('Resource item sectionId must reference an existing resource section');
    expect(migration).toContain('resource_sections jsonb');
    expect(migration).toContain('bundles.resource_sections');
  });
});
