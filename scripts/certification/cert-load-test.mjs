#!/usr/bin/env node
/**
 * Phase 1 certification load driver.
 *
 * The existing `scripts/performance-load-test.mjs` cannot do this job and was
 * not meant to: it asserts every target is a read-only GET, caps origin
 * concurrency at 2 and origin duration at 60s. Certification needs writes,
 * authentication, uploads, webhooks and a one-hour soak at up to 100 RPS.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. **Real tokens, not the E2E bypass.** F8 replaced a GoTrue round-trip with
 *    local JWT verification against a cached JWKS. `E2E_AUTH_BYPASS` skips that
 *    path entirely, so a run using it would certify an auth path the product
 *    does not use. Tokens are minted by real password grants and refreshed
 *    mid-run, because they expire in exactly 3600s — the soak's own length.
 *
 * 2. **The user pool is derived from the rate limits.** The for-you feed allows
 *    60 reads per 10 minutes per identity, so ~300 users are the arithmetic
 *    minimum at 100 RPS of ranked reads and anything smaller measures
 *    `check_backend_rate_limit` rather than the feed. 429s are counted
 *    separately from errors for exactly this reason: a throttled request is the
 *    limiter working, not the app failing.
 *
 * 3. **Cursor continuation is a distinct workload.** F11 was a bug where the
 *    web feed dropped its cursor and re-ranked from zero on every load-more,
 *    re-persisting facts each time. A driver that only ever requests page one
 *    cannot observe the fix or its regression, so ranked reads carry their
 *    cursor forward per user.
 *
 * Usage:
 *   node scripts/certification/cert-load-test.mjs --rps 25 --duration 300
 *   node scripts/certification/cert-load-test.mjs --rps 50 --duration 3600 --out soak.json
 *   node scripts/certification/cert-load-test.mjs --rps 25 --duration 120 --exclude-anonymous
 *   node scripts/certification/cert-load-test.mjs --only generation-start --rps 10 --duration 60
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const options = {
  rps: 10,
  durationSeconds: 60,
  users: 500,
  out: null,
  label: null,
  warmupSeconds: 5,
};

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === '--rps') { options.rps = Number(value); index += 1; }
  else if (argument === '--duration') { options.durationSeconds = Number(value); index += 1; }
  else if (argument === '--users') { options.users = Number(value); index += 1; }
  else if (argument === '--out') { options.out = value; index += 1; }
  else if (argument === '--label') { options.label = value; index += 1; }
  else if (argument === '--warmup') { options.warmupSeconds = Number(value); index += 1; }
  else if (argument === '--disable') { options.disabled = value.split(',').map((name) => name.trim()); index += 1; }
  else if (argument === '--only') { options.only = value.split(',').map((name) => name.trim()); index += 1; }
  else if (argument === '--exclude-anonymous') { options.excludeAnonymous = true; }
}
options.disabled = options.disabled ?? [];
options.only = options.only ?? null;
options.excludeAnonymous = options.excludeAnonymous ?? false;

const BASE_URL = process.env.CERT_BASE_URL;
const SUPABASE_URL = process.env.CERT_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.CERT_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.CERT_SUPABASE_SERVICE_ROLE_KEY;
const SEED_PASSWORD = process.env.CERT_SEED_PASSWORD ?? 'cert-load-test-password';

if (!BASE_URL || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('CERT_BASE_URL, CERT_SUPABASE_URL and CERT_SUPABASE_ANON_KEY are required.');
  process.exit(1);
}
if (BASE_URL.includes('magicbooklet.com')) {
  console.error('Refusing to run: CERT_BASE_URL points at production.');
  process.exit(1);
}

/**
 * Weights approximate a creation-community session: mostly reading the ranked
 * feed and emitting telemetry about it, with a thin tail of writes and an even
 * thinner tail of paid work. They sum to 100.
 */
