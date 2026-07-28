import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260728180500_feed_delivery_facts.sql',
), 'utf8');

describe('feed delivery facts migration', () => {
  it('creates a durable fact table without session-graph foreign keys', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.feed_delivery_facts');
    expect(migration).toContain('delivery_id bigint PRIMARY KEY');
    // The whole point is surviving session pruning: no FK to feed_sessions or
    // feed_session_items may exist on the fact table.
    expect(migration).not.toMatch(/feed_delivery_facts[\s\S]{0,2000}REFERENCES public\.feed_sessions/);
    expect(migration).not.toMatch(/REFERENCES public\.feed_session_items/);
    expect(migration).toContain('algorithm_version_id uuid NOT NULL');
    expect(migration).toContain('REFERENCES public.feed_algorithm_versions(id) ON DELETE RESTRICT');
    expect(migration).toContain('experiment_assignment_id bigint');
    expect(migration).toContain('experiment_id uuid');
    expect(migration).toContain('experiment_variant_id uuid');
    expect(migration).toContain('feed_delivery_facts_experiment_attribution_check');
    expect(migration).toContain('feed_delivery_facts_experiment_ranked_idx');
    expect(migration).toContain('exploration_propensity double precision');
    expect(migration).toContain('score_components jsonb NOT NULL');
    // Experiment dimensions deliberately outlive the assignment row.
    expect(migration).not.toMatch(/experiment_(?:id|variant_id) uuid\s+REFERENCES public\.feed_/);
  });

  it('captures primitive outcome measurements broadly', () => {
    for (const column of [
      'rendered_at',
      'qualified_impression_at',
      'opened_at',
      'quick_skipped_at',
      'dwell_ms_max',
      'media_progress_max',
      'media_duration_ms',
      'saved_at',
      'shared_at',
      'followed_at',
      'remix_started_at',
      'remix_completed_at',
      'resource_opened_at',
      'purchased_at',
      'not_interested_at',
      'hid_creator_at',
      'reported_at',
      'served_at',
    ]) {
      expect(migration).toContain(column);
    }
  });

  it('stamps an immutable delivery snapshot onto events inside the validation trigger', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS delivery_fact_id bigint');
    expect(migration).toContain(
      'NEW.delivery_fact_id := coalesce(NEW.delivery_fact_id, NEW.session_item_id);',
    );
    // The stamp must live inside the session-item branch so the pruning detach
    // UPDATE (which nulls session references) never clears it.
    const stampIndex = migration.indexOf('NEW.delivery_fact_id := coalesce');
    const itemBranchIndex = migration.indexOf('IF NEW.session_item_id IS NOT NULL THEN');
    const sessionBranchIndex = migration.indexOf('IF NEW.session_id IS NOT NULL THEN');
    expect(itemBranchIndex).toBeGreaterThan(-1);
    expect(stampIndex).toBeGreaterThan(itemBranchIndex);
    expect(stampIndex).toBeLessThan(sessionBranchIndex);
    expect(migration).not.toMatch(/delivery_fact_id bigint\s+REFERENCES/);
  });

  it('applies outcomes monotonically from an event trigger', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.apply_feed_delivery_outcome()');
    expect(migration).toContain('IF NEW.delivery_fact_id IS NULL THEN');
    expect(migration).toContain('greatest(facts.dwell_ms_max, coalesce(NEW.duration_ms, 0)::bigint)');
    expect(migration).toContain('greatest(facts.media_progress_max, coalesce(NEW.progress, 0))');
    expect(migration).toContain('coalesce(facts.qualified_impression_at, NEW.occurred_at)');
    expect(migration).toContain(
      'AFTER INSERT OR UPDATE OF progress, duration_ms ON public.feed_events',
    );
    // quick_skip is a short dwell, so it must contribute to dwell_ms_max.
    expect(migration).toContain("NEW.event_type IN ('dwell', 'quick_skip')");
  });

  it('upserts media progress with GREATEST semantics against the per-delivery cap', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.record_feed_media_progress_event(');
    expect(migration).toContain(
      'ON CONFLICT (session_item_id, event_type) WHERE session_item_id IS NOT NULL',
    );
    expect(migration).toContain('progress = greatest(coalesce(feed_events.progress, 0), coalesce(EXCLUDED.progress, 0))');
    expect(migration).toContain('duration_ms = greatest(coalesce(feed_events.duration_ms, 0), coalesce(EXCLUDED.duration_ms, 0))');
    expect(migration).toContain("RAISE EXCEPTION 'Media progress events require a feed delivery'");
  });

  it('adds seen-history indexes that include post_id for both identity paths', () => {
    expect(migration).toContain('feed_events_viewer_post_impression_idx');
    expect(migration).toContain('(viewer_user_id, post_id, occurred_at DESC)');
    expect(migration).toContain('feed_events_anonymous_post_impression_idx');
    expect(migration).toContain('(anonymous_key_hash, post_id, occurred_at DESC)');
    expect(migration).toMatch(/WHERE event_type = 'impression' AND viewer_user_id IS NOT NULL/);
    expect(migration).toMatch(/WHERE event_type = 'impression' AND anonymous_key_hash IS NOT NULL/);
  });

  it('replaces the prune function without leaving an ambiguous overload', () => {
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.prune_feed_personalization_data(\n  timestamptz, integer, integer, integer\n);',
    );
    expect(migration).toContain('p_fact_retention_days integer DEFAULT 400');
    expect(migration).toContain('OR p_fact_retention_days < p_event_retention_days');
    expect(migration).toContain("'facts_deleted', v_facts_deleted");
    // The rewritten prune body must keep the detach-then-delete session flow.
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('SET session_id = NULL,');
  });

  it('locks the fact table to the service role', () => {
    expect(migration).toContain('ALTER TABLE public.feed_delivery_facts ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.feed_delivery_facts FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('"No client access to feed_delivery_facts"');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_delivery_facts TO service_role');
  });
});
