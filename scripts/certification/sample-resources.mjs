#!/usr/bin/env node
/**
 * Resource sampler for the Phase 1 certification run.
 *
 * The pass criteria are not all latency: "DB CPU and connection pool below 70%",
 * "no growing lock or retention backlog", "queue age below twice its cadence".
 * None of those are visible in the load driver's output, and the 2026-08-09
 * attempt could not evaluate the pool criterion at all because its substitute
 * environment had no configurable `max_connections`. On a real branch both are
 * measurable, so they get sampled rather than assumed.
 *
 * Read the pool numbers against the audit's warning: the criterion sits on a
 * ~47% idle floor in production (28 of 60 client backends at 13 MAU), so
 * "below 70%" leaves roughly 14 request-serving connections, not 42. A branch
 * idles lower than production because nothing else is connected to it, which is
 * why `idle_floor_pct` is recorded on the first sample rather than inferred.
 *
 * Usage:
 *   node scripts/certification/sample-resources.mjs --interval 15 --out samples.jsonl
 */

import { appendFile } from 'node:fs/promises';

const options = { intervalSeconds: 15, out: null, label: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--interval') { options.intervalSeconds = Number(value); index += 1; }
  else if (argument === '--out') { options.out = value; index += 1; }
  else if (argument === '--label') { options.label = value; index += 1; }
}

if (!Number.isFinite(options.intervalSeconds) || options.intervalSeconds < 1 || options.intervalSeconds > 300) {
  console.error('--interval must be between 1 and 300 seconds.');
  process.exit(1);
}

const SUPABASE_URL = process.env.CERT_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.CERT_SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('CERT_SUPABASE_URL and CERT_SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

async function sql(query) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cert_query`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_sql: query }),
  });
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function rpc(name, body = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${name} failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const SAMPLE_SQL = `
  select
    (select setting::int from pg_settings where name = 'max_connections') as max_connections,
    (select count(*) from pg_stat_activity) as total_backends,
    (select count(*) from pg_stat_activity where backend_type = 'client backend') as client_backends,
    (select count(*) from pg_stat_activity where state = 'active') as active_backends,
    (select count(*) from pg_stat_activity where state = 'idle in transaction') as idle_in_transaction,
    (select coalesce(max(extract(epoch from (now() - xact_start))), 0)
       from pg_stat_activity where state = 'idle in transaction') as idle_in_transaction_max_seconds,
    (select count(*) from pg_stat_activity where wait_event_type = 'Lock') as lock_waiters,
    (select coalesce(max(extract(epoch from (now() - query_start))), 0)
       from pg_stat_activity where state = 'active' and backend_type = 'client backend') as longest_active_seconds,
    (select count(*) from pg_locks where not granted) as ungranted_locks,
    (select setting::boolean from pg_settings where name = 'track_io_timing') as track_io_timing,
    (select coalesce(sum(xact_commit + xact_rollback), 0) from pg_stat_database where datname = current_database()) as transactions,
    (select coalesce(sum(blks_hit), 0) from pg_stat_database where datname = current_database()) as blks_hit,
    (select coalesce(sum(blks_read), 0) from pg_stat_database where datname = current_database()) as blks_read,
    (select coalesce(sum(blk_read_time), 0) from pg_stat_database where datname = current_database()) as blk_read_time,
    (select coalesce(sum(blk_write_time), 0) from pg_stat_database where datname = current_database()) as blk_write_time,
    (select coalesce(sum(temp_bytes), 0) from pg_stat_database where datname = current_database()) as temp_bytes,
    (select coalesce(sum(temp_files), 0) from pg_stat_database where datname = current_database()) as temp_files,
    (select coalesce(sum(deadlocks), 0) from pg_stat_database where datname = current_database()) as deadlocks,
    (select coalesce(wal_bytes, 0) from pg_stat_wal) as wal_bytes,
    (select coalesce(wal_records, 0) from pg_stat_wal) as wal_records,
    (select coalesce(num_timed, 0) + coalesce(num_requested, 0) from pg_stat_checkpointer) as checkpoints,
    (select pg_database_size(current_database())) as database_bytes,
    (select count(*) from public.generation_completion_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_at <= now() - interval '5 minutes')) as completion_due,
    (select coalesce(max(extract(epoch from (now() - next_attempt_at))), 0)
       from public.generation_completion_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_at <= now() - interval '5 minutes')) as completion_oldest_due_seconds,
    (select count(*) from public.workflow_run_step_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and coalesce(heartbeat_at, locked_at) <= now() - interval '5 minutes')) as workflow_steps_due,
    (select coalesce(max(extract(epoch from (now() - next_attempt_at))), 0)
       from public.workflow_run_step_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and coalesce(heartbeat_at, locked_at) <= now() - interval '5 minutes')) as workflow_oldest_due_seconds,
    (select count(*) from public.template_run_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and coalesce(heartbeat_at, locked_at) <= now() - interval '5 minutes')) as template_due,
    (select coalesce(max(extract(epoch from (now() - next_attempt_at))), 0)
       from public.template_run_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and coalesce(heartbeat_at, locked_at) <= now() - interval '5 minutes')) as template_oldest_due_seconds,
    (select count(*) from public.generation_output_import_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_at <= now() - interval '5 minutes')) as output_import_due,
    (select coalesce(max(extract(epoch from (now() - next_attempt_at))), 0)
      from public.generation_output_import_jobs
      where (status = 'pending' and next_attempt_at <= now())
         or (status = 'processing' and locked_at <= now() - interval '5 minutes')) as output_import_oldest_due_seconds,
    (select count(*) from public.post_media
      where media_kind = 'video' and rendition_status in ('pending', 'processing')) as rendition_open,
    (select coalesce(max(extract(epoch from (now() - created_at))), 0) from public.post_media
      where media_kind = 'video' and rendition_status in ('pending', 'processing')) as rendition_oldest_seconds,
    (select greatest(reltuples, 0)::bigint from pg_class
      where oid = 'public.feed_delivery_facts'::regclass) as delivery_facts,
    (select coalesce(min(extract(epoch from (now() - ranked_at)) / 86400.0), 0)
       from public.feed_delivery_facts) as newest_fact_age_days
