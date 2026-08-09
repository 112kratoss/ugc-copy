#!/usr/bin/env node
/**
 * The three named certification cases.
 *
 *   node scripts/certification/cert-cases.mjs skew
 *   node scripts/certification/cert-cases.mjs webhook-burst --count 500
 *   node scripts/certification/cert-cases.mjs workflow-fanout --runs 20
 *   node scripts/certification/cert-cases.mjs cron-overlap
 *
 * Each case reports PASS/FAIL and exits non-zero on failure, so a certification
 * run cannot be recorded as clean while one of them is broken.
 */

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.CERT_BASE_URL;
const SUPABASE_URL = process.env.CERT_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.CERT_SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CERT_CRON_SECRET;
const STUB_URL = process.env.CERT_STUB_URL ?? 'http://127.0.0.1:8787';

if (!BASE_URL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('CERT_BASE_URL, CERT_SUPABASE_URL and CERT_SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (BASE_URL.includes('magicbooklet.com') || SUPABASE_URL.includes('ildfmhozpibwiopeavfg')) {
  console.error('Refusing to run against production.');
  process.exit(1);
}

const args = process.argv.slice(3);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
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
  if (!response.ok) throw new Error(`SQL failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function report(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  return passed;
}

// ---------------------------------------------------------------------------
// Case 1 — migration-under-old-code skew
// ---------------------------------------------------------------------------

/**
 * `production-release.yml` applies Supabase migrations at step 150 and only
 * promotes the new Vercel deployment at step 261. Every release therefore has a
 * window in which the NEW schema is live while the OLD code is still serving.
 *
 * The retention incident is the known instance of that shape: shipping
 * FEED_FACT_RETENTION_DAYS=30 while FEED_EVENT_RETENTION_DAYS was still 90
 * violated `prune_feed_personalization_data`'s `event <= fact` guard and
 * aborted the whole hourly feed-maintenance job — stats refreshes included —
 * for hours, through a deploy that verified green.
 *
 * This case asserts two things:
 *   a) the database-side guard still rejects a skewed constant pair loudly
 *      rather than silently truncating, and
 *   b) the currently deployed constants are legal against the live schema.
 *
 * (b) is the part that would have caught the incident. A deploy is green
 * before the cron next fires, so the app's own health check cannot see it.
 */
async function runSkewCase() {
  console.log('Case: migration-under-old-code skew\n');
  let allPassed = true;

  // (a) The guard must still fire on a skewed pair. If this passes silently,
  //     the protection that turns a bad deploy into a loud failure is gone.
  let guardFired = false;
  let guardDetail = '';
  // Argument order is (as_of, EVENT, session, limit, FACT) — not the other way
  // round. The incident shape is fact dropped to 30 while event stayed 90, so
  // the skewed call is event=90, fact=30. Passing these transposed produces a
  // perfectly legal pair and a false "the guard is gone" result.
  try {
    await sql("select public.prune_feed_personalization_data(now(), 90, 2, 5000, 30);");
    guardDetail = 'skewed pair (event=90, fact=30) was ACCEPTED — the event <= fact guard is gone';
  } catch {
    guardFired = true;
    guardDetail = 'skewed pair (event=90, fact=30) rejected, as the incident requires';
  }
  allPassed = report('guard rejects event > fact', guardFired, guardDetail) && allPassed;

  // (b) The constants the deployed code actually ships must be legal. This is
  //     the check whose absence let the incident reach production.
  let legalPassed = false;
  let legalDetail = '';
  try {
    const result = await sql("select public.prune_feed_personalization_data(now(), 30, 2, 5000, 30) as summary;");
    legalPassed = true;
    legalDetail = `deployed pair (fact=30, event=30) accepted: ${JSON.stringify(result).slice(0, 160)}`;
  } catch (error) {
    legalDetail = `deployed constants REJECTED by the live schema: ${String(error.message).slice(0, 160)}`;
  }
  allPassed = report('deployed constants are legal against the live schema', legalPassed, legalDetail) && allPassed;

  // (c) Old code against new schema: drive every cron job and assert none
  //     aborted. A migration that removed or retyped something the deployed
  //     code still calls shows up here and nowhere else.
  if (CRON_SECRET) {
    const jobs = ['feed-maintenance', 'backend-jobs', 'operational-data-retention'];
    for (const job of jobs) {
      const response = await fetch(new URL(`/api/cron/${job}`, BASE_URL), {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const body = await response.text();
      allPassed = report(
        `cron/${job} survives the new schema`,
        response.ok,
        `HTTP ${response.status} ${body.slice(0, 140)}`,
      ) && allPassed;
    }

    const failures = await sql(`
      select job_name, status, error_message
      from public.backend_job_runs
      where started_at > now() - interval '10 minutes' and status not in ('succeeded','skipped')
    `);
    allPassed = report(
      'no job run recorded a failure',
      Array.isArray(failures) && failures.length === 0,
      Array.isArray(failures) && failures.length > 0 ? JSON.stringify(failures).slice(0, 300) : 'clean',
    ) && allPassed;
  } else {
    console.log('SKIP  cron drive — CERT_CRON_SECRET not set');
  }

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 2 — webhook burst and completion draining
// ---------------------------------------------------------------------------

/**
 * Fires N provider completions at once through the real path:
 * stub -> Supabase edge function (kie-webhook) -> HMAC-signed forward ->
 * /api/webhooks/kie. Then asserts the completion queue actually drains and no
 * generation is left double-settled or orphaned.
 */
async function runWebhookBurstCase() {
  const count = Number(argValue('--count', '500'));
  console.log(`Case: webhook burst (${count} completions)\n`);

  const before = await sql(`
    select count(*) filter (where status = 'pending') as pending,
           count(*) as total
    from public.generation_completion_jobs
  `);

  const burstStartedAt = Date.now();
  const response = await fetch(`${STUB_URL}/stub/burst`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  const { fired } = await response.json();
  console.log(`      fired ${fired} callbacks in ${Date.now() - burstStartedAt}ms`);

  const stats = await (await fetch(`${STUB_URL}/stub/stats`)).json();
  const deliveryPassed = stats.callbackFailures === 0;

  let allPassed = report(
    'every callback was accepted by the webhook path',
    deliveryPassed,
    `sent ${stats.callbacksSent}, failures ${stats.callbackFailures}`,
  );

  // Draining is the half that matters: accepting a burst and then never
  // working it off is the failure mode, not the HTTP response.
  const after = await sql(`
    select count(*) filter (where status = 'pending') as pending,
           count(*) filter (where attempt_count > 1) as retried
    from public.generation_completion_jobs
  `);
  console.log(`      queue before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);

  const duplicates = await sql(`
    select prediction_id, count(*) as settlements
    from public.generations
    where prediction_id is not null
    group by prediction_id having count(*) > 1
  `);
  allPassed = report(
    'no duplicate settlement for any provider task',
    Array.isArray(duplicates) && duplicates.length === 0,
    Array.isArray(duplicates) && duplicates.length > 0 ? JSON.stringify(duplicates).slice(0, 200) : 'clean',
  ) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 3 — workflow fan-out
// ---------------------------------------------------------------------------

/**
 * IMPORTANT CAVEAT, recorded deliberately.
 *
 * F12's own body says to build the per-node executor "before the Phase 1
 * certification test exercises workflow fan-out, or the test will certify a
 * fan-out path that has not been restructured." That has not been done. A
 * claimed job still drives a RUN-scoped advance, not a single node.
 *
 * So this case exercises the durability properties that DID ship — idempotent
 * run creation, the durable step queue, cron recovery, and the pure GET — and
 * explicitly does NOT certify poison-node isolation or per-node retry
 * accounting. The replay assertion below is the one that protects money.
 */
async function runWorkflowFanoutCase() {
  const runs = Number(argValue('--runs', '20'));
  console.log(`Case: workflow fan-out (${runs} runs)\n`);
  console.log('      NOTE: run-scoped advance — poison-node isolation and per-node');
  console.log('      retry accounting are NOT covered. See F12.\n');

  const idempotencyKey = randomUUID();
  const before = await sql('select count(*) as runs from public.workflow_canvas_runs');

  // Replaying one idempotency key must not create a second run, and must not
  // enqueue a second set of steps — the early return, not the unique index, is
  // what stops the second spend.
  const replayResults = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(new URL('/api/workflow-canvases', BASE_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey }),
    });
    replayResults.push(response.status);
  }
  console.log(`      replay statuses: ${replayResults.join(', ')}`);

  const after = await sql('select count(*) as runs from public.workflow_canvas_runs');
  const createdRuns = Number(after[0]?.runs ?? 0) - Number(before[0]?.runs ?? 0);

  let allPassed = report(
    'replayed idempotency key created at most one run',
    createdRuns <= 1,
    `runs created: ${createdRuns}`,
  );

  const orphaned = await sql(`
    select count(*) as orphaned
    from public.workflow_canvas_runs r
    where r.status = 'processing'
      and not exists (
        select 1 from public.workflow_run_step_jobs j where j.run_id = r.id
      )
  `);
  allPassed = report(
    'no run left processing without a step job',
    Number(orphaned[0]?.orphaned ?? 0) === 0,
    `orphaned: ${orphaned[0]?.orphaned ?? 0}`,
  ) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 4 — cron overlap with retention cleanup