const WORKLOAD = [
  { name: 'feed-for-you', weight: 26, authenticated: true },
  { name: 'feed-events', weight: 24, authenticated: true },
  { name: 'feed-recent', weight: 14, authenticated: false },
  { name: 'post-detail', weight: 9, authenticated: false },
  { name: 'comments-read', weight: 6, authenticated: false },
  { name: 'marketplace-list', weight: 5, authenticated: false },
  { name: 'save-toggle', weight: 5, authenticated: true },
  { name: 'follow-toggle', weight: 3, authenticated: true },
  { name: 'comment-create', weight: 3, authenticated: true },
  { name: 'upload-sign', weight: 2, authenticated: true },
  { name: 'generation-quote', weight: 1, authenticated: true },
  // Split out of generation-quote's 2 rather than added on top, so the paid-work
  // tail stays at 2% of the mix. Quoting is a pure read; *starting* is the path
  // that holds credits, creates a provider task and therefore gives the
  // webhook-burst and workflow-fan-out cases something to complete.
  { name: 'generation-start', weight: 1, authenticated: true },
  { name: 'publish-post', weight: 1, authenticated: true },
];

/**
 * Anonymous families key their rate limit on the caller's network address
 * (`getFeedNetworkKeyHash` -> `x-vercel-forwarded-for`), which Vercel writes
 * from the real connection and a client cannot override. One driver host is
 * therefore one bucket no matter how many virtual users it simulates, so these
 * families stop being capacity signal above roughly 10 RPS. Excluding them is
 * the audit's own sanctioned alternative to multi-sourcing, and the exclusion is
 * carried into the report rather than left to the run log.
 */
const ANONYMOUS_FAMILIES = WORKLOAD.filter((entry) => !entry.authenticated).map((entry) => entry.name);
if (options.excludeAnonymous) {
  options.disabled = [...new Set([...options.disabled, ...ANONYMOUS_FAMILIES])];
}

/**
 * A disabled family is removed from the mix entirely and named in the report,
 * so a certified result can never be read as covering a workload that was never
 * actually driven. `--only` is the inverse and exists for priming phases (for
 * example building a backlog of pending provider tasks before a webhook burst);
 * a run that uses it is not a mix run and the report says so.
 */
const ACTIVE_WORKLOAD = WORKLOAD.filter((entry) => (
  !options.disabled.includes(entry.name)
  && (!options.only || options.only.includes(entry.name))
));
if (ACTIVE_WORKLOAD.length === 0) {
  console.error('No families left in the mix — check --only/--disable/--exclude-anonymous.');
  process.exit(1);
}
const totalWeight = ACTIVE_WORKLOAD.reduce((sum, entry) => sum + entry.weight, 0);

/** Share of offered load a family actually receives once the mix is filtered. */
function activeShare(name) {
  const entry = ACTIVE_WORKLOAD.find((candidate) => candidate.name === name);
  return entry ? entry.weight / totalWeight : 0;
}

const POST_TITLES = [
  'Studio lighting product shot',
  'Golden hour portrait workflow',
  'Cinematic loop for a coffee brand',
  'Neon interior walkthrough',
  'Macro texture study in amber',
];

const POST_BODIES = [
  'Shot with an 85mm equivalent and a single softbox camera left, then graded warm to keep the highlights from clipping.',
  'The trick here was slowing the motion curve near the end so the loop point stops reading as a cut.',
  'Built this from a still, upscaled once, then ran a short motion pass to keep the grain consistent across frames.',
  'Kept the palette to three colours so the product stays the brightest thing in frame at every moment.',
];

const GENERATION_PROMPTS = [
  'a cinematic product shot on seamless paper, studio lighting, 85mm',
  'golden hour portrait, shallow depth of field, warm grade',
  'a slow push-in on a ceramic cup, soft window light',
  'macro texture study in amber, high detail, neutral background',
];

/** Per-family metric buckets. */
const metrics = new Map(WORKLOAD.map((entry) => [entry.name, {
  requests: 0,
  failures: 0,
  throttled: 0,
  statuses: new Map(),
  durations: [],
}]));

