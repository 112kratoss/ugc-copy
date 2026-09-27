import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260927043620_preserve_projection_client_contracts.sql'), 'utf8');

describe('projection client contract replay', () => {
  it('states the three existing authenticated ACLs instead of inheriting defaults', () => {
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage_events,\n  public.source_tools, public.source_tool_models TO authenticated');
    expect(migration).not.toMatch(/GRANT[^;]+TO (?:PUBLIC|anon)/);
    expect(migration).toContain('GRANT SELECT ON TABLE public.generation_input_media TO authenticated');
  });
  it.each(['ai_usage_events', 'source_tools', 'source_tool_models', 'generation_input_media'])(
    'restates the restrictive active-session gate for %s', (table) => {
      expect(migration).toContain(`CREATE POLICY authenticated_identity_active\nON public.${table} AS RESTRICTIVE FOR ALL TO authenticated`);
    },
  );
  it('does not add permissive mutation policies or rewrite customer records', () => {
    expect(migration.match(/WITH CHECK \(\(SELECT public.current_identity_is_active\(\)\)\)/g)).toHaveLength(4);
    expect(migration).not.toMatch(/AS PERMISSIVE|FOR INSERT|FOR UPDATE|FOR DELETE|DELETE FROM|UPDATE public|INSERT INTO/);
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
  });
});
