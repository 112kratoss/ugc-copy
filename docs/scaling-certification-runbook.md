# Scaling certificate runbook

This runbook turns the current scaling remediation into a reproducible release
and capacity certificate. It is intentionally separate from the historical
audit journal. A green source build is necessary but does not certify MAU.

## 0. Product stop gate

Start with [`scaling-audit.md`](scaling-audit.md). Do **not** provision a cloud
certificate while its priority board contains an unresolved correctness or
unbounded-work stop gate. S1 through S3 now have source implementations and pass
a clean local replay plus pgTAP, but the same replay must pass on the isolated
certificate branch and their stated signed-in/upload fixture measurements must
pass before a full-app certificate can be issued.

The source contains durable workflow admission, provider-slot reservation,
completion leases, output import, isolated media repair and bounded feed
retention. Those controls are not considered released or capacity-proven until
a clean isolated replay, pgTAP, advisors and the deployed strict cases all
pass. A source-only implementation is not a capacity result.

A deliberately narrower certificate may exclude a surface only if the workload,
result title, RPS→MAU model and artifact all name the same exclusion. It must not
be described as a full-app capacity certificate.

## Safety boundary

- Never point `CERT_BASE_URL`, `CERT_SUPABASE_URL`, `CERT_DATABASE_URL` or the
  migration project ref at production. The certification migration wrapper
  rejects the known production ref and requires the independently entered
  branch ref, migration ref and Supabase hostname to agree. Manually verify all
  remaining URLs and credentials before every run.
- Use a fresh Supabase branch for every fixture tier and every one-hour soak.
  Do not compare sequential soaks on one growing database.
- Run the load driver and provider stub outside Vercel and outside the Supabase
  region. Anonymous capacity needs multiple real source IPs; otherwise run with
  `--exclude-anonymous` and record the exclusion.
- Never commit service-role keys, database URLs, provider keys, bypass secrets,
  raw Kie exports or environment dumps.

## 1. Freeze the release candidate

Record the commit and require these gates:

```bash
git diff --check
npm run typecheck
npm run typecheck:scripts
npm run typecheck:tests
npm run lint
npm test
npm run build
npm run build:verify
```

Every repository migration through the release-candidate commit must be
present. Do not use the migration cutoff from an older certificate: upload,
identity, workflow and retention behavior changed after the August 10 baseline.
The migration wrapper and schema fingerprint below are the authoritative parity
checks.

## 2. Provision and validate one isolated database

Create a new Supabase branch from the repaired production migration ledger.
Set these values only in the driver environment:

```text
CERT_SUPABASE_URL
CERT_SUPABASE_ANON_KEY
CERT_SUPABASE_SERVICE_ROLE_KEY
CERT_DATABASE_URL
SUPABASE_ACCESS_TOKEN
SUPABASE_PROJECT_REF
CERT_EXPECTED_PROJECT_REF
```

Copy `CERT_EXPECTED_PROJECT_REF` independently from the isolated branch's
details; do not derive it from `SUPABASE_PROJECT_REF` in the shell.

Apply the repository history through the same migration path as a release:

```bash
node scripts/certification/apply-migrations.mjs
```

Then:

1. Confirm every repository migration is recorded.
2. Run the database test suite/pgTAP on the branch.
3. Run `scripts/schema-fingerprint.sql` and compare its object-class digests to
   the expected replay fingerprint.
4. Run Supabase security and performance advisors.
5. Verify the deployed product route calls `initialize_workflow_canvas_run(...)`
   and never the compatibility `start_workflow_canvas_run(...)` RPC. The old RPC
   stays executable for one schema-first release window and must be revoked or
   dropped in the immediately following release after production build-ID
   verification.
6. Verify `track_io_timing` on both `postgres` and `authenticator`; enable
   `log_temp_files` for the run if the environment permits it.

Seed exactly one declared tier:

```bash
node scripts/certification/seed-fixtures.mjs --tier 10k
node scripts/certification/seed-fixtures.mjs --tier 100k
node scripts/certification/seed-fixtures.mjs --tier 1m
```

Use only one of those commands per branch. Save the seeder output and table-size
manifest under `certification-artifacts/`.

## 3. Deploy the preview and provider stub

Deploy the release candidate to a Vercel preview in the production function
region, connected only to the isolated Supabase branch. Configure the existing
provider override so `KIE_API_BASE_URL` points at the public stub; do not use a
real paid provider key.

Start the stub on the separate driver host:

```bash
node scripts/certification/provider-stub.mjs \
  --port 8787 \
  --public-url https://STUB_HOST \
  --forward-target https://PREVIEW_HOST \
  --forward-bypass "$CERT_BYPASS_SECRET" \
  --secret "$CERT_STUB_SECRET" \
  --completion-delay 8
```

