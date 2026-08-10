#!/usr/bin/env node
/**
 * The three named certification cases.
 *
 *   node scripts/certification/cert-cases.mjs skew
 *   node scripts/certification/cert-cases.mjs webhook-burst --count 500
 *   node scripts/certification/cert-cases.mjs workflow-fanout --runs 20 --mode branch
 *   node scripts/certification/cert-cases.mjs cron-overlap
 *
 * webhook-burst needs a backlog of *pending* provider tasks, which only exists
 * if auto-completion is off while they are created:
 *   curl -X POST $CERT_STUB_URL/stub/config -d '{"completionDelaySeconds":0}'
 *   node scripts/certification/cert-load-test.mjs --only generation-start --rps 10 --duration 60
 *
 * Each case reports PASS/FAIL and exits non-zero on failure, so a certification
 * run cannot be recorded as clean while one of them is broken.
 */

import { randomUUID } from 'node:crypto';

const BASE_URL = process.env.CERT_BASE_URL;
const SUPABASE_URL = process.env.CERT_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.CERT_SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CERT_CRON_SECRET;
const OPS_READ_SECRET = process.env.CERT_OPS_READ_SECRET;
const STUB_URL = process.env.CERT_STUB_URL ?? 'http://127.0.0.1:8787';

/** See the note in cert-load-test.mjs — preview deployments sit behind SSO. */
const BYPASS_HEADERS = process.env.CERT_BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': process.env.CERT_BYPASS_SECRET }
  : {};

/**
 * Every call to the app under test goes through here so the bypass header can
 * never be forgotten at one call site and silently turn a case into a 302.
 */
function appFetch(path, init = {}) {
  return fetch(new URL(path, BASE_URL), {
    ...init,
    headers: { ...BYPASS_HEADERS, ...(init.headers ?? {}) },
  });
}

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

const SUPABASE_ANON_KEY = process.env.CERT_SUPABASE_ANON_KEY;
const SEED_PASSWORD = process.env.CERT_SEED_PASSWORD ?? 'cert-load-test-password';

/**
 * Cases that drive user-facing routes need real tokens for the same reason the
 * load driver does: the E2E bypass skips the local-JWT path F8 introduced, so a
 * case run through it would exercise auth the product does not use.
 */
async function signIn(index) {
  if (!SUPABASE_ANON_KEY) throw new Error('CERT_SUPABASE_ANON_KEY is required for authenticated cases.');
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `cert-user-${index}@cert.invalid`, password: SEED_PASSWORD }),
  });
  if (!response.ok) throw new Error(`Sign-in failed for cert-user-${index}: ${response.status}`);
  const payload = await response.json();
  return { userId: payload.user?.id ?? null, accessToken: payload.access_token };
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
 * This case asserts three things:
 *   a) a skewed constant pair is clamped *visibly* rather than silently, and
 *   b) the currently deployed constants are legal against the live schema, and
 *   c) backend health reports the skew without anyone having to run a query.
 *
 * (b) is the part that would have caught the incident. A deploy is green
 * before the cron next fires, so the app's own health check cannot see it.
 *
 * The (a) assertion was rewritten after audit *Finding B*. It used to require an
 * exception, which was correct until `20260809230000_report_feed_retention_clamp`
 * replaced the abort with a reported clamp — against the fixed function the old
 * assertion fails on working code, which is the worst kind of test. It now
 * follows the audit's own updated recipe.
 */
