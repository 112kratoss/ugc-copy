import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const migrationsDirectory = path.join(projectRoot, 'supabase', 'migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_restrict_backend_owned_rpcs.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('backend-owned RPC security migration', () => {
  it('keeps mutation and marketplace RPCs callable only by the service role', () => {
    expect(migrationName).toBeDefined();

    const signatures = [
      'apply_post_resource_bundle_mutation\\(uuid, uuid, text, text, jsonb\\)',
      'handle_new_user\\(\\)',
      'increment_post_remix_count\\(uuid\\)',
      'increment_remix_count\\(uuid\\)',
      'list_marketplace_resource_bundles\\(text, text, text, text, text, integer, integer\\)',
      'list_marketplace_resource_bundles\\(text, text, text, text, integer, integer\\)',
      'publish_generation_post_with_resource_bundle\\(uuid, uuid, jsonb, jsonb, jsonb, boolean\\)',
      'set_post_save_state\\(uuid, uuid, boolean\\)',
      'toggle_post_save\\(uuid, uuid\\)',
      'toggle_showcase_save\\(uuid, uuid\\)',
      'update_post_with_resource_bundle\\(uuid, uuid, jsonb, boolean, jsonb\\)',
      'upsert_post_with_resource_bundle\\(jsonb, jsonb, boolean\\)',
      'validate_post_report_bundle_match\\(\\)',
    ];

    for (const signature of signatures) {
      expect(migration).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated`,
        'i'
      ));
      expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`,
        'i'
      ));
    }
  });

  it('pins trigger helper search paths', () => {
    expect(migration).toMatch(/ALTER FUNCTION public\.touch_updated_at_column\(\)[\s\S]*SET search_path = public, pg_temp/i);
    expect(migration).toMatch(/ALTER FUNCTION public\.increment_post_report_count\(\)[\s\S]*SET search_path = public, pg_temp/i);
    expect(migration).toMatch(/ALTER FUNCTION public\.validate_post_resource_bundle_write\(\)[\s\S]*SET search_path = public, pg_temp/i);
  });

  it('routes save and remix mutations through the service client', () => {
    const saveRoute = fs.readFileSync(
      path.join(projectRoot, 'src/app/api/showcase/save/route.ts'),
      'utf8'
    );
    const remixRoute = fs.readFileSync(
      path.join(projectRoot, 'src/app/api/showcase/remix/route.ts'),
      'utf8'
    );

    expect(saveRoute).toContain("serviceClient.rpc('set_post_save_state'");
    expect(saveRoute).toContain("serviceClient.rpc('toggle_post_save'");
    expect(saveRoute).toContain("serviceClient.rpc('toggle_showcase_save'");
    expect(remixRoute).toContain("adminSupabase.rpc('increment_post_remix_count'");
  });
});
