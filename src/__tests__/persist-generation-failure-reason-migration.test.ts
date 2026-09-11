import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_persist_generation_failure_reason.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

const settlement = fs.readFileSync(
  path.resolve(process.cwd(), 'src/lib/generation-settlement.ts'),
  'utf8',
);

describe('persist generation failure reason migration', () => {
  it('replaces the old arity rather than adding an ambiguous overload', () => {
    expect(migrationName).toBeDefined();
    // Postgres cannot change a function's arity with CREATE OR REPLACE: leaving
    // the two-argument form in place would register a second overload and make
    // every existing two-argument call ambiguous at runtime.
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.settle_generation_failed(text, timestamp with time zone);',
    );
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.settle_generation_failed');
    expect(migration).toContain('p_error_message text DEFAULT NULL');
  });

  it('records the provider reason without letting a replay erase it', () => {
    // Webhook redelivery and the completion cron both settle the same row, and
    // only the first attempt usually carries the provider's message.
    expect(migration).toContain(
      "v_error_message text := left(nullif(btrim(coalesce(p_error_message, '')), ''), 500);",
    );
    expect(migration).toContain(
      'error_message = coalesce(v_error_message, public.generations.error_message)',
    );
  });

  it('preserves the refund and idempotency guards the settlement path depends on', () => {
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('UPDATE public.profiles');
    expect(migration).toContain('WHEN v_refunded THEN true');
    expect(migration).toContain("'already_succeeded'");
  });

  it('keeps the new signature private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');

    const signature = 'settle_generation_failed(text, timestamp with time zone, text)';
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM anon`);
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM authenticated`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role`);
  });

  it('passes the reason through the settlement seam', () => {
    expect(settlement).toContain('errorMessage?: string | null');
    expect(settlement).toContain('p_error_message: errorMessage ?? null');
  });
});
