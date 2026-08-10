#!/usr/bin/env node
/**
 * The three named certification cases.
 *
 *   node scripts/certification/cert-cases.mjs skew
 *   node scripts/certification/cert-cases.mjs webhook-burst --count 500
 *   node scripts/certification/cert-cases.mjs provider-degradation
 *   node scripts/certification/cert-cases.mjs workflow-fanout --runs 20 --mode branch
 *   node scripts/certification/cert-cases.mjs cron-overlap
 *
 * webhook-burst needs a backlog of *pending* provider tasks, which only exists
 * if auto-completion is off while they are created:
 *   curl -X POST -H "x-cert-stub-secret: $CERT_STUB_SECRET" \
 *     -H 'content-type: application/json' $CERT_STUB_URL/stub/config \
 *     -d '{"completionDelaySeconds":0}'
 *   node scripts/certification/cert-load-test.mjs --only generation-start --rps 0.5 --duration 120
 * The 0.5 RPS priming rate stays below the configured per-model admission refill;
 * a 10 RPS priming burst mostly measures deliberate provider admission rejects.
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
const STUB_SECRET = process.env.CERT_STUB_SECRET;

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

function stubFetch(path, init = {}) {
  if (!STUB_SECRET) throw new Error('CERT_STUB_SECRET is required for provider stub control.');
  return fetch(new URL(path, STUB_URL), {
    ...init,
    headers: { 'x-cert-stub-secret': STUB_SECRET, ...(init.headers ?? {}) },
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

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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
    allPassed = report(
      'backend health reports no retention policy skew',
      false,
      'CERT_OPS_READ_SECRET is required; certification checks may not skip',
    ) && allPassed;
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
    allPassed = report(
      'cron drive is configured',
      false,
      'CERT_CRON_SECRET is required; certification checks may not skip',
    ) && allPassed;
  }

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 2 — deterministic provider degradation and ambiguous acceptance
// ---------------------------------------------------------------------------

async function runProviderDegradationCase() {
  console.log('Case: deterministic provider degradation\n');
  if (!CRON_SECRET) return report('completion worker is configured', false, 'CERT_CRON_SECRET is required');

  const user = await signIn(1);
  const startedAt = new Date().toISOString();
  const reset = await stubFetch('/stub/reset', { method: 'POST' });
  if (!reset.ok) return report('provider stub reset', false, `HTTP ${reset.status}`);

  const creditRows = await sql(`select credits from public.profiles where id = ${sqlString(user.userId)}`);
  const initialCredits = Number(creditRows[0]?.credits);
  if (!Number.isFinite(initialCredits)) return report('fixture credit balance is readable', false, JSON.stringify(creditRows));

  async function configure(next) {
    const response = await stubFetch('/stub/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        completionDelaySeconds: 0,
        rateLimitRate: 0,
        serverErrorRate: 0,
        nextRateLimitCount: 0,
        nextServerErrorCount: 0,
        nextAcceptedResetCount: 0,
        ...next,
      }),
    });
    if (!response.ok) throw new Error(`stub config failed: ${response.status}`);
  }

  async function start(key) {
    const response = await appFetch('/api/generate-image', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        model: 'nano-banana-2-lite',
        prompt: 'A cinematic portrait with warm natural light and detailed texture',
        settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg' },
      }),
    });
    return { response, body: await response.json().catch(() => ({})) };
  }

  let allPassed = true;
  await configure({ nextRateLimitCount: 1 });
  const rateLimited = await start(`cert-provider-429-${randomUUID()}`);
  allPassed = report(
    'provider 429 is returned as retryable busy',
    rateLimited.response.status === 429,
    `HTTP ${rateLimited.response.status}: ${JSON.stringify(rateLimited.body).slice(0, 180)}`,
  ) && allPassed;

  await configure({ nextServerErrorCount: 1 });
  const unavailable = await start(`cert-provider-503-${randomUUID()}`);
  allPassed = report(
    'provider 5xx fails the request without claiming success',
    unavailable.response.status >= 500,
    `HTTP ${unavailable.response.status}: ${JSON.stringify(unavailable.body).slice(0, 180)}`,
  ) && allPassed;

  const rejectedRows = await sql(`
    select status, refunded, submission_unknown_at
    from public.generations
    where user_id = ${sqlString(user.userId)} and created_at >= ${sqlString(startedAt)}
    order by created_at asc
  `);
  const creditsAfterRefusals = Number((await sql(
    `select credits from public.profiles where id = ${sqlString(user.userId)}`,
  ))[0]?.credits);
  allPassed = report(
    'definitive 429/5xx attempts are failed and fully refunded',
    rejectedRows.length === 2
      && rejectedRows.every((row) => row.status === 'failed' && row.refunded === true && !row.submission_unknown_at)
      && creditsAfterRefusals === initialCredits,
    `rows ${JSON.stringify(rejectedRows)}, credits ${initialCredits} -> ${creditsAfterRefusals}`,
  ) && allPassed;

  await configure({ nextAcceptedResetCount: 1 });
  const ambiguous = await start(`cert-provider-reset-${randomUUID()}`);
  allPassed = report(
    'accepted-then-reset returns stable submission_pending instead of generic 500',
    ambiguous.response.status === 409
      && ambiguous.body?.code === 'submission_pending'
      && typeof ambiguous.body?.generationId === 'string',
    `HTTP ${ambiguous.response.status}: ${JSON.stringify(ambiguous.body).slice(0, 220)}`,
  ) && allPassed;
  if (!allPassed || !ambiguous.body?.generationId) return false;

  const heldRows = await sql(`
    select id, status, prediction_id, submission_unknown_at, refunded, cost
    from public.generations where id = ${sqlString(ambiguous.body.generationId)}
  `);
  const heldCredits = Number((await sql(
    `select credits from public.profiles where id = ${sqlString(user.userId)}`,
  ))[0]?.credits);
  allPassed = report(
    'ambiguous provider work remains held and unrefunded until callback reconciliation',
    heldRows.length === 1
      && heldRows[0].status === 'pending'
      && heldRows[0].prediction_id === null
      && heldRows[0].submission_unknown_at
      && heldRows[0].refunded !== true
      && heldCredits === initialCredits - Number(heldRows[0].cost),
    `row ${JSON.stringify(heldRows[0])}, credits ${initialCredits} -> ${heldCredits}`,
  ) && allPassed;

  const burstResponse = await stubFetch('/stub/burst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count: 1 }),
  });
  const burst = burstResponse.ok ? await burstResponse.json() : null;
  allPassed = report(
    'the accepted ambiguous task delivers exactly one late callback',
    burstResponse.ok && burst?.fired === 1 && burst?.taskIds?.length === 1,
    JSON.stringify(burst),
  ) && allPassed;
  if (!allPassed) return false;

  const deadline = Date.now() + 300_000;
  let terminal = null;
  while (Date.now() < deadline) {
    const worker = await appFetch('/api/cron/generation-completions', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    }).catch(() => null);
    if (!worker || ![200, 202].includes(worker.status)) {
      return report('generation completion worker stayed available', false, worker ? `HTTP ${worker.status}` : 'request failed');
    }
    const rows = await sql(`
      select status, prediction_id, output_url, refunded
      from public.generations where id = ${sqlString(ambiguous.body.generationId)}
    `);
    terminal = rows[0] ?? null;
    if (terminal?.status === 'succeeded' && terminal.output_url) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const finalCredits = Number((await sql(
    `select credits from public.profiles where id = ${sqlString(user.userId)}`,
  ))[0]?.credits);
  allPassed = report(
    'late callback attaches, imports output and settles once without refunding the hold',
    terminal?.status === 'succeeded'
      && terminal.prediction_id === burst.taskIds[0]
      && terminal.output_url
      && terminal.refunded !== true
      && finalCredits === heldCredits,
    `terminal ${JSON.stringify(terminal)}, credits ${heldCredits} -> ${finalCredits}`,
  ) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 3 — webhook burst and completion draining
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

  if (!Number.isInteger(count) || count < 1) {
    return report('burst count is valid', false, '--count must be a positive integer');
  }
  if (!CRON_SECRET) {
    return report('completion worker is configured', false, 'CERT_CRON_SECRET is required');
  }

  // Prime first, or this measures nothing. Build the backlog with:
  //   curl -X POST -H "x-cert-stub-secret: $CERT_STUB_SECRET" \
  //     -H 'content-type: application/json' $CERT_STUB_URL/stub/config \
  //     -d '{"completionDelaySeconds":0}'
  //   node cert-load-test.mjs --only generation-start --rps 0.5 --duration 120
  const primed = await (await stubFetch('/stub/stats')).json();
  if (primed.tasksPending < count) {
    return report(
      'burst has the requested provider backlog available',
      false,
      `requested ${count}, only ${primed.tasksPending} pending — prime with --only generation-start`,
    );
  }

  const burstStartedAt = Date.now();
  const response = await stubFetch('/stub/burst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!response.ok) {
    return report('provider stub accepted burst request', false, `HTTP ${response.status}`);
  }
  const { fired, taskIds } = await response.json();
  console.log(`      fired ${fired} callbacks in ${Date.now() - burstStartedAt}ms`);

  let allPassed = report(
    'provider stub fired the exact requested task set',
    fired === count
      && Array.isArray(taskIds)
      && taskIds.length === count
      && new Set(taskIds).size === count,
    `requested ${count}, fired ${fired}, unique ids ${Array.isArray(taskIds) ? new Set(taskIds).size : 0}`,
  );
  if (!allPassed) return false;

  // Deltas, not absolutes. `callbacksSent`/`callbackFailures` are cumulative for
  // the stub process, which by this point in a certification run has also served
  // the ladder and two soaks — including periods when the app was timing out. On
  // the first run this scored 190 whole-session failures against a 48-callback
  // burst and reported it as a burst failure.
  const stats = await (await stubFetch('/stub/stats')).json();
  const sent = stats.callbacksSent - (primed.callbacksSent ?? 0);
  const failed = stats.callbackFailures - (primed.callbackFailures ?? 0);

  allPassed = report(
    'every callback in this burst was accepted by the webhook path',
    sent === fired && failed === 0,
    `burst sent ${sent}, failures ${failed}`
    + ` (session totals ${stats.callbacksSent}/${stats.callbackFailures})`,
  ) && allPassed;

  const predictionIds = taskIds.map(sqlString).join(',');

  // Draining is the half that matters: accepting a burst and then never
  // working it off is the failure mode, not the HTTP response. Polled to a
  // deadline rather than sampled once, because a single "after" reading cannot
  // tell a drained queue from one that has not started.
  const deadline = Date.now() + drainDeadlineSeconds * 1000;
  let after = null;
  let drained = false;
  while (Date.now() < deadline) {
    const cronResponse = await appFetch('/api/cron/generation-completions', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    }).catch(() => null);
    if (!cronResponse || ![200, 202].includes(cronResponse.status)) {
      return report(
        'generation completion worker returned an expected success status',
        false,
        cronResponse ? `HTTP ${cronResponse.status}` : 'request failed',
      );
    }
    after = await sql(`
      select count(*) filter (where status = 'pending') as pending,
             count(*) filter (where status = 'failed') as failed,
             count(*) filter (where status = 'succeeded') as succeeded,
             count(*) filter (where attempt_count > 1) as retried
      from public.generation_completion_jobs
      where prediction_id in (${predictionIds})
    `);
    if (Number(after[0]?.succeeded ?? 0) === count
      && Number(after[0]?.pending ?? 0) === 0
      && Number(after[0]?.failed ?? 0) === 0) {
      drained = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.log(`      burst queue state ${JSON.stringify(after)}`);
  allPassed = report(
    `all burst jobs settled successfully within ${drainDeadlineSeconds}s`,
    drained,
    drained
      ? `settled ${after?.[0]?.succeeded ?? 0}/${count} in ${Math.round((Date.now() - burstStartedAt) / 1000)}s`
        + `, retried ${after?.[0]?.retried ?? 0}`
      : `terminal state ${JSON.stringify(after?.[0] ?? null)}`,
  ) && allPassed;

  const settled = await sql(`
    select prediction_id, status, output_url, client_request_key_hash,
           cost, refunded
    from public.generations
    where prediction_id in (${predictionIds})
  `);
  const uniquePredictions = new Set(settled.map((row) => row.prediction_id));
  allPassed = report(
    'every fired task has one successful generation with an output',
    settled.length === count
      && uniquePredictions.size === count
      && settled.every((row) => (
        row.status === 'succeeded'
        && row.output_url
        && row.client_request_key_hash
        && Number(row.cost) > 0
        && row.refunded !== true
      )),
    `rows ${settled.length}/${count}, unique ${uniquePredictions.size}, outputs ${settled.filter((row) => row.output_url).length}`,
  ) && allPassed;

  const duplicates = await sql(`
    select prediction_id, count(*) as settlements
    from public.generations
    where prediction_id in (${predictionIds})
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
// Case 4 — workflow fan-out
// ---------------------------------------------------------------------------

/**
 * The worker owns one leased run ticket at a time, and provider-backed child
 * generations carry deterministic `(run,node,attempt)` request hashes. The
 * request only commits the run, complete step skeleton, and first ticket; it
 * does not call a provider. This case therefore verifies both intra-run branch
 * fan-out and cross-run concurrency without the old route/monitor race.
 *
 * Run-scoped leasing intentionally remains: dependency resolution needs a
 * consistent graph snapshot. This case does not certify independent per-node
 * retry accounting or poison-node isolation; those properties must remain an
 * explicit certificate exclusion until a one-node-per-claim executor exists.
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
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* validated by the caller */ }
  return { status: response.status, text, payload };
}

