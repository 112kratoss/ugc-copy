import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/upload-finalization', () => ({ reclaimExpiredUploadReservations: vi.fn(async () => ({
  scanned: 0, handled: 0, objectsDeleted: 0, failed: 0, deferred: 0, firstClaims: 0, held: 0,
  scanLimitReached: false, timeBudgetReached: false, oldestCandidateExpiresAt: null,
})) }));
import { runOperationalDataRetentionBackendJob } from '@/lib/backend-job-executions';

const configPath = process.env.AUDIT_STORAGE_CONFIG;
const connectionString = process.env.SUPABASE_TEST_DB_URL;

describe.skipIf(!configPath || !connectionString)('retention job durable failure reporting through PostgREST', () => {
  let db: Client;
  let admin: SupabaseClient;
  let fail = true;
  const calls: string[] = [];
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(configPath!, 'utf8'));
    expect(['localhost', '127.0.0.1']).toContain(new URL(config.API_URL).hostname);
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      global: { fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        // Inject maintenance outcomes at the transport boundary; run rows and
        // lease RPCs still reach real PostgREST. No unrelated audit data is pruned.
        if (path.startsWith('/rest/v1/rpc/prune_')) {
          const operation = path.split('/').at(-1)!;
          calls.push(operation);
          const failed = fail && operation === 'prune_profile_share_events';
          return new Response(JSON.stringify(failed
            ? { code: 'XX000', message: 'Injected retention transport failure' }
            : operation === 'prune_operational_backend_data' ? { total_deleted: 3, job_runs_deleted: 3 } : 1), {
            status: failed ? 503 : 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return fetch(input, init);
      } },
    });
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });

  it('persists the supplementary failure and a clean subsequent retry separately', async () => {
    const requestIds = ['audit-retention-' + randomUUID(), 'audit-retention-' + randomUUID()];
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        fail = attempt === 0;
        calls.length = 0;
        expect(await runOperationalDataRetentionBackendJob({ serviceClient: admin, requestId: requestIds[attempt] })).toMatchObject({ success: true, status: 'succeeded' });
        const rows = (await db.query('select status,summary from public.backend_job_runs where request_id=$1', [requestIds[attempt]])).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'succeeded', summary: {
          supplementaryPruneFailures: attempt === 0 ? ['prune_profile_share_events'] : [],
          profileShareEventsDeleted: attempt === 0 ? 0 : 1,
          totalDeleted: 3,
        } });
        expect(calls).toEqual(expect.arrayContaining(['prune_post_share_events', 'prune_profile_share_events', 'prune_abandoned_free_unlock_orders', 'prune_account_merge_tickets', 'prune_upload_byte_reservations']));
        expect((await db.query('select name from public.backend_job_locks where locked_by like $1', [`%${requestIds[attempt]}%`])).rows).toEqual([]);
      }
    } finally {
      await db.query('delete from public.backend_job_runs where request_id=any($1::text[])', [requestIds]);
      expect((await db.query('select id from public.backend_job_runs where request_id=any($1::text[])', [requestIds])).rows).toEqual([]);
    }
  });
});