async function runSkewCase() {
  console.log('Case: migration-under-old-code skew\n');
  let allPassed = true;

  // (a) A skewed pair must come back clamped AND flagged. Silence here is the
  //     failure mode: the sweep keeps up while retaining the wrong window.
  let clampReported = false;
  let clampDetail = '';
  // Argument order is (as_of, EVENT, session, limit, FACT) — not the other way
  // round. The incident shape is fact dropped to 30 while event stayed 90, so
  // the skewed call is event=90, fact=30. Passing these transposed produces a
  // perfectly legal pair and a false "the clamp is gone" result.
  try {
    const rows = await sql("select public.prune_feed_personalization_data(now(), 90, 2, 5000, 30) as summary;");
    const summary = rows?.[0]?.summary ?? {};
    clampReported = summary.fact_retention_clamped === true
      && Number(summary.fact_retention_days_applied) === 90
      && Number(summary.fact_retention_days_requested) === 30;
    clampDetail = clampReported
      ? 'skewed pair (event=90, fact=30) clamped to 90 and flagged, as Finding B requires'
      : `clamp not reported: ${JSON.stringify(summary).slice(0, 200)}`;
  } catch (error) {
    clampDetail = `skewed pair raised instead of reporting: ${String(error.message).slice(0, 160)}`;
  }
  allPassed = report('skewed pair is clamped and the clamp is reported', clampReported, clampDetail) && allPassed;

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

  // (c) The clamp is only safe if something *watches* for the skew, since the
  //     job now succeeds either way. Health reports it from the two deployed
  //     constants without a query, so a clean report here means the deployed
  //     pair is unskewed — which is the state the incident left behind.
  if (OPS_READ_SECRET) {
    try {
      const response = await appFetch('/api/ops/backend-health', {
        headers: { Authorization: `Bearer ${OPS_READ_SECRET}` },
      });
      // Deliberately does NOT require `response.ok`. Backend health answers 503
      // whenever anything is degraded, and in a certification environment plenty
      // legitimately is: a preview deployment gets no Vercel cron, so four jobs
      // report JOB_NO_RECENT_RUN, and the payment keys are intentionally unset.
      // What this case asserts is narrower and is the thing Finding B is about —
      // that the retention policy skew is *absent* from what health reports.
      // Requiring green health would fail on the environment and say nothing
      // about the skew.
      const body = await response.text();
      const hasSkew = body.includes('FEED_RETENTION_POLICY_SKEW');
      const readable = body.includes('feedRetentionLag') || body.includes('"status"');
      allPassed = report(
        'backend health reports no retention policy skew',
        readable && !hasSkew,
        hasSkew
          ? 'FEED_RETENTION_POLICY_SKEW present — the deployed constants are skewed'
          : `HTTP ${response.status}, health readable, no skew issue reported`,
      ) && allPassed;
    } catch (error) {
      allPassed = report('backend health reports no retention policy skew', false, error.message) && allPassed;
    }
  } else {
    console.log('SKIP  backend-health skew check — CERT_OPS_READ_SECRET not set');
  }

  // (d) Old code against new schema: drive every cron job and assert none
  //     aborted. A migration that removed or retyped something the deployed
  //     code still calls shows up here and nowhere else.
  if (CRON_SECRET) {
    const jobs = ['feed-maintenance', 'backend-jobs', 'operational-data-retention'];
    for (const job of jobs) {
      const response = await appFetch(`/api/cron/${job}`, {
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
  const drainDeadlineSeconds = Number(argValue('--drain-deadline', '300'));
  console.log(`Case: webhook burst (${count} completions)\n`);

  // Prime first, or this measures nothing. Build the backlog with:
  //   curl -X POST $CERT_STUB_URL/stub/config -d '{"completionDelaySeconds":0}'
  //   node cert-load-test.mjs --only generation-start --rps 10 --duration 60
  const primed = await (await fetch(`${STUB_URL}/stub/stats`)).json();
  if (primed.tasksPending < count) {
    console.log(`      only ${primed.tasksPending} pending provider tasks for a burst of ${count}`);
    if (primed.tasksPending === 0) {
      return report('burst has provider tasks to fire', false, 'no pending tasks — prime with --only generation-start');
    }
  }

  const before = await sql(`
    select count(*) filter (where status = 'pending') as pending,
           count(*) as total
    from public.generation_completion_jobs
  `);
  const basePending = Number(before[0]?.pending ?? 0);

  const burstStartedAt = Date.now();
  const response = await fetch(`${STUB_URL}/stub/burst`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  const { fired } = await response.json();
  console.log(`      fired ${fired} callbacks in ${Date.now() - burstStartedAt}ms`);

  // Deltas, not absolutes. `callbacksSent`/`callbackFailures` are cumulative for
  // the stub process, which by this point in a certification run has also served
  // the ladder and two soaks — including periods when the app was timing out. On
  // the first run this scored 190 whole-session failures against a 48-callback
  // burst and reported it as a burst failure.
  const stats = await (await fetch(`${STUB_URL}/stub/stats`)).json();
  const sent = stats.callbacksSent - (primed.callbacksSent ?? 0);
  const failed = stats.callbackFailures - (primed.callbackFailures ?? 0);

  let allPassed = report(
    'every callback in this burst was accepted by the webhook path',
    failed === 0,
    `burst sent ${sent}, failures ${failed}`
    + ` (session totals ${stats.callbacksSent}/${stats.callbackFailures})`,
  );

  // Draining is the half that matters: accepting a burst and then never
  // working it off is the failure mode, not the HTTP response. Polled to a
  // deadline rather than sampled once, because a single "after" reading cannot
  // tell a drained queue from one that has not started.
  const deadline = Date.now() + drainDeadlineSeconds * 1000;
  let after = null;
  let drained = false;
  while (Date.now() < deadline) {
    if (CRON_SECRET) {
      await appFetch('/api/cron/backend-jobs', {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }).catch(() => {});
    }
    after = await sql(`
      select count(*) filter (where status = 'pending') as pending,
             count(*) filter (where status = 'failed') as failed,
             count(*) filter (where attempt_count > 1) as retried
      from public.generation_completion_jobs
    `);
    // Back to the pre-burst level, not to absolute zero: the mix is still
    // producing generations, so a steady trickle of freshly-enqueued jobs is
    // expected and is not the burst failing to drain.
    if (Number(after[0]?.pending ?? 0) <= basePending) { drained = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.log(`      queue before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  allPassed = report(
    `completion queue drained to its pre-burst level within ${drainDeadlineSeconds}s`,
    drained,
    drained
      ? `drained in ${Math.round((Date.now() - burstStartedAt) / 1000)}s to ${after?.[0]?.pending ?? 0}`
        + ` (pre-burst ${basePending}), retried ${after?.[0]?.retried ?? 0}`
      : `still pending: ${after?.[0]?.pending ?? 'unknown'} against pre-burst ${basePending}`,
  ) && allPassed;

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
/**
 * Creates a canvas for a signed-in user and returns its id plus the node the
 * run should start from. A canvas created with no graph gets `createStarterGraph`,
 * whose prompt node branches into image and video generation — so the same
 * fixture serves both `branch` (intra-run fan-out) and `node` (one generation).
 */
async function createCanvasForRun(user, startNodeType) {
  const response = await appFetch('/api/workflow-canvases', {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `cert fan-out ${randomUUID().slice(0, 8)}` }),
  });
  if (!response.ok) throw new Error(`Canvas create failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  const canvas = payload?.canvas ?? payload;
  const nodes = canvas?.graph?.nodes ?? [];
  const startNode = nodes.find((node) => node?.type === startNodeType);
  if (!canvas?.id || !startNode?.id) {
    throw new Error(`Canvas created without a ${startNodeType} node: ${JSON.stringify(canvas).slice(0, 200)}`);
  }
  return { canvasId: canvas.id, startNodeId: startNode.id };
}

async function startRun(user, canvas, mode, idempotencyKey) {
  const response = await appFetch(`/api/workflow-canvases/${canvas.canvasId}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({ startNodeId: canvas.startNodeId, mode }),
  });
  return { status: response.status, body: await response.text() };
}

async function runWorkflowFanoutCase() {
  const runs = Number(argValue('--runs', '20'));
  const mode = argValue('--mode', 'branch');
  const startNodeType = argValue('--start-node', mode === 'node' ? 'image-generate' : 'text-input');
  console.log(`Case: workflow fan-out (${runs} runs, mode=${mode}, start=${startNodeType})\n`);
  console.log('      NOTE: run-scoped advance — poison-node isolation and per-node');
  console.log('      retry accounting are NOT covered. See F12.\n');

  const users = await Promise.all(
    Array.from({ length: runs }, (_, index) => signIn(index + 1)),
  );
  const canvases = await Promise.all(users.map((user) => createCanvasForRun(user, startNodeType)));

  // --- replay: one key, three attempts, at most one run -------------------
  const idempotencyKey = randomUUID();
  const beforeReplay = await sql('select count(*) as runs from public.workflow_canvas_runs');
  const replayResults = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    replayResults.push((await startRun(users[0], canvases[0], mode, idempotencyKey)).status);
  }
  console.log(`      replay statuses: ${replayResults.join(', ')}`);
  const afterReplay = await sql('select count(*) as runs from public.workflow_canvas_runs');
  const replayCreated = Number(afterReplay[0]?.runs ?? 0) - Number(beforeReplay[0]?.runs ?? 0);

  let allPassed = report(
    'replayed idempotency key created at most one run',
    replayCreated <= 1 && replayResults.every((status) => status < 500),
    `runs created: ${replayCreated}, statuses ${replayResults.join('/')}`,
  );

  // --- fan-out: N concurrent runs, distinct keys ---------------------------
  const beforeFanout = await sql('select count(*) as runs from public.workflow_canvas_runs');
  const fanoutStartedAt = Date.now();
  const fanout = await Promise.all(users.slice(1).map((user, index) =>
    startRun(user, canvases[index + 1], mode, randomUUID())));
  const statuses = fanout.map((result) => result.status);
  const serverErrors = statuses.filter((status) => status >= 500);
  console.log(`      ${fanout.length} concurrent starts in ${Date.now() - fanoutStartedAt}ms`
    + ` · statuses ${[...new Set(statuses)].sort().join(', ')}`);
  if (serverErrors.length > 0) {
    console.log(`      first 5xx body: ${fanout.find((r) => r.status >= 500)?.body.slice(0, 200)}`);
  }
  allPassed = report(
    'concurrent run starts produce no 5xx',
    serverErrors.length === 0,
    `${serverErrors.length}/${statuses.length} were 5xx`,
  ) && allPassed;

  const afterFanout = await sql('select count(*) as runs from public.workflow_canvas_runs');
  const fanoutCreated = Number(afterFanout[0]?.runs ?? 0) - Number(beforeFanout[0]?.runs ?? 0);
  const accepted = statuses.filter((status) => status < 400).length;
  allPassed = report(
    'every accepted start created exactly one run',
    fanoutCreated === accepted,
    `accepted ${accepted}, runs created ${fanoutCreated}`,
  ) && allPassed;

  // --- durability: the queue must own the work, not the request ------------
  // A run that is 'processing' with no step job is a run nothing will ever
  // advance — the stranded-run shape F12's durable queue exists to prevent.
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

  // Cron recovery is the other half that shipped: drive the dispatcher and
  // assert it advances the queue rather than leaving it where the request left it.
  if (CRON_SECRET) {
    for (let pass = 0; pass < 3; pass += 1) {
      await appFetch('/api/cron/backend-jobs', {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    const queue = await sql(`
      select status, count(*) as jobs
      from public.workflow_run_step_jobs
      group by status order by status
    `);
    console.log(`      step queue after cron: ${JSON.stringify(queue)}`);
    const failedJobs = await sql(`
      select count(*) as failed from public.workflow_run_step_jobs
      where status = 'failed' and updated_at > now() - interval '10 minutes'
    `);
    allPassed = report(
      'cron advanced the step queue without failing jobs',
      Number(failedJobs[0]?.failed ?? 0) === 0,
      `failed step jobs: ${failedJobs[0]?.failed ?? 0}`,
    ) && allPassed;
  } else {
    console.log('SKIP  cron recovery — CERT_CRON_SECRET not set');
  }

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
    appFetch(`/api/cron/${job}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
    appFetch(`/api/cron/${job}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
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
