import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The batch loop's real-database case runs every step of the job; the
// reservation sweep reads Storage, which this Postgres-only job does not have.
vi.mock('@/lib/upload-finalization', () => ({
  reclaimExpiredUploadReservations: vi.fn(async () => ({
    scanned: 0, handled: 0, objectsDeleted: 0, absentObjectsReleased: 0, failed: 0, deferred: 0,
    firstClaims: 0, held: 0, bytesDeleted: 0, scanLimitReached: false, timeBudgetReached: false,
    oldestCandidateExpiresAt: null,
  })),
}));

import { pruneOperationalBackendData } from '@/lib/operational-data-retention';

const connectionString = process.env.SUPABASE_TEST_DB_URL;
const tables = ['backend_job_runs', 'backend_rate_limits', 'generation_completion_jobs', 'provider_dependency_events', 'generation_model_provider_checks'] as const;
type Table = typeof tables[number];
const counter: Record<Table, string> = {
  backend_job_runs: 'job_runs_deleted', backend_rate_limits: 'rate_limits_deleted',
  generation_completion_jobs: 'completion_jobs_deleted', provider_dependency_events: 'provider_events_deleted',
  generation_model_provider_checks: 'provider_checks_deleted',
};

describe.skipIf(!connectionString)('operational retention progress past actual row locks', () => {
  let fixture: Client, locker: Client, worker: Client;
  let ids: string[], checkIds: string[], releaseId: string, modelId: string;
  const key = (table: Table) => table === 'backend_rate_limits' ? 'subject_key' : 'id';
  const tableIds = (table: Table) => table === 'generation_model_provider_checks' ? checkIds : ids;
  const remaining = async (table: Table) => (await worker.query(`select ${key(table)}::text as id from public.${table} where ${key(table)}::text=any($1::text[]) order by 1`, [tableIds(table)])).rows.map(row => row.id).sort();
  async function sweep(client = worker) {
    // Ancient fixtures and a rollback-only sweep prevent incidental pruning of
    // other local tests. The real service-role function and table locks execute.
    await client.query('begin');
    await client.query("set local lock_timeout='350ms'");
    await client.query('set local role service_role');
    return (await client.query("select public.prune_operational_backend_data(p_now=>'1901-01-01'::timestamptz,p_max_deletes_per_table=>1) as summary")).rows[0].summary;
  }
  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    fixture = new Client({ connectionString, statement_timeout: 5000 });
    locker = new Client({ connectionString, statement_timeout: 5000 });
    worker = new Client({ connectionString, statement_timeout: 5000 });
    await Promise.all([fixture.connect(), locker.connect(), worker.connect()]);
  });
  afterAll(async () => { await Promise.all([fixture?.end(), locker?.end(), worker?.end()]); });
  beforeEach(async () => {
    checkIds = [];
    ids = [randomUUID(), randomUUID(), randomUUID()]; releaseId = randomUUID(); modelId = 'retention-lock-'+randomUUID();
    await fixture.query("insert into public.generation_models(model_id,kind) values($1,'image')", [modelId]);
    await fixture.query("insert into public.generation_model_catalog_releases(id,revision,status,defaults) values($1,$2,'draft','{}')", [releaseId, modelId]);
    await fixture.query("insert into public.generation_model_catalog_entries(release_id,model_id,public_descriptor,adapter_key,provider_model_map,pricing_strategy,pricing_config,validation_strategy) values($1,$2,'{}','image-v1','{}','flat','{}','image-v1')", [releaseId, modelId]);
    for (let index = 0; index < 3; index++) {
      const at = `1900-01-0${index+1}T00:00:00Z`;
      await fixture.query("insert into public.backend_job_runs(id,job_name,route,request_id,lock_owner,status,started_at,finished_at) values($1::uuid,'operational-data-retention','/api/cron/operational-data-retention',$1::text,'fixture','succeeded',$2,$2)", [ids[index], at]);
      await fixture.query("insert into public.backend_rate_limits(scope,subject_key,window_start,request_count) values('retention-lock-fixture',$1,$2,1)", [ids[index], at]);
      await fixture.query("insert into public.generation_completion_jobs(id,prediction_id,status,created_at,updated_at,completed_at) values($1::uuid,$1::text,'succeeded',$2,$2,$2)", [ids[index], at]);
      await fixture.query("insert into public.provider_dependency_events(id,service_name,outcome,method,timeout_ms,duration_ms,created_at) values($1,'retention-lock-fixture','timeout','GET',1,1,$2)", [ids[index], at]);
      checkIds.push((await fixture.query("insert into public.generation_model_provider_checks(release_id,model_id,provider,status,checked_at) values($1,$2,'kie','available',$3) returning id::text", [releaseId, modelId, at])).rows[0].id);
    }
  });
  afterEach(async () => {
    await worker.query('rollback'); await locker.query('rollback');
    for (const table of tables) {
      await fixture.query(`delete from public.${table} where ${key(table)}::text=any($1::text[])`, [tableIds(table)]);
      expect((await fixture.query(`select ${key(table)} from public.${table} where ${key(table)}::text=any($1::text[])`, [tableIds(table)])).rows).toEqual([]);
    }
    await fixture.query('delete from public.generation_model_catalog_entries where release_id=$1', [releaseId]);
    await fixture.query('delete from public.generation_model_catalog_releases where id=$1', [releaseId]);
    await fixture.query('begin');
    try {
      // Only this local, random fixture identity bypasses the immutable guard.
      await fixture.query('set local session_replication_role=replica');
      await fixture.query('delete from public.generation_models where model_id=$1', [modelId]);
      await fixture.query('commit');
    } catch (error) { await fixture.query('rollback'); throw error; }
    expect((await fixture.query('select model_id from public.generation_models where model_id=$1', [modelId])).rows).toEqual([]);
    expect((await fixture.query('select id from public.generation_model_catalog_releases where id=$1', [releaseId])).rows).toEqual([]);
  });

  it.each(tables)('skips a locked oldest %s row and revisits it after release', async table => {
    await locker.query('begin');
    await locker.query(`select ${key(table)} from public.${table} where ${key(table)}::text=$1 for update`, [tableIds(table)[0]]);
    const summary = await sweep();
    // Every phase can advance; the one-row cap and the newest model check stay
    // intact even when one phase starts with a locked eligible record.
    for (const other of tables) {
      expect(summary[counter[other]]).toBe(1);
      const keys = tableIds(other);
      expect(await remaining(other)).toEqual((other === table ? [keys[0], keys[2]] : [keys[1], keys[2]]).sort());
    }
    expect(summary.total_deleted).toBe(5); expect(summary.batch_limit_reached).toBe(true);
    await worker.query('rollback'); await locker.query('rollback');
    const retry = await sweep();
    expect(retry[counter[table]]).toBe(1);
    expect(await remaining(table)).toEqual([tableIds(table)[1], tableIds(table)[2]].sort());
    expect(await remaining('generation_model_provider_checks')).toContain(checkIds[2]);
    await worker.query('rollback');
  });
  it('returns an empty bounded sweep when all eligible rows are locked, then recovers', async () => {
    await locker.query('begin');
    for (const table of tables) {
      await locker.query(`select ${key(table)} from public.${table} where ${key(table)}::text=any($1::text[]) for update`, [tableIds(table)]);
    }
    const held = await sweep();
    expect(held.total_deleted).toBe(0); expect(held.batch_limit_reached).toBe(false);
    for (const table of tables) expect(await remaining(table)).toEqual([...tableIds(table)].sort());
    await worker.query('rollback'); await locker.query('rollback');
    expect((await sweep()).total_deleted).toBe(5);
  });

  it('lets overlapping sweep transactions select distinct victims without blocking', async () => {
    const first = await sweep(); // Keep its real delete locks until both have advanced.
    const second = await sweep(locker);
    expect(first.total_deleted).toBe(5); expect(second.total_deleted).toBe(5);
    for (const table of tables) {
      const keys = tableIds(table);
      expect(await remaining(table)).toEqual([keys[1], keys[2]].sort());
      const otherRows = (await locker.query(`select ${key(table)}::text as id from public.${table} where ${key(table)}::text=any($1::text[]) order by 1`, [keys])).rows.map(row => row.id).sort();
      expect(otherRows).toEqual([keys[0], keys[2]].sort());
    }
  });

});

