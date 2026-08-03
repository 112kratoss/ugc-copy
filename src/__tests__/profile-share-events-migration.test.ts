import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROFILE_SHARE_SOURCE_SURFACES } from '@/lib/share';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_profile_share_events.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('profile share events migration', () => {
  it('exists', () => {
    expect(migrationName).toBeDefined();
  });

  it('creates the ledger a profile share can land in', () => {
    // The two existing share tables are foreign keyed to a post, so a share of a
    // profile had nowhere to go and both clients simply dropped it.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.profile_share_events');
    expect(migration).toContain('profile_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL');
    expect(migration).toContain("event_type text NOT NULL CHECK (event_type IN ('share_click', 'share_visit'))");
    expect(migration).toContain('actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL');
  });

  it('allows exactly the surfaces the clients can send', () => {
    for (const surface of PROFILE_SHARE_SOURCE_SURFACES) {
      expect(migration).toContain(`'${surface}'`);
    }
  });

  it('indexes the two ways the ledger is read', () => {
    expect(migration).toContain('profile_share_events_profile_created_idx');
    expect(migration).toContain('profile_share_events_actor_idx');
  });

  it('denies all direct client access, leaving the API routes as the only writer', () => {
    expect(migration).toContain('ALTER TABLE public.profile_share_events ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.profile_share_events FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON public.profile_share_events FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_share_events TO service_role');
    expect(migration).toContain('CREATE POLICY "No client access to profile_share_events"');
    expect(migration).toContain('COMMENT ON TABLE public.profile_share_events');
  });

  it('records through a hardened definer function, not a direct insert', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.record_profile_share_event');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    // A profile with no username has no /creators/<username> URL, so there was
    // nothing shareable -- the SQL-side analogue of record_post_share_event's
    // visibility guard.
    expect(migration).toContain('Only addressable creator profiles can record share events');

    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) FROM ${role}`,
      );
    }
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.record_profile_share_event(uuid, text, text, text, uuid) TO service_role',
    );
  });

  it('keeps a lifetime counter that survives the retention window', () => {
    expect(migration).toContain('ALTER TABLE public.profiles');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS share_count integer NOT NULL DEFAULT 0');
    expect(migration).toContain('SET share_count = share_count + 1');
  });

  it('prunes itself, so append-only telemetry cannot grow without bound', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prune_profile_share_events');
    expect(migration).toContain("p_older_than interval DEFAULT interval '90 days'");
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.prune_profile_share_events(interval)\n  TO service_role',
    );
  });
});
