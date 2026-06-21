import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_generation_completion_jobs.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('generation completion jobs migration', () => {
  it('creates a private durable completion queue', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.generation_completion_jobs');
    expect(migration).toContain('prediction_id text NOT NULL UNIQUE');
    expect(migration).toContain("status text NOT NULL DEFAULT 'pending'");
    expect(migration).toContain("status IN ('pending', 'processing', 'succeeded', 'failed')");
    expect(migration).toContain('attempt_count integer NOT NULL DEFAULT 0');
    expect(migration).toContain('payload jsonb NOT NULL DEFAULT');
  });

  it('indexes pending work and keeps client roles out', () => {
    expect(migration).toContain('generation_completion_jobs_pending_idx');
    expect(migration).toContain('ON public.generation_completion_jobs (status, next_attempt_at, created_at)');
    expect(migration).toContain('ALTER TABLE public.generation_completion_jobs ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.generation_completion_jobs FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON public.generation_completion_jobs FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_completion_jobs TO service_role');
  });

  it('exposes only service-role RPCs for enqueue, claim, finish, and prune', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.enqueue_generation_completion_job');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.claim_generation_completion_jobs');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.finish_generation_completion_job');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prune_generation_completion_jobs');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.enqueue_generation_completion_job(text, jsonb) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.claim_generation_completion_jobs(integer, text, integer, text) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prune_generation_completion_jobs(integer, integer) FROM PUBLIC');
    expect(migration).toContain('TO service_role');
  });

  it('uses idempotent enqueue, pooled-safe claiming, and bounded retries', () => {
    expect(migration).toContain('ON CONFLICT (prediction_id) DO UPDATE');
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('p_lock_ttl_seconds');
    expect(migration).toContain('attempt_count = public.generation_completion_jobs.attempt_count + 1');
    expect(migration).toContain('attempt_count >= 5');
    expect(migration).toContain('make_interval(secs => p_retry_delay_seconds)');
  });

  it('schedules a frequent Vercel cron fallback for missed callbacks', () => {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
    expect(vercel.crons).toContainEqual({
      path: '/api/cron/generation-completions',
      schedule: '*/5 * * * *',
    });
  });
});
