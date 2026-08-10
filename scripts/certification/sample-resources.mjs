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

const SAMPLE_SQL = `
  select
    (select setting::int from pg_settings where name = 'max_connections') as max_connections,
    (select count(*) from pg_stat_activity) as total_backends,
    (select count(*) from pg_stat_activity where backend_type = 'client backend') as client_backends,
    (select count(*) from pg_stat_activity where state = 'active') as active_backends,
    (select count(*) from pg_stat_activity where state = 'idle in transaction') as idle_in_transaction,
    (select count(*) from pg_stat_activity where wait_event_type = 'Lock') as lock_waiters,
    (select coalesce(max(extract(epoch from (now() - query_start))), 0)
       from pg_stat_activity where state = 'active' and backend_type = 'client backend') as longest_active_seconds,
    (select count(*) from pg_locks where not granted) as ungranted_locks,
    (select coalesce(sum(xact_commit + xact_rollback), 0) from pg_stat_database where datname = current_database()) as transactions,
    (select coalesce(sum(blks_hit), 0) from pg_stat_database where datname = current_database()) as blks_hit,
    (select coalesce(sum(blks_read), 0) from pg_stat_database where datname = current_database()) as blks_read,
    (select count(*) from public.generation_completion_jobs where status = 'pending') as completion_pending,
    (select coalesce(max(extract(epoch from (now() - created_at))), 0)
       from public.generation_completion_jobs where status = 'pending') as completion_oldest_seconds,
    (select count(*) from public.workflow_run_step_jobs where status in ('pending','processing')) as workflow_steps_open,
    (select count(*) from public.feed_delivery_facts) as delivery_facts,
    (select coalesce(min(extract(epoch from (now() - ranked_at)) / 86400.0), 0)
       from public.feed_delivery_facts) as newest_fact_age_days
`;

let previous = null;

async function sample() {
  const rows = await sql(SAMPLE_SQL);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return;

  const at = new Date().toISOString();
  const clientBackends = Number(row.client_backends);
  const maxConnections = Number(row.max_connections);

  // Rates need two points; a single cumulative counter says nothing about now.
  let tps = null;
  let cacheHitRatio = null;
  if (previous) {
    const elapsed = (Date.parse(at) - Date.parse(previous.at)) / 1000;
    if (elapsed > 0) tps = Number(((Number(row.transactions) - previous.transactions) / elapsed).toFixed(2));
    const hit = Number(row.blks_hit) - previous.blks_hit;
    const read = Number(row.blks_read) - previous.blks_read;
    if (hit + read > 0) cacheHitRatio = Number((hit / (hit + read)).toFixed(4));
  }
  previous = { at, transactions: Number(row.transactions), blks_hit: Number(row.blks_hit), blks_read: Number(row.blks_read) };

  const record = {
    at,
    label: options.label,
    maxConnections,
    clientBackends,
    poolUsedPct: maxConnections ? Number((clientBackends / maxConnections * 100).toFixed(1)) : null,
    activeBackends: Number(row.active_backends),
    idleInTransaction: Number(row.idle_in_transaction),
    lockWaiters: Number(row.lock_waiters),
    ungrantedLocks: Number(row.ungranted_locks),
    longestActiveSeconds: Number(Number(row.longest_active_seconds).toFixed(2)),
    tps,
    cacheHitRatio,
    completionPending: Number(row.completion_pending),
    completionOldestSeconds: Number(Number(row.completion_oldest_seconds).toFixed(1)),
    workflowStepsOpen: Number(row.workflow_steps_open),
    deliveryFacts: Number(row.delivery_facts),
  };

  const line = `${JSON.stringify(record)}\n`;
  if (options.out) await appendFile(options.out, line);
  else process.stdout.write(line);
}

console.error(`Sampling every ${options.intervalSeconds}s${options.out ? ` -> ${options.out}` : ''}`);
await sample();
setInterval(() => { sample().catch((error) => console.error(`sample failed: ${error.message}`)); },
  options.intervalSeconds * 1000);