For a deployment-protected preview, set the isolated branch Edge function's
`NEXT_PUBLIC_SITE_URL=https://STUB_HOST`; the Edge function then signs and sends
the callback to the stub relay, and the relay adds the Vercel bypass header and
forwards the unchanged body/signature to `https://PREVIEW_HOST/api/webhooks/kie`.
Set the preview's `KIE_API_BASE_URL=https://STUB_HOST` and its provider callback
URL to the isolated branch Edge function. Never reuse production callback or
site URLs. Probe all three hops and require zero stub `forwardFailures` before
priming. Set `SCALING_CERTIFICATION_TIMINGS=1` on the preview; the ranked-feed
driver fails if the route does not emit samples for auth, rate limit, candidate
retrieval, hydration, persistence, cursor continuation, viewer state and total
request/serialization phases.

Also configure a unique `IDENTITY_ADMISSION_SECRET` (at least 32 bytes). Public
feed/detail/comment reads intentionally use the PostgreSQL limiter, so the
certificate must include its calls, rows, WAL, lock wait and latency in the
origin write budget. Do not subtract rate-limit work from the result or claim a
write-free public-read boundary.

The stub must refuse to start if it cannot encode its real 1920×1080 JPEG and
eight-second 1280×720 MP4. Confirm `/stub/stats` is reachable from the preview
and that one callback traverses the real Edge-function-to-Vercel path.

The driver environment additionally needs:

```text
CERT_BASE_URL
CERT_STUB_URL
CERT_CRON_SECRET
CERT_OPS_READ_SECRET
CERT_BYPASS_SECRET (only when preview protection is enabled)
CERT_STUB_SECRET (also set as the preview-only KIE_API_KEY)
CERT_EXPECTED_BUILD_ID (the frozen release-candidate commit SHA)
CERT_SCHEMA_FINGERPRINT (the replay fingerprint captured in section 2)
CERT_FIXTURE_TIER (exactly one of 10k, 100k or 1m)
CERT_CATALOG_REVISION (the verified production-equivalent catalog revision)
```

The load driver probes `/api/app-version` and authenticated stub state before
sign-in, hashes the SLO file, and writes all six bindings into every report. A
missing or mismatched binding aborts the run before traffic begins.

Before signing in the pool, record the isolated branch Auth verify/refresh
limits and temporarily size them for the declared driver pool. Hard-fail if the
driver authenticates fewer users than its computed feed-rate minimum. Record
this branch-only deviation as an Auth-capacity exclusion. Pin and verify the
same generation catalog revision/source used by the release candidate; a v1
fixture cannot certify a production v2 generation path.

## 4. Run the strict property cases

Every command must exit zero; a skip is a failure.

```bash
mkdir -p certification-artifacts
node scripts/certification/cert-cases.mjs skew
node scripts/certification/cert-cases.mjs provider-degradation

node --input-type=module -e '
  const auth = { "x-cert-stub-secret": process.env.CERT_STUB_SECRET };
  const reset = await fetch(new URL("/stub/reset", process.env.CERT_STUB_URL), { method: "POST", headers: auth });
  if (!reset.ok) throw new Error(`stub reset failed: ${reset.status}`);
  const configured = await fetch(new URL("/stub/config", process.env.CERT_STUB_URL), {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ completionDelaySeconds: 0 }),
  });
  if (!configured.ok) throw new Error(`stub config failed: ${configured.status}`);
  const config = await configured.json();
  if (config.completionDelaySeconds !== 0) throw new Error(`stub delay is ${config.completionDelaySeconds}, expected 0`);
  const statsResponse = await fetch(new URL("/stub/stats", process.env.CERT_STUB_URL), { headers: auth });
  if (!statsResponse.ok) throw new Error(`stub stats failed: ${statsResponse.status}`);
  const stats = await statsResponse.json();
  if (stats.tasksTotal !== 0 || stats.tasksPending !== 0) throw new Error(`stub was not empty: ${JSON.stringify(stats)}`);
'
node scripts/certification/cert-load-test.mjs \
  --only generation-start --rps 0.5 --duration 120 --warmup 0 \
  --max-operations 48 \
  --out certification-artifacts/webhook-prime.json
node --input-type=module -e '
  const response = await fetch(new URL("/stub/stats", process.env.CERT_STUB_URL), { headers: { "x-cert-stub-secret": process.env.CERT_STUB_SECRET } });
  if (!response.ok) throw new Error(`stub stats failed: ${response.status}`);
  const stats = await response.json();
  if (stats.tasksTotal !== 48 || stats.tasksPending !== 48) throw new Error(`expected exactly 48 pending tasks: ${JSON.stringify(stats)}`);
  console.log("Stub primed with exactly 48 pending tasks.");
'
node scripts/certification/cert-cases.mjs webhook-burst --count 48

node scripts/certification/cert-cases.mjs \
  workflow-fanout --runs 20 --mode branch
node scripts/certification/cert-cases.mjs cron-overlap

node --input-type=module -e '
  const response = await fetch(new URL("/stub/config", process.env.CERT_STUB_URL), {
    method: "POST",
    headers: { "x-cert-stub-secret": process.env.CERT_STUB_SECRET, "content-type": "application/json" },
    body: JSON.stringify({ completionDelaySeconds: 8 }),
  });
  if (!response.ok) throw new Error(`stub config restore failed: ${response.status}`);
  const config = await response.json();
  if (config.completionDelaySeconds !== 8) throw new Error(`stub delay is ${config.completionDelaySeconds}, expected 8`);
  console.log("Stub completion delay restored to 8 seconds.");
'
```

