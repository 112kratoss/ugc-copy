import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260830123000_completed_post_remixes.sql',
), 'utf8');

// Runtime counting/replay/permissions are exercised by the companion pgTAP
// suite. These guards pin the historical-data and mixed-version rollout policy.
describe('completed post remixes migration', () => {
  it('archives the previous metric before rebuilding it from known lineage', () => {
    const archive = migration.indexOf('SET legacy_remix_start_count = remix_count');
    const rebuild = migration.indexOf('UPDATE public.posts p SET remix_count');
    expect(archive).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(archive);
    expect(migration).toContain('JOIN public.generations source ON source.id = g.source_generation_id');
  });

  it('does not send new-remix notifications for historical completions', () => {
    const backfill = migration.slice(
      migration.indexOf('INSERT INTO public.completed_post_remixes'),
      migration.indexOf('UPDATE public.posts p SET remix_count'),
    );
    expect(backfill).toContain('notification_eligible)');
    expect(backfill).toContain('coalesce(g.completed_at, g.created_at), false');
  });

  it('takes the visible count back down when a counted remix is deleted', () => {
    // Both foreign keys cascade, and the reconciling rebuild only runs once.
    expect(migration).toContain('AFTER DELETE ON public.completed_post_remixes');
    expect(migration).toContain('remix_count = greatest(remix_count - 1, 0)');
  });

  it('preserves the legacy void RPC while making editor starts a no-op', () => {
    const legacyRpc = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.increment_post_remix_count'));
    expect(legacyRpc).toMatch(/RETURNS void[\s\S]*BEGIN\s+RETURN;\s+END;/);
    expect(legacyRpc).not.toMatch(/UPDATE\s+public\.posts/i);
    expect(legacyRpc).toContain('REVOKE ALL ON FUNCTION public.increment_post_remix_count(uuid) FROM PUBLIC, anon, authenticated');
  });
});
