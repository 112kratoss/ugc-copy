import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_feed_personalization_system.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';
const pruningFixName = fs
  .readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_fix_feed_session_pruning.sql'));
const pruningFix = pruningFixName
  ? fs.readFileSync(path.join(migrationsDirectory, pruningFixName), 'utf8')
  : '';

const backendTables = [
  'feed_algorithm_versions',
  'feed_experiments',
  'feed_experiment_variants',
  'feed_experiment_assignments',
  'feed_sessions',
  'feed_session_items',
  'feed_events',
  'post_feed_stats',
  'user_interest_weights',
  'feed_user_post_feedback',
  'feed_user_creator_feedback',
] as const;

describe('feed personalization migration', () => {
  it('creates the complete backend-owned feed data model', () => {
    expect(migrationName).toBeDefined();

    for (const table of backendTables) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`,
      );
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role`,
      );
      expect(migration).toContain(`No client access to ${table}`);
    }
  });

  it('uses stable algorithm versions and reproducible session deliveries', () => {
    expect(migration).toContain(
      'CONSTRAINT feed_algorithm_versions_key_version_key UNIQUE (algorithm_key, version)',
    );
    expect(migration).toContain("'for-you-rules'");
    expect(migration).toContain("'active'");
    expect(migration).toContain(
      'CONSTRAINT feed_session_items_session_position_key UNIQUE (session_id, position)',
    );
    expect(migration).toContain(
      'CONSTRAINT feed_session_items_session_post_key UNIQUE (session_id, post_id)',
    );
    expect(migration).toContain('score_components jsonb NOT NULL');
    expect(migration).toContain('random_seed bigint NOT NULL DEFAULT');
    expect(migration.match(/viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL/g)).toHaveLength(3);
  });

  it('defines the idempotent runtime event contract', () => {
    expect(migration).toContain('client_event_id text NOT NULL UNIQUE');
    expect(migration).toContain('feed_events_client_event_id_length_check');
    expect(migration).toContain('source_surface text NOT NULL');
    expect(migration).toContain('position integer');
    expect(migration).toContain('duration_ms integer');
    expect(migration).toContain('progress double precision');
    expect(migration).toContain("metadata jsonb NOT NULL DEFAULT '{}'::jsonb");

    for (const eventType of [
      'impression',
      'open',
      'dwell',
      'media_progress',
      'quick_skip',
      'save',
      'unsave',
      'share',
      'follow',
      'remix_start',
      'remix_complete',
      'resource_open',
      'purchase',
      'not_interested',
      'hide_creator',
      'report',
    ]) {
      expect(migration).toContain(`'${eventType}'`);
    }

    expect(migration).toContain('CREATE TRIGGER feed_events_validate_context');
    expect(migration).toContain('Feed event creator does not match the post owner');
    expect(migration).toContain('Feed event user does not match the session viewer');
  });

  it('adds indexes for feed retrieval, telemetry aggregation, and retention', () => {
    expect(migration).toContain('feed_sessions_user_created_idx');
    expect(migration).toContain('feed_session_items_unserved_idx');
    expect(migration).toContain('feed_events_post_occurred_idx');
    expect(migration).toContain('feed_events_user_occurred_idx');
    expect(migration).toContain('feed_events_received_idx');
    expect(migration).toContain('feed_events_session_item_type_unique_idx');
    expect(migration).toContain('feed_events_user_post_signal_unique_idx');
    expect(migration).toContain('feed_events_user_creator_hide_unique_idx');
    expect(migration).toContain('post_feed_stats_window_usefulness_idx');
    expect(migration).toContain('user_interest_weights_positive_idx');
    expect(migration).toContain('feed_user_post_feedback_active_post_idx');
    expect(migration).toContain('feed_user_creator_feedback_active_creator_idx');
  });

  it('provides explainable candidate retrieval with safety and feedback exclusions', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates',
    );
    expect(migration).toContain("p.review_status = 'visible'");
    expect(migration).toContain('p.archived_at IS NULL');
    expect(migration).toContain('public.feed_user_post_feedback');
    expect(migration).toContain('public.feed_user_creator_feedback');
    expect(migration).toContain("'following'::text AS source");
    expect(migration).toContain("'interest'::text AS source");
    expect(migration).toContain("'trending'::text AS source");
    expect(migration).toContain("'recent'::text AS source");
    expect(migration).toContain("'exploration'::text AS source");
    expect(migration).toContain('negative_feedback_risk double precision');
  });

  it('ships bounded aggregation, interest decay, feedback, and retention functions', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.refresh_post_feed_stats');
    expect(migration).toContain('ON CONFLICT (post_id, window_key) DO UPDATE');
    expect(migration).toContain("('24h'::text, interval '24 hours')");
    expect(migration).toContain("('7d'::text, interval '7 days')");
    expect(migration).toContain("('30d'::text, interval '30 days')");
    expect(migration.match(/events\.session_item_id IS NOT NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights',
    );
    expect(migration).toContain('p_half_life_days integer DEFAULT 30');
    expect(migration).toContain("WHEN 'not_interested' THEN -6.00::double precision");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.set_feed_post_feedback');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.set_feed_creator_feedback');
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data',
    );
    expect(migration).toContain('LIMIT p_limit');
    expect(migration).toContain("'events_deleted', v_events_deleted");
  });

  it('detaches retained events before deleting expired feed sessions', () => {
    expect(pruningFixName).toBeDefined();
    expect(pruningFix).toContain('FOR UPDATE SKIP LOCKED');
    expect(pruningFix).toContain('CREATE TRIGGER feed_sessions_detach_events_before_delete');
    expect(pruningFix).toContain('BEFORE DELETE ON public.feed_sessions');
    expect(pruningFix).toContain('SET session_id = NULL,');
    expect(pruningFix).toContain('session_item_id = NULL');
    expect(pruningFix).toContain('items.session_id = ANY (v_session_ids)');

    const detachIndex = pruningFix.indexOf('UPDATE public.feed_events AS events');
    const deleteIndex = pruningFix.indexOf('DELETE FROM public.feed_sessions AS sessions');
    expect(detachIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(detachIndex);
  });

  it('keeps every callable feed function service-role-only and invoker-secured', () => {
    expect(migration).not.toContain('SECURITY DEFINER');

    expect(migration).toContain('GRANT SELECT ON TABLE public.posts TO service_role');
    expect(migration).toContain('GRANT SELECT ON TABLE public.follows TO service_role');
    expect(migration).toContain('GRANT SELECT ON TABLE public.post_saves TO service_role');

    for (const functionName of [
      'get_ranked_feed_candidates',
      'validate_feed_event_context',
      'set_feed_post_feedback',
      'set_feed_creator_feedback',
      'prune_feed_personalization_data',
      'refresh_post_feed_stats',
      'refresh_user_interest_weights',
    ]) {
      expect(migration).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}[\\s\\S]+?SECURITY INVOKER`),
      );
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}[\\s\\S]+?authenticated`),
      );
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${functionName}[\\s\\S]+?TO service_role`),
      );
    }
  });

  it('enables semantic retrieval only when pgvector is available', () => {
    expect(migration).toContain('FROM pg_available_extensions');
    expect(migration).toContain("WHERE name = 'vector'");
    expect(migration).toContain('pgvector is unavailable; semantic candidates will use metadata signals only');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.post_content_embeddings');
    expect(migration).toContain('post_content_embeddings_embedding_hnsw_idx');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.match_post_content_embeddings');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.match_post_content_embeddings',
    );
    expect(migration).toContain('TO service_role');
  });

  it('leaves scheduling to the existing backend job system', () => {
    expect(migration).not.toContain('cron.schedule');
    expect(migration).not.toContain('CREATE EXTENSION IF NOT EXISTS pg_cron');
  });
});