The workflow case certifies required keys, atomic skeleton/ticket ownership,
run-scoped DB leasing, fan-out, deterministic generation keys and exactly-once
settlement. It does not certify independent per-node retry or poison-node
isolation; record that exclusion until a one-node-per-claim executor exists.

## 5. Ladder and one-hour soak

Start resource sampling before warmup and keep it running through drain:

```bash
node scripts/certification/sample-resources.mjs \
  --interval 15 --label TIER-RPS --out certification-artifacts/resources.jsonl
```

Stop the sampler only after the post-load drain, then make its evidence an
executable gate rather than a manual dashboard reading:

```bash
node scripts/certification/evaluate-resources.mjs \
  --in certification-artifacts/resources.jsonl \
  --out certification-artifacts/resource-evaluation.json
```

The evaluator fails non-zero for sparse telemetry, sampler errors, pool or lock
breaches, idle transactions older than five seconds, deadlocks/temp spill,
overdue or growing durable queues, and feed retention lag. The sampler retains
the instantaneous idle-transaction count as diagnostic context, but does not
misclassify millisecond-scale Auth/PostgREST/Storage transaction boundaries as
abandoned work. External DB CPU/PostgREST wait and Vercel concurrency exports
remain mandatory companion artifacts because Postgres cannot self-report them.

After selecting the highest fully green soak, calculate the MAU range only from
measured inputs (use the observed feed facts/session, provider drain/day and
media-import drain/day from that clean fixture):

```bash
node scripts/certification/calculate-capacity.mjs \
  --sustainable-rps MEASURED_RPS \
  --provider-generations-per-day MEASURED_PROVIDER_DRAIN \
  --media-generations-per-day MEASURED_MEDIA_DRAIN \
  --facts-per-session MEASURED_FACTS_PER_SESSION \
  --anonymous-excluded \
  --out certification-artifacts/capacity-model.json
```

The calculator applies the required 30% headroom, reports compute, retention,
provider and media ceilings separately, and chooses their minimum. It refuses
to run with a missing dimension. Omit `--anonymous-excluded` only when the
declared multi-source anonymous workload actually ran; it never extrapolates an
authenticated-only run upward to pretend anonymous capacity was measured.

Run stepped diagnostic ladders at 5, 10, 25, 50 and 100 operation RPS. The load
driver reads `config/certification-slos.json` and exits non-zero on validity or
route-SLO failure:

```bash
node scripts/certification/cert-load-test.mjs \
  --rps 25 --duration 120 --exclude-anonymous \
  --label 100k-25rps --out certification-artifacts/100k-25rps.json
```

Find the sustainable knee, destroy that ladder branch, create a fresh branch at
the same tier, and run the candidate load for 3,600 seconds. Repeat with a fresh
branch if the candidate changes. A pre-aged steady-state fixture should be run
separately from a clean-growth fixture.

## 6. Required external telemetry

Capture the same before/during/after window for:

- Supabase DB CPU, connection usage, disk I/O and PostgREST waits;
- WAL/checkpoints, temp bytes/files, deadlocks, locks and statement deltas;
- Vercel concurrency, duration, cold starts and route-phase timings;
- completion, workflow and rendition oldest-due ages;
- feed retention lag and table/index growth;
- stub callback/task counts and Sentry issues.

Do not conclude “not Postgres” without the database CPU/I/O/WAL and route write
phase evidence.

## 7. Certificate acceptance and teardown

The certificate fails unless all of these hold:

- executable validity and route SLO gates pass;
- error and 429 policies pass;
- achieved completed-operation load is at least the configured ratio, with the
  scheduled-arrival rate and any driver backpressure recorded separately;
- DB CPU and connection-pool criteria pass with 30% measured headroom;
- no growing lock, queue, rendition or retention backlog;
- no duplicate/orphaned/refunded paid generation that produced provider work;
- strict property cases pass against the same release candidate;
- RPS-to-MAU math uses measured facts/session, sessions/DAU, DAU/MAU and peak
  factor, with assumptions and exclusions stated.

Store commit SHA, schema fingerprint, tier manifest, SLO config, commands, raw
JSON/JSONL, external metric exports and reconciliation queries together under
`certification-artifacts/`. Remove the preview, stub tunnel and Supabase branch
after artifacts are secured. Only then add an immutable report under
`docs/scaling-certificates/` and update `scaling-audit.md` from **NOT CERTIFIED**
to a dated, expiring, exact-build capacity claim.