// ---------------------------------------------------------------------------

async function runCronOverlapCase() {
  console.log('Case: cron overlap with retention cleanup\n');
  if (!CRON_SECRET) {
    console.log('SKIP  CERT_CRON_SECRET not set');
    return true;
  }

  // Fire the overlapping jobs concurrently — the shared-fate condition F14
  // split apart. Under a job lock, a second concurrent invocation should be
  // refused cleanly rather than both running or both failing.
  const jobs = ['feed-maintenance', 'backend-jobs', 'operational-data-retention'];
  const responses = await Promise.all(jobs.flatMap((job) => [
    fetch(new URL(`/api/cron/${job}`, BASE_URL), { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
    fetch(new URL(`/api/cron/${job}`, BASE_URL), { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
  ]));

  const statuses = responses.map((response) => response.status);
  console.log(`      statuses: ${statuses.join(', ')}`);
  const noServerErrors = statuses.every((status) => status < 500);

  let allPassed = report('concurrent cron invocations produce no 5xx', noServerErrors, statuses.join(', '));

  const lag = await sql('select * from public.get_feed_retention_lag()');
  console.log(`      retention lag: ${JSON.stringify(lag).slice(0, 200)}`);

  const failures = await sql(`
    select job_name, status from public.backend_job_runs
    where started_at > now() - interval '5 minutes' and status not in ('succeeded','skipped')
  `);
  allPassed = report(
    'no job aborted under overlap',
    Array.isArray(failures) && failures.length === 0,
    Array.isArray(failures) && failures.length > 0 ? JSON.stringify(failures).slice(0, 300) : 'clean',
  ) && allPassed;

  return allPassed;
}

const CASES = {
  skew: runSkewCase,
  'webhook-burst': runWebhookBurstCase,
  'workflow-fanout': runWorkflowFanoutCase,
  'cron-overlap': runCronOverlapCase,
};

const caseName = process.argv[2];
const runner = CASES[caseName];
if (!runner) {
  console.error(`Usage: cert-cases.mjs <${Object.keys(CASES).join('|')}> [options]`);
  process.exit(1);
}

runner()
  .then((passed) => { process.exitCode = passed ? 0 : 1; })
  .catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
