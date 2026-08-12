import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260812150000_feed_event_batch_rpc.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('feed event batch RPC migration', () => {
  it('keeps the function bounded and callable only by the service role', () => {
    expect(migration).toContain('public.record_showcase_feed_events(');
    expect(migration).toMatch(/p_actor_user_id uuid,[\s\S]*p_anonymous_key_hash text,[\s\S]*p_events jsonb/);
    expect(migration).toContain("jsonb_array_length(p_events) < 1 OR jsonb_array_length(p_events) > 25");
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.record_showcase_feed_events\(uuid, text, jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.record_showcase_feed_events\(uuid, text, jsonb\)[\s\S]*TO service_role/);
  });

  it('isolates poison entries and delegates progress aggregation', () => {
    expect(migration).toContain('EXCEPTION');
    expect(migration).toContain("WHEN SQLSTATE 'P0001'");
    expect(migration).toContain('WHEN OTHERS');
    expect(migration).toMatch(/WHEN OTHERS THEN[\s\S]*RAISE;/);
    expect(migration).toContain('PERFORM public.record_feed_media_progress_event(');
    expect(migration).toContain('EXCEPTION WHEN unique_violation');
    expect(migration).toContain('feed_events_session_item_type_unique_idx');
    expect(migration).toContain("ARRAY['save', 'unsave', 'not_interested']");
    expect(migration).toContain("v_event_type = 'hide_creator'");
    expect(migration).toContain("WHEN SQLSTATE '22P02' OR SQLSTATE '22003' OR SQLSTATE '22007' OR SQLSTATE '22008'");
  });

  it('validates delivery context at occurrence time before insert triggers run', () => {
    expect(migration).toContain("v_occurred_at < now() - interval '24 hours'");
    expect(migration).toContain('SELECT items.session_id, items.position');
    expect(migration).toContain('v_position IS DISTINCT FROM v_delivery_position');
    expect(migration).toContain('sessions.created_at');
    expect(migration).toContain('v_occurred_at >= v_session_expires_at');
    expect(migration).toMatch(/v_session_user_id IS NOT NULL THEN[\s\S]*v_session_user_id IS DISTINCT FROM p_actor_user_id/);
    expect(migration).toMatch(/ELSIF p_actor_user_id IS NOT NULL[\s\S]*v_session_anonymous_key_hash IS DISTINCT FROM p_anonymous_key_hash/);
  });

  it('applies preference side effects only after event persistence', () => {
    const insertPosition = migration.indexOf('INSERT INTO public.feed_events (');
    const postFeedbackPosition = migration.indexOf('INSERT INTO public.feed_user_post_feedback (');
    const creatorFeedbackPosition = migration.indexOf('INSERT INTO public.feed_user_creator_feedback (');

    expect(insertPosition).toBeGreaterThan(-1);
    expect(postFeedbackPosition).toBeGreaterThan(insertPosition);
    expect(creatorFeedbackPosition).toBeGreaterThan(insertPosition);
  });
});