const runtimeState = {
  users: [],
  posts: [],
  creators: [],
  startedAt: 0,
  warmupUntil: 0,
  stopping: false,
  scheduled: 0,
};

function percentile(values, target) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((target / 100) * sorted.length) - 1);
  return Number(sorted[Math.min(index, sorted.length - 1)].toFixed(1));
}

function pickWorkload() {
  let roll = Math.random() * totalWeight;
  for (const entry of ACTIVE_WORKLOAD) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return ACTIVE_WORKLOAD[0];
}

function pick(list) {
  return list.length === 0 ? null : list[Math.floor(Math.random() * list.length)];
}

// --- authentication ---------------------------------------------------------

/**
 * Retried once, because a sign-in that loses a race at startup shrinks the user
 * pool for the whole step and the pool size is what the rate-limit arithmetic
 * rests on. A step that authenticates 400 users and one that authenticates 560
 * are not comparable measurements, and the difference is the driver's, not the
 * application's.
 */
async function signIn(email, attempt = 0) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  }).catch(() => null);
  if (!response?.ok) {
    if (attempt >= 2) return null;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    return signIn(email, attempt + 1);
  }
  const payload = await response.json();
  if (!payload.access_token) return null;
  return {
    email,
    userId: payload.user?.id ?? null,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    // Refreshed early rather than on expiry: a token that dies mid-flight turns
    // into a 401 that would be scored as an application error.
    //
    // The margin is 900s, not 300s, because validation happens when the request
    // is *served*, not when it is sent. Under queueing the two are far apart:
    // the 25 RPS soak saw requests wait up to the 300s gateway timeout, so a
    // token issued with a 300s margin could arrive already expired and score a
    // 401 that says nothing about the application. 1,470 of that soak's 2,251
    // errors were 401s spread evenly across every authenticated family — the
    // signature of exactly this, not of an endpoint fault.
    expiresAt: Date.now() + (payload.expires_in - 900) * 1000,
    cursor: null,
    sessionId: null,
  };
}

async function refreshUser(user) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: user.refreshToken }),
  });
  if (!response.ok) return false;
  const payload = await response.json();
  if (!payload.access_token) return false;
  user.accessToken = payload.access_token;
  user.refreshToken = payload.refresh_token;
  user.expiresAt = Date.now() + (payload.expires_in - 900) * 1000;
  return true;
}

/**
 * Refresh tokens rotate and are single-use, so two in-flight renewals for the
 * same identity consume the same token twice and the second one 401s — which
 * the first soak then scored as ~16,400 application errors. One renewal
 * promise per user serialises that; a failed refresh is a *driver* fault and
 * triggers a fresh password sign-in rather than ever surfacing as a 401 in an
 * authenticated family. A user that cannot re-authenticate leaves the pool.
 */
async function renewUser(user) {
  if (await refreshUser(user)) return true;
  const fresh = await signIn(user.email);
  if (!fresh) return false;
  user.userId = fresh.userId;
  user.accessToken = fresh.accessToken;
  user.refreshToken = fresh.refreshToken;
  user.expiresAt = fresh.expiresAt;
  return true;
}

async function borrowUser() {
  const user = pick(runtimeState.users);
  if (!user) return null;
  if (Date.now() >= user.expiresAt) {
    user.renewal ??= renewUser(user).finally(() => { user.renewal = null; });
    const renewed = await user.renewal;
    if (!renewed) {
      runtimeState.users = runtimeState.users.filter((candidate) => candidate !== user);
      return borrowUser();
    }
  }
  return user;
}

// --- fixture discovery ------------------------------------------------------

/**
 * Post and creator ids come from the seeded catalog rather than from the feed,
 * so that write families do not depend on a read family having succeeded first.
 */
