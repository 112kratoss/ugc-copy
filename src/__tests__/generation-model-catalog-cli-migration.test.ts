import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260724090000_generation_model_catalog_schema_v2.sql',
);
const scriptPath = path.resolve(
  process.cwd(),
  'scripts/generation-model-catalog.ts',
);
const manifestPath = path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const script = fs.readFileSync(scriptPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
  entries: Array<{
    publicDescriptor: unknown;
    adapterConfig: unknown;
    providerModelMap: unknown;
    pricingConfig: unknown;
  }>;
};

describe('generation-model catalog v2 release migration', () => {
  it('adds private adapter configuration and v2 strategy allowlists', () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb",
    );
    expect(migration).toContain("'kie-task-v1'");
    expect(migration).toContain("'reference-adjustment'");
    expect(migration).toContain("'descriptor-rules-v1'");
  });

  it('allows only one globally active authoritative release', () => {
    expect(migration).toContain('DROP INDEX IF EXISTS public.generation_model_catalog_one_active_idx');
    expect(migration).toContain(
      "ON public.generation_model_catalog_releases ((status))\n  WHERE status = 'active'",
    );
    expect(migration).not.toContain(
      "ON public.generation_model_catalog_releases ((schema_version))\n  WHERE status = 'active'",
    );
  });

  it('stages and validates a complete manifest atomically', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.stage_generation_model_catalog(',
    );
    expect(migration).toContain(
      'PERFORM public.validate_generation_model_catalog_release(new_release_id);',
    );
    expect(migration).toContain(
      "IF active_revision IS DISTINCT FROM p_expected_active_revision THEN",
    );
    expect(migration).toContain(
      'public.generation_model_catalog_has_negative_number(entry.pricing_config)',
    );
    expect(migration).toContain("entry.adapter_config ? 'endpoint'");
    expect(migration).toContain("rule ->> 'type' = 'control-options'");
    expect(migration).toContain("NULLIF(rule ->> 'key', '') IS NULL");
    expect(migration).toContain("jsonb_typeof(rule -> 'options') IS DISTINCT FROM 'array'");
    expect(migration).toContain(
      "mode_value.value ->> 'key',\n        slot_value.value ->> 'key'",
    );
    expect(migration).not.toContain("rule ->> 'control'");
    expect(migration).not.toContain("rule -> 'values'");
  });

  it('publishes and rolls back with optimistic revision guards', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.publish_generation_model_catalog(',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.rollback_generation_model_catalog(',
    );
    expect(migration.match(/The active catalog revision changed/g)?.length)
      .toBeGreaterThanOrEqual(3);
  });

  it('keeps every release mutation RPC restricted to service_role', () => {
    for (const signature of [
      'public.stage_generation_model_catalog(jsonb, text)',
      'public.publish_generation_model_catalog(uuid, text)',
      'public.rollback_generation_model_catalog(text, text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}`);
    }
  });

  it('defaults to dry-run and requires exact confirmations in the CLI', () => {
    expect(script).toContain("status: 'dry-run'");
    expect(script).toContain("flags.get('--apply') !== true");
    expect(script).toContain("'--confirm-revision'");
    expect(script).toContain("'--expected-active'");
  });

  it('keeps private provider and pricing data outside public descriptors', () => {
    for (const entry of manifest.entries) {
      const publicDescriptor = JSON.stringify(entry.publicDescriptor);
      expect(publicDescriptor).not.toContain('bytedance/seedance-2');
      expect(publicDescriptor).not.toContain('/api/v1/jobs/createTask');
      expect(publicDescriptor).not.toContain('"rates"');

      expect(JSON.stringify(entry.adapterConfig)).toContain('reference_video_urls');
      expect(JSON.stringify(entry.providerModelMap)).toContain('bytedance/seedance-2');
      expect(JSON.stringify(entry.pricingConfig)).toContain('"1080p":102');
    }
  });
});