`;

let previous = null;
let baselineIdleFloorPct = null;
let previousSampleStartedAt = null;
let sampleFailures = 0;

async function sample() {
  const sampleStartedAt = Date.now();
  const [rows, retentionRows] = await Promise.all([
    sql(SAMPLE_SQL),
    rpc('get_feed_retention_lag'),
  ]);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return;

  const at = new Date().toISOString();
  const clientBackends = Number(row.client_backends);
  const maxConnections = Number(row.max_connections);
  if (baselineIdleFloorPct === null) {
    baselineIdleFloorPct = maxConnections
      ? Number((clientBackends / maxConnections * 100).toFixed(1))
      : null;
  }

  // Rates need two points; a single cumulative counter says nothing about now.
  let tps = null;
  let cacheHitRatio = null;
  let readTimeMsPerSecond = null;
  let writeTimeMsPerSecond = null;
  let tempBytesPerSecond = null;
  if (previous) {
    const elapsed = (Date.parse(at) - Date.parse(previous.at)) / 1000;
    if (elapsed > 0) tps = Number(((Number(row.transactions) - previous.transactions) / elapsed).toFixed(2));
    const hit = Number(row.blks_hit) - previous.blks_hit;
    const read = Number(row.blks_read) - previous.blks_read;
    if (hit + read > 0) cacheHitRatio = Number((hit / (hit + read)).toFixed(4));
    if (elapsed > 0) {
      readTimeMsPerSecond = Number(((Number(row.blk_read_time) - previous.blkReadTime) / elapsed).toFixed(2));
      writeTimeMsPerSecond = Number(((Number(row.blk_write_time) - previous.blkWriteTime) / elapsed).toFixed(2));
      tempBytesPerSecond = Number(((Number(row.temp_bytes) - previous.tempBytes) / elapsed).toFixed(2));
    }
  }
  previous = {
    at,
    transactions: Number(row.transactions),
    blks_hit: Number(row.blks_hit),
    blks_read: Number(row.blks_read),
    blkReadTime: Number(row.blk_read_time),
    blkWriteTime: Number(row.blk_write_time),
    tempBytes: Number(row.temp_bytes),
  };

  const record = {
    at,
    label: options.label,
    maxConnections,
    clientBackends,
    poolUsedPct: maxConnections ? Number((clientBackends / maxConnections * 100).toFixed(1)) : null,
    activeBackends: Number(row.active_backends),
    idleInTransaction: Number(row.idle_in_transaction),
    idleInTransactionMaxSeconds: Number(row.idle_in_transaction_max_seconds),
    idleFloorPct: baselineIdleFloorPct,
    sampleGapSeconds: previousSampleStartedAt === null
      ? null
      : Number(((sampleStartedAt - previousSampleStartedAt) / 1000).toFixed(2)),
    sampleDurationMs: Date.now() - sampleStartedAt,
    sampleFailures,
    lockWaiters: Number(row.lock_waiters),
    ungrantedLocks: Number(row.ungranted_locks),
    longestActiveSeconds: Number(Number(row.longest_active_seconds).toFixed(2)),
    tps,
    cacheHitRatio,
    trackIoTiming: row.track_io_timing === true || row.track_io_timing === 'on',
    readTimeMsPerSecond,
    writeTimeMsPerSecond,
    tempBytesPerSecond,
    tempBytes: Number(row.temp_bytes),
    tempFiles: Number(row.temp_files),
    deadlocks: Number(row.deadlocks),
    walBytes: Number(row.wal_bytes),
    walRecords: Number(row.wal_records),
    checkpoints: Number(row.checkpoints),
    databaseBytes: Number(row.database_bytes),
    completionDue: Number(row.completion_due),
    completionOldestDueSeconds: Number(Number(row.completion_oldest_due_seconds).toFixed(1)),
    workflowStepsDue: Number(row.workflow_steps_due),
    workflowOldestDueSeconds: Number(Number(row.workflow_oldest_due_seconds).toFixed(1)),
    templateDue: Number(row.template_due),
    templateOldestDueSeconds: Number(Number(row.template_oldest_due_seconds).toFixed(1)),
    outputImportDue: Number(row.output_import_due),
    outputImportOldestDueSeconds: Number(Number(row.output_import_oldest_due_seconds).toFixed(1)),
    renditionOpen: Number(row.rendition_open),
    renditionOldestSeconds: Number(Number(row.rendition_oldest_seconds).toFixed(1)),
    deliveryFacts: Number(row.delivery_facts),
    feedRetention: (Array.isArray(retentionRows) ? retentionRows : []).map((entry) => ({
      table: entry.table_name,
      oldestRowAgeDays: entry.oldest_row_at
        ? Number(((Date.now() - Date.parse(entry.oldest_row_at)) / 86_400_000).toFixed(2))
        : null,
      estimatedRows: Number(entry.row_count),
    })),
  };

  const line = `${JSON.stringify(record)}\n`;
  if (options.out) await appendFile(options.out, line);
  else process.stdout.write(line);
  previousSampleStartedAt = sampleStartedAt;
}

console.error(`Sampling every ${options.intervalSeconds}s${options.out ? ` -> ${options.out}` : ''}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopping = true; });
}

while (!stopping) {
  const iterationStartedAt = Date.now();
  try {
    await sample();
  } catch (error) {
    sampleFailures += 1;
    console.error(`sample failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stopping) break;
  const waitMs = Math.max(0, options.intervalSeconds * 1000 - (Date.now() - iterationStartedAt));
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

if (sampleFailures > 0) process.exitCode = 1;