async function loadFixtureIds() {
  if (!SERVICE_ROLE_KEY) throw new Error('CERT_SUPABASE_SERVICE_ROLE_KEY is required to load fixture ids.');

  // Paged with Range, because `limit=5000` does NOT return 5,000 rows: PostgREST
  // caps a response at its max-rows setting (1,000 by default) and says so only
  // in Content-Range. The unpaged version silently drew every write family from
  // the same 1,000 posts out of 20,000 — a 5% slice of the catalog, which
  // concentrates contention on a handful of rows and flatters the ranker.
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/posts?select=id,user_id&visibility=eq.public&order=id`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Range: `${offset}-${offset + pageSize - 1}`,
          'Range-Unit': 'items',
        },
      },
    );
    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to load fixture posts: ${response.status}`);
    }
    const page = await response.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  runtimeState.posts = rows.map((row) => row.id);
  runtimeState.creators = [...new Set(rows.map((row) => row.user_id))];
  if (runtimeState.posts.length === 0) throw new Error('No seeded posts found — run the seeder first.');
}

// --- request execution ------------------------------------------------------

/**
 * Vercel Deployment Protection guards preview deployments, so every request
 * carries the project's automation-bypass secret. It only skips the SSO gate at
 * the edge; it does not alter routing, caching or the function the request
 * reaches, so the measurement is unaffected. Absent in an unprotected
 * environment, where the variable is simply unset.
 */
const BYPASS_HEADERS = process.env.CERT_BYPASS_SECRET
  ? { 'x-vercel-protection-bypass': process.env.CERT_BYPASS_SECRET }
  : {};

function authHeaders(user) {
  return user ? { Authorization: `Bearer ${user.accessToken}` } : {};
}

async function timedFetch(family, url, init = {}) {
  // Applied here rather than at each call site so anonymous families get it too
  // — they are excluded from the certified mix but still runnable.
  init = { ...init, headers: { ...BYPASS_HEADERS, ...(init.headers ?? {}) } };
  const bucket = metrics.get(family);
  const startedAt = performance.now();
  let status = 0;
  try {
    const response = await fetch(url, init);
    status = response.status;
    // Body must be drained or keep-alive sockets stall under sustained load.
    await response.arrayBuffer();
    return response;
  } catch {
    status = 0;
    return null;
  } finally {
    const durationMs = performance.now() - startedAt;
    // Warm-up traffic is issued but not scored, so cold starts and JWKS//
    // connection priming do not land in the certified percentiles.
    if (Date.now() >= runtimeState.warmupUntil) {
      bucket.requests += 1;
      bucket.durations.push(durationMs);
      bucket.statuses.set(status, (bucket.statuses.get(status) ?? 0) + 1);
      if (status === 429) bucket.throttled += 1;
      else if (status === 0 || status >= 500 || status === 401 || status === 403) bucket.failures += 1;
      else if (status >= 400) bucket.failures += 1;
    }
  }
}