// Usage audit (2026-11-04): the sweep's five new phases and the job's batch
// loop, against a real database. Everything runs inside one transaction that
// is rolled back, with a sweep time of 1901 and fixtures older than it, so
// nothing a shared local database holds is touched.
describe.skipIf(!connectionString)('operational retention phases and batches on a real database', () => {
  let db: Client;
  const userId = randomUUID();
  const asOf = '1901-01-01T00:00:00.000Z';

  beforeAll(async () => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(connectionString!).hostname);
    db = new Client({ connectionString, statement_timeout: 10000 });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query('begin');
    await db.query(
      "insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,created_at) values($1,$2,'authenticated','authenticated','{}','{}','1899-01-01')",
      [userId, `retention-phases-${userId}@example.invalid`],
    );
  });
  afterEach(async () => { await db.query('rollback'); });

  async function seed({ locks, onboarding }: { locks: number; onboarding: number }) {
    // Playback: two sessions on a day past the window, one on the last finished day.
    await db.query(`insert into public.playback_metrics(received_at,session_id,platform,os_version,network,span_ms,surface,start_kind,starts,start_total_ms,start_max_ms,start_samples,stalls,stall_total_ms,stall_max_ms)
      select fixture.at, 'phase-fixture-' || fixture.n, 'ios', '18.0', 'wifi', 1000, 'feed', 'cold', 2, 300, 200, array[100, 200], 1, 40, 40
      from (values (1, '1900-06-01T03:00:00Z'::timestamptz), (2, '1900-06-01T05:00:00Z'::timestamptz), (3, '1900-12-31T03:00:00Z'::timestamptz)) as fixture(n, at)`);
    await db.query(`insert into public.onboarding_events(client_event_id,installation_id,flow_version,platform,event_name,occurred_at,created_at)
      select gen_random_uuid(), 'fid_' || repeat('ef', 32), 1, 'ios', 'started', '1899-06-01', '1899-06-01' from generate_series(1, $1::integer)`, [onboarding]);
    await db.query(`insert into public.ai_usage_events(user_id,feature,provider,model,cost,status,input_prompt,output_text,response_payload,created_at)
      values ($1,'prompt_enhancement','kie','gemini-3-flash',0,'succeeded','prompt','output','{"enhancedPrompt":"output"}','1900-06-01'),
             ($1,'prompt_enhancement','kie','gemini-3-flash',0,'pending','pending prompt',null,null,'1900-06-01')`, [userId]);
    await db.query(`insert into public.mobile_notifications(user_id,type,category,title,body,is_read,created_at,updated_at,last_event_at)
      values ($1,'generation_succeeded','generation','Ready','Ready',false,'1899-06-01','1899-06-01','1899-06-01'),
             ($1,'generation_succeeded','generation','Ready','Ready',true,'1899-06-01','1899-06-01','1899-06-01')`, [userId]);
    await db.query(`insert into public.backend_job_locks(name,locked_until,locked_by,updated_at)
      select 'retention-phase-fixture:' || $1::text || ':' || n, '1900-12-01', 'fixture', '1900-12-01' from generate_series(1, $2::integer) as n`, [userId, locks]);
  }

  // A failed call rolls back to the savepoint, so the transaction (and the
  // fixtures in it) stays usable for the job's next call.
  async function asServiceRole<T>(work: () => Promise<T>) {
    await db.query('savepoint as_service_role');
    try {
      await db.query('set local role service_role');
      const result = await work();
      await db.query('reset role');
      await db.query('release savepoint as_service_role');
      return result;
    } catch (error) {
      await db.query('rollback to savepoint as_service_role');
      await db.query('reset role');
      throw error;
    }
  }

  it('rolls up and prunes playback, prunes onboarding events, unread alerts and expired locks, and clears settled AI text', async () => {
    await seed({ locks: 1, onboarding: 1 });

    const summary = (await asServiceRole(() => db.query(
      'select public.prune_operational_backend_data(p_now => $1::timestamptz) as summary', [asOf],
    ))).rows[0].summary;

    expect(summary).toMatchObject({
      playback_days_rolled_up: 2,
      playback_metrics_deleted: 2,
      onboarding_events_deleted: 1,
      ai_usage_payloads_cleared: 1,
      unread_notifications_deleted: 1,
      expired_job_locks_deleted: 1,
      batch_limit_reached: false,
    });
    const day = await db.query("select sessions::integer, starts::integer from public.playback_metrics_daily where day = '1900-06-01T00:00:00Z'");
    expect(day.rows).toEqual([{ sessions: 2, starts: 4 }]);
    const usage = await db.query('select status, cost, input_prompt, output_text, response_payload from public.ai_usage_events where user_id = $1 order by status', [userId]);
    expect(usage.rows).toEqual([
      { status: 'pending', cost: 0, input_prompt: 'pending prompt', output_text: null, response_payload: null },
      { status: 'succeeded', cost: 0, input_prompt: null, output_text: null, response_payload: null },
    ]);
    const alerts = await db.query('select is_read from public.mobile_notifications where user_id = $1', [userId]);
    expect(alerts.rows).toEqual([{ is_read: true }]);
  });

  it('drains a backlog in batches through the job, each batch capped, until one comes back short', async () => {
    await seed({ locks: 5, onboarding: 3 });
    // The job's own client calls, made as the service role on this transaction.
    const calls: string[] = [];
    const client = {
      rpc: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push(name);
        // No guest is listed: this case is about the prunes, and must delete no one.
        if (name.startsWith('list_idle_guest_identities')) return { data: [], error: null };
        if (!/^[a-z_]+$/.test(name)) throw new Error(`unexpected function ${name}`);
        const names = Object.keys(args);
        if (names.some((key) => !/^p_[a-z_]+$/.test(key))) throw new Error('unexpected argument');
        try {
          const result = await asServiceRole(() => db.query(
            `select public.${name}(${names.map((key, index) => `${key} => $${index + 1}`).join(', ')}) as result`,
            names.map((key) => args[key]),
          ));
          return { data: result.rows[0].result, error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
      auth: { admin: { deleteUser: async () => { throw new Error('no guest may be deleted here'); } } },
    } as unknown as SupabaseClient;

    const summary = await pruneOperationalBackendData(client, { now: new Date(asOf), maxDeletesPerTable: 2 });

    // 2 + 2 + 1 locks and 2 + 1 onboarding events: the third batch is short.
    expect(summary).toMatchObject({
      pruneBatches: 3,
      expiredJobLocksDeleted: 5,
      onboardingEventsDeleted: 3,
      playbackMetricsDeleted: 2,
      unreadNotificationsDeleted: 1,
      aiUsagePayloadsCleared: 1,
      batchLimitReached: false,
      pruneTimeBudgetReached: false,
      supplementaryPruneFailures: [],
    });
    expect(calls.filter((name) => name === 'prune_operational_backend_data')).toHaveLength(3);
    const left = await db.query('select count(*)::integer as left from public.backend_job_locks where name like $1', [`retention-phase-fixture:${userId}:%`]);
    expect(left.rows[0].left).toBe(0);
  });
});
