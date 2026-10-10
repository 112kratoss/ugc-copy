import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