async function runWorkflowFanoutCase() {
  const runs = Number(argValue('--runs', '20'));
  const mode = argValue('--mode', 'branch');
  const startNodeType = argValue('--start-node', mode === 'node' ? 'image-generate' : 'text-input');
  console.log(`Case: workflow fan-out (${runs} runs, mode=${mode}, start=${startNodeType})\n`);
  if (!Number.isInteger(runs) || runs < 2) {
    return report('fan-out cardinality is valid', false, '--runs must be at least 2');
  }
  if (mode !== 'branch') {
    return report('fan-out mode is branch', false, 'workflow-fanout certification requires --mode branch');
  }
  if (!CRON_SECRET) {
    return report('workflow workers are configured', false, 'CERT_CRON_SECRET is required');
  }

  const users = await Promise.all(
    Array.from({ length: runs + 1 }, (_, index) => signIn(index + 1)),
  );
  const canvases = await Promise.all(users.map((user) => createCanvasForRun(user, startNodeType)));

  // --- replay: one key, three attempts, at most one run -------------------
  const idempotencyKey = randomUUID();
  const replayResults = await Promise.all(
    Array.from({ length: 3 }, () => startRun(users[0], canvases[0], mode, idempotencyKey)),
  );
  const replayStatuses = replayResults.map((result) => result.status);
  const replayRunIds = replayResults.map((result) => result.payload?.runId).filter(Boolean);
  console.log(`      replay statuses: ${replayStatuses.join(', ')}`);
  const replayRows = await sql(`
    select id from public.workflow_canvas_runs
    where canvas_id = ${sqlString(canvases[0].canvasId)}
      and idempotency_key = ${sqlString(idempotencyKey)}
  `);

  let allPassed = report(
    'three replay attempts return one durable run identity',
    replayStatuses.every((status) => status >= 200 && status < 300)
      && replayRunIds.length === 3
      && new Set(replayRunIds).size === 1
      && replayRows.length === 1
      && replayRows[0]?.id === replayRunIds[0],
    `DB rows ${replayRows.length}, response ids ${replayRunIds.join('/') || 'none'}, statuses ${replayStatuses.join('/')}`,
  );

  // --- fan-out: N concurrent runs, distinct keys ---------------------------
  const fanoutStartedAt = Date.now();
  const fanout = await Promise.all(users.slice(1, runs + 1).map((user, index) =>
    startRun(user, canvases[index + 1], mode, randomUUID())));
  const statuses = fanout.map((result) => result.status);
  const runIds = fanout.map((result) => result.payload?.runId).filter(Boolean);
  const nonSuccesses = statuses.filter((status) => status < 200 || status >= 300);
  console.log(`      ${fanout.length} concurrent starts in ${Date.now() - fanoutStartedAt}ms`
    + ` · statuses ${[...new Set(statuses)].sort().join(', ')}`);
  if (nonSuccesses.length > 0) {
    console.log(`      first failure body: ${fanout.find((r) => r.status < 200 || r.status >= 300)?.text.slice(0, 200)}`);
  }
  allPassed = report(
    'every concurrent run start returns 2xx with a unique run id',
    fanout.length === runs
      && nonSuccesses.length === 0
      && runIds.length === runs
      && new Set(runIds).size === runs,
    `${nonSuccesses.length}/${statuses.length} non-2xx; ${new Set(runIds).size}/${runs} unique run ids`,
  ) && allPassed;
  if (!allPassed) return false;
  const replayRunId = replayRunIds[0];

  if (runIds.length !== runs) return false;
  const allRunIds = [replayRunId, ...runIds];
  const expectedRunCount = runs + 1;
  const runIdSql = allRunIds.map(sqlString).join(',');
  const durableRows = await sql(`
    select r.id,
           count(distinct s.node_id) as steps,
           count(distinct j.id) as jobs
    from public.workflow_canvas_runs r
    left join public.workflow_canvas_run_steps s on s.run_id = r.id
    left join public.workflow_run_step_jobs j on j.run_id = r.id
    where r.id in (${runIdSql})
    group by r.id
  `);
  allPassed = report(
    'every run atomically owns a complete branch skeleton and queue ticket',
    durableRows.length === expectedRunCount
      && durableRows.every((row) => Number(row.steps) >= 3 && Number(row.jobs) >= 1),
    `rows ${durableRows.length}/${expectedRunCount}; minimum steps ${Math.min(...durableRows.map((row) => Number(row.steps) || 0))}`,
  ) && allPassed;

  // --- durability: the queue must own the work, not the request ------------
  // A run that is 'processing' with no step job is a run nothing will ever
  // advance — the stranded-run shape F12's durable queue exists to prevent.
  const orphaned = await sql(`
    select count(*) as orphaned
    from public.workflow_canvas_runs r
    where r.id in (${runIdSql})
      and r.status = 'processing'
      and not exists (
        select 1 from public.workflow_run_step_jobs j where j.run_id = r.id
      )
  `);
  allPassed = report(
    'no run left processing without a step job',
    Number(orphaned[0]?.orphaned ?? 0) === 0,
    `orphaned: ${orphaned[0]?.orphaned ?? 0}`,
  ) && allPassed;

  // Drive the leased worker until every branch has launched both generation
  // children, then complete exactly those provider tasks.
  const deadline = Date.now() + Number(argValue('--drain-deadline', '300')) * 1000;
  let generationRows = [];
  while (Date.now() < deadline) {
    const worker = await appFetch('/api/cron/workflow-run-steps', {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    if (![200, 202].includes(worker.status)) {
      return report('workflow worker returned an expected success status', false, `HTTP ${worker.status}`);
    }
    generationRows = await sql(`
      select s.run_id, s.node_id, g.id, g.prediction_id, g.status,
             g.output_url, g.client_request_key_hash
      from public.workflow_canvas_run_steps s
      join public.generations g on g.id = s.generation_id
      where s.run_id in (${runIdSql})
    `);
    const counts = new Map(allRunIds.map((id) => [id, 0]));
    for (const row of generationRows) counts.set(row.run_id, (counts.get(row.run_id) ?? 0) + 1);
    if ([...counts.values()].every((countValue) => countValue >= 2)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const providerTaskIds = generationRows.map((row) => row.prediction_id).filter(Boolean);
  allPassed = report(
    'every branch launched at least two provider-backed child nodes',
    providerTaskIds.length >= expectedRunCount * 2
      && allRunIds.every((runId) => generationRows.filter((row) => row.run_id === runId).length >= 2),
    `provider tasks ${providerTaskIds.length}, expected at least ${expectedRunCount * 2}`,
  ) && allPassed;
  if (!allPassed) return false;

  const stubBefore = await (await stubFetch('/stub/stats')).json();
  const burstResponse = await stubFetch('/stub/burst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds: providerTaskIds }),
  });
  const burst = burstResponse.ok ? await burstResponse.json() : null;
  const stubAfter = await (await stubFetch('/stub/stats')).json();
  allPassed = report(
    'workflow callbacks fired exactly once for the captured task set',
    burstResponse.ok
      && burst?.fired === providerTaskIds.length
      && Array.isArray(burst?.taskIds)
      && new Set(burst.taskIds).size === providerTaskIds.length
      && stubAfter.callbacksSent - stubBefore.callbacksSent === providerTaskIds.length
      && stubAfter.callbackFailures - stubBefore.callbackFailures === 0,
    `captured ${providerTaskIds.length}, fired ${burst?.fired ?? 0}, callback failures ${stubAfter.callbackFailures - stubBefore.callbackFailures}`,
  ) && allPassed;

  const terminalDeadline = Date.now() + Number(argValue('--drain-deadline', '300')) * 1000;
  let terminalRuns = [];
  while (allPassed && Date.now() < terminalDeadline) {
    for (const route of ['generation-completions', 'workflow-run-steps']) {
      const response = await appFetch(`/api/cron/${route}`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      if (![200, 202].includes(response.status)) {
        return report(`${route} returned an expected success status`, false, `HTTP ${response.status}`);
      }
    }
    terminalRuns = await sql(`
      select id, status from public.workflow_canvas_runs where id in (${runIdSql})
    `);
    if (terminalRuns.length === expectedRunCount && terminalRuns.every((row) => row.status === 'succeeded')) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  allPassed = report(
    'every fan-out run reached succeeded',
    terminalRuns.length === expectedRunCount && terminalRuns.every((row) => row.status === 'succeeded'),
    JSON.stringify(terminalRuns).slice(0, 300),
  ) && allPassed;

  const finalGenerations = await sql(`
    select g.prediction_id, g.status, g.output_url, g.client_request_key_hash,
           g.cost, g.refunded
    from public.workflow_canvas_run_steps s
    join public.generations g on g.id = s.generation_id
    where s.run_id in (${runIdSql})
  `);
  const duplicateKeys = new Map();
  for (const row of finalGenerations) {
    if (!row.client_request_key_hash) continue;
    duplicateKeys.set(row.client_request_key_hash, (duplicateKeys.get(row.client_request_key_hash) ?? 0) + 1);
  }
  allPassed = report(
    'workflow generations settled once with outputs and unique deterministic keys',
    finalGenerations.length === providerTaskIds.length
      && finalGenerations.every((row) => (
        row.status === 'succeeded'
        && row.output_url
        && row.client_request_key_hash
        && Number(row.cost) > 0
        && row.refunded !== true
      ))
      && [...duplicateKeys.values()].every((value) => value === 1),
    `terminal outputs ${finalGenerations.filter((row) => row.output_url).length}/${providerTaskIds.length}; duplicate keys ${[...duplicateKeys.values()].filter((value) => value > 1).length}`,
  ) && allPassed;

  const failedJobs = await sql(`
    select count(*) as failed from public.workflow_run_step_jobs
    where run_id in (${runIdSql}) and status = 'failed'
  `);
  allPassed = report(
    'workflow queue drained without failed tickets',
    Number(failedJobs[0]?.failed ?? 0) === 0,
    `failed step jobs: ${failedJobs[0]?.failed ?? 0}`,
  ) && allPassed;

  return allPassed;
}

// ---------------------------------------------------------------------------
// Case 5 — cron overlap with retention cleanup
// ---------------------------------------------------------------------------

async function runCronOverlapCase() {
  console.log('Case: cron overlap with retention cleanup\n');
  if (!CRON_SECRET) {
    return report('cron secret is configured', false, 'CERT_CRON_SECRET is required');
  }

  // Fire the overlapping jobs concurrently — the shared-fate condition F14
  // split apart. Under a job lock, a second concurrent invocation should be
  // refused cleanly rather than both running or both failing.
  const jobs = [
    'backend-jobs',
    'generation-completions',
    'media-preview-repair',
    'workflow-run-steps',
    'operational-data-retention',
  ];
  const responses = await Promise.all(jobs.flatMap((job) => [
    appFetch(`/api/cron/${job}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
    appFetch(`/api/cron/${job}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }),
  ]));

  const statuses = responses.map((response) => response.status);
  console.log(`      statuses: ${statuses.join(', ')}`);
  const expectedStatuses = statuses.every((status) => status === 200 || status === 202);

  let allPassed = report(
    'every concurrent cron invocation returns only an expected success status',
    expectedStatuses,
    statuses.join(', '),
  );

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

  const dedicated = await sql(`
    select job_name, count(*) as runs,
           count(*) filter (where status in ('succeeded', 'skipped')) as clean,
           count(*) filter (where status = 'skipped') as skipped
    from public.backend_job_runs
    where started_at > now() - interval '5 minutes'
      and job_name in (
        'generation-completions', 'media-preview-repair',
        'workflow-run-steps', 'operational-data-retention'
      )
    group by job_name
  `);
  const expectedJobs = new Set([
    'generation-completions',
    'media-preview-repair',
    'workflow-run-steps',
    'operational-data-retention',
  ]);
  const observedJobs = new Map(dedicated.map((row) => [row.job_name, row]));
  allPassed = report(
    'every dedicated topology route recorded a clean managed-job outcome',
    [...expectedJobs].every((job) => (
      Number(observedJobs.get(job)?.runs ?? 0) >= 1
      && Number(observedJobs.get(job)?.clean ?? 0) === Number(observedJobs.get(job)?.runs ?? 0)
      && Number(observedJobs.get(job)?.skipped ?? 0) >= 1
    )),
    JSON.stringify(dedicated).slice(0, 400),
  ) && allPassed;

  return allPassed;
}

const CASES = {
  skew: runSkewCase,
  'provider-degradation': runProviderDegradationCase,
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