const families = {
  async 'feed-for-you'() {
    const user = await borrowUser();
    if (!user) return;
    const url = new URL('/api/showcase/feed', BASE_URL);
    url.searchParams.set('sort', 'for-you');
    url.searchParams.set('limit', '12');
    // F11's regression case: continue from the cursor rather than re-ranking.
    if (user.cursor) url.searchParams.set('cursor', user.cursor);

    const response = await timedFetch('feed-for-you', url, { headers: authHeaders(user) });
    if (!response?.ok) { user.cursor = null; return; }
    try {
      const payload = await response.clone().json();
      user.cursor = payload?.nextCursor ?? payload?.cursor ?? null;
      user.sessionId = payload?.sessionId ?? user.sessionId;
    } catch { user.cursor = null; }
  },

  async 'feed-events'() {
    const user = await borrowUser();
    if (!user) return;
    // Batched, as F7a made them: one request carrying a client's queued
    // telemetry rather than one request per impression.
    const events = Array.from({ length: 6 }, () => ({
      clientEventId: randomUUID(),
      postId: pick(runtimeState.posts),
      eventType: pick(['impression', 'dwell', 'media_progress', 'open', 'quick_skip']),
      sourceSurface: 'feed',
      occurredAt: new Date().toISOString(),
      durationMs: Math.floor(Math.random() * 8000),
      progress: Math.random(),
      ...(user.sessionId ? { feedSessionId: user.sessionId } : {}),
    }));
    await timedFetch('feed-events', new URL('/api/showcase/feed/events', BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  },

  async 'feed-recent'() {
    const url = new URL('/api/showcase/feed', BASE_URL);
    url.searchParams.set('sort', 'recent');
    url.searchParams.set('limit', '12');
    // Cache-busted so this measures the origin, not the edge. The audit's
    // existing anonymous number is an edge measurement and is not comparable.
    url.searchParams.set('cb', randomUUID());
    await timedFetch('feed-recent', url);
  },

  async 'post-detail'() {
    const postId = pick(runtimeState.posts);
    await timedFetch('post-detail', new URL(`/api/showcase/posts/${postId}?cb=${randomUUID()}`, BASE_URL));
  },

  async 'comments-read'() {
    const postId = pick(runtimeState.posts);
    await timedFetch('comments-read',
      new URL(`/api/showcase/posts/${postId}/comments?limit=20&cb=${randomUUID()}`, BASE_URL));
  },

  async 'marketplace-list'() {
    // F5b's path — `list_marketplace_resource_bundles` was 47% of all RPC time
    // in production and is the single largest database consumer.
    const url = new URL('/api/marketplace/resources', BASE_URL);
    url.searchParams.set('limit', '12');
    url.searchParams.set('cb', randomUUID());
    await timedFetch('marketplace-list', url);
  },

  async 'save-toggle'() {
    const user = await borrowUser();
    if (!user) return;
    await timedFetch('save-toggle', new URL('/api/showcase/save', BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postId: pick(runtimeState.posts),
        shouldSave: Math.random() < 0.6,
        sourceSurface: 'feed',
      }),
    });
  },

  async 'follow-toggle'() {
    const user = await borrowUser();
    if (!user) return;
    const target = pick(runtimeState.creators);
    if (!target || target === user.userId) return;
    await timedFetch('follow-toggle', new URL('/api/profile/follow', BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({ followingId: target, following: Math.random() < 0.7 }),
    });
  },

  async 'comment-create'() {
    const user = await borrowUser();
    if (!user) return;
    const postId = pick(runtimeState.posts);
    await timedFetch('comment-create', new URL(`/api/showcase/posts/${postId}/comments`, BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `certification comment ${randomUUID().slice(0, 8)}` }),
    });
  },

  async 'upload-sign'() {
    const user = await borrowUser();
    if (!user) return;
    await timedFetch('upload-sign', new URL('/api/uploads/media/sign', BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'image',
        fileName: `cert-${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 128_000,
      }),
    });
  },

  async 'generation-quote'() {
    const user = await borrowUser();
    if (!user) return;
    await timedFetch('generation-quote', new URL('/api/generation-models/quote', BASE_URL), {
      method: 'POST',
      headers: { ...authHeaders(user), 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'image', modelId: 'nano-banana-2' }),
    });
  },

  /**
   * The family the first attempt was missing, and the reason webhook-burst and
   * workflow-fan-out could not be run: quoting never creates a provider task, so
   * there was nothing to complete. This starts a real one through the ordinary
   * path — credit hold, catalog quote, idempotency lock, provider createTask —
   * which the `KIE_API_BASE_URL` seam points at the stub.
   *
   * Both media kinds are driven because ingest differs by kind: an image import
   * is a fetch and a store, a video import also probes and transcodes. A run
   * that started images only would leave the video half of the media pipeline
   * uncertified while looking complete.
   *
   * The idempotency key is fresh per request. Reusing one would make every call
   * after the first an idempotent replay, which returns early and measures the
   * lock rather than the start path.
   */
  async 'generation-start'() {
    const user = await borrowUser();
    if (!user) return;
    const isVideo = Math.random() < 0.2;
    const [path, body] = isVideo
      ? ['/api/generate-video', {
        model: 'seedance-2-mini',
        prompt: pick(GENERATION_PROMPTS),
        settings: { resolution: '480p', duration: 4, aspectRatio: '16:9', sound: false },
      }]
      : ['/api/generate-image', {
        model: 'nano-banana-2-lite',
        prompt: pick(GENERATION_PROMPTS),
        settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg' },
      }];

    await timedFetch('generation-start', new URL(path, BASE_URL), {
      method: 'POST',
      headers: {
        ...authHeaders(user),
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
  },

  async 'publish-post'() {
    const user = await borrowUser();
    if (!user) return;
    // Multipart, not JSON: the publish route parses a form because the real
    // client posts media alongside the fields. Content-Type is left unset so
    // fetch emits the multipart boundary itself.
    // Content has to clear the public-publish quality gate, which rejects
    // placeholder tokens (test, demo, sample, draft, ...) in the title and
    // bodies under 18 characters. Load content that trips it would score the
    // publish path as a 100% application failure when the gate is working
    // exactly as designed, so the driver posts what a real user would.
    const form = new FormData();
    form.set('postFormat', 'text');
    form.set('category', 'text');
    form.set('title', `${pick(POST_TITLES)} ${randomUUID().slice(0, 6)}`);
    form.set('body', pick(POST_BODIES));
    form.set('visibility', 'public');
    await timedFetch('publish-post', new URL('/api/posts', BASE_URL), {
      method: 'POST',
      headers: authHeaders(user),
      body: form,
    });
  },
};

// --- scheduler --------------------------------------------------------------

/**
 * Open-model arrival: work is scheduled on a fixed cadence regardless of
 * whether prior requests have returned. A closed loop would silently reduce
 * offered load exactly when the system slows down, which is the moment the
 * measurement matters most.
 */
async function runLoad() {
  const intervalMs = 1000 / options.rps;
  const endsAt = runtimeState.startedAt + options.durationSeconds * 1000;
  const inFlight = new Set();

  while (Date.now() < endsAt && !runtimeState.stopping) {
    const tickStartedAt = Date.now();
    const entry = pickWorkload();
    const task = families[entry.name]()
      .catch(() => {})
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    runtimeState.scheduled += 1;

    // Backpressure guard: if the origin stalls badly, stop piling on rather
    // than exhausting local sockets and measuring the driver instead.
    if (inFlight.size > options.rps * 20) {
      await Promise.race(inFlight);
    }

    const elapsed = Date.now() - tickStartedAt;
    const sleepMs = Math.max(0, intervalMs - elapsed);
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  await Promise.allSettled([...inFlight]);
}

function buildReport() {
  const families = [];
  let totalRequests = 0;
  let totalFailures = 0;
  let totalThrottled = 0;

  for (const [name, bucket] of metrics) {
    if (bucket.requests === 0) continue;
    totalRequests += bucket.requests;
    totalFailures += bucket.failures;
    totalThrottled += bucket.throttled;
    families.push({
      name,
      requests: bucket.requests,
      failures: bucket.failures,
      throttled: bucket.throttled,
      errorRate: Number((bucket.failures / bucket.requests).toFixed(4)),
      throttleRate: Number((bucket.throttled / bucket.requests).toFixed(4)),
      p50: percentile(bucket.durations, 50),
      p95: percentile(bucket.durations, 95),
      p99: percentile(bucket.durations, 99),
      statuses: Object.fromEntries([...bucket.statuses].sort((a, b) => a[0] - b[0])),
    });
  }

  const elapsedSeconds = (Date.now() - runtimeState.startedAt) / 1000;
  return {
    label: options.label,
    targetRps: options.rps,
    disabledFamilies: options.disabled,
    onlyFamilies: options.only,
    // Recorded in the artefact, not just the run log: a reader of this report
    // must be able to see that ~34% of the production mix was not driven and
    // why, without having to find the prose that says so.
    anonymousExcluded: options.excludeAnonymous,
    anonymousExclusionReason: options.excludeAnonymous
      ? 'Anonymous families key their rate limit on the caller network address, which one driver host cannot vary.'
      : null,
    mix: Object.fromEntries(ACTIVE_WORKLOAD.map((entry) => [
      entry.name,
      Number((entry.weight / totalWeight).toFixed(4)),
    ])),
    achievedRps: Number((totalRequests / Math.max(1, elapsedSeconds - options.warmupSeconds)).toFixed(2)),
    durationSeconds: Number(elapsedSeconds.toFixed(1)),
    users: runtimeState.users.length,
    scheduled: runtimeState.scheduled,
    totalRequests,
    totalFailures,
    totalThrottled,
    errorRate: totalRequests ? Number((totalFailures / totalRequests).toFixed(4)) : null,
    throttleRate: totalRequests ? Number((totalThrottled / totalRequests).toFixed(4)) : null,
    families: families.sort((left, right) => right.requests - left.requests),
  };
}

async function main() {
  console.log(`Certification load: ${options.rps} RPS for ${options.durationSeconds}s against ${new URL(BASE_URL).host}`);
  console.log(`  families: ${ACTIVE_WORKLOAD.map((entry) => entry.name).join(', ')}`);
  if (options.disabled.length > 0) console.log(`  disabled: ${options.disabled.join(', ')}`);

  await loadFixtureIds();
  console.log(`  fixtures: ${runtimeState.posts.length} posts, ${runtimeState.creators.length} creators`);

  console.log(`  signing in ${options.users} users...`);
  const emails = Array.from({ length: options.users }, (_, index) => `cert-user-${index + 1}@cert.invalid`);
  const signInBatch = 50;
  for (let offset = 0; offset < emails.length; offset += signInBatch) {
    const batch = await Promise.all(emails.slice(offset, offset + signInBatch).map(signIn));
    runtimeState.users.push(...batch.filter(Boolean));
  }
  if (runtimeState.users.length === 0) throw new Error('No seeded users could sign in.');
  console.log(`  authenticated ${runtimeState.users.length}/${options.users} users`);

  // Sized against the *active* mix, not the nominal one. Excluding the anonymous
  // families lifts ranked reads from 26% of offered load to ~39%, so the user
  // pool a level needs grows with the exclusion — computing this from the
  // hard-coded 0.26 would under-report the requirement by half.
  const rankedShare = activeShare('feed-for-you');
  const requiredUsers = Math.ceil(options.rps * rankedShare * 600 / 60);
  console.log(`  ranked-read share ${(rankedShare * 100).toFixed(1)}% → needs ~${requiredUsers} users`);
  if (runtimeState.users.length < requiredUsers) {
    console.warn(`  WARNING: ${runtimeState.users.length} users is below the ~${requiredUsers} needed`
      + ` for ${options.rps} RPS of ranked reads against a 60-per-10-minute limit.`
      + ' Throttling will dominate and the result will not be a valid certification.');
  }

  runtimeState.startedAt = Date.now();
  runtimeState.warmupUntil = runtimeState.startedAt + options.warmupSeconds * 1000;

  process.on('SIGINT', () => { runtimeState.stopping = true; });

  await runLoad();

  const report = buildReport();
  console.log('');
  console.log(`Achieved ${report.achievedRps} RPS · ${report.totalRequests} scored requests`);
  console.log(`Error rate ${(report.errorRate * 100).toFixed(2)}% · throttled ${(report.throttleRate * 100).toFixed(2)}%`);
  console.log('');
  console.log('family'.padEnd(20) + 'reqs'.padStart(8) + 'err%'.padStart(8) + '429%'.padStart(8)
    + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9));
  for (const family of report.families) {
    console.log(
      family.name.padEnd(20)
      + String(family.requests).padStart(8)
      + (family.errorRate * 100).toFixed(1).padStart(8)
      + (family.throttleRate * 100).toFixed(1).padStart(8)
      + String(family.p50).padStart(9)
      + String(family.p95).padStart(9)
      + String(family.p99).padStart(9),
    );
  }

  if (options.out) {
    await writeFile(options.out, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${options.out}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
