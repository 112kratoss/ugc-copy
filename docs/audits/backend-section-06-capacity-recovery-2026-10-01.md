# Section 6M — actual disk failure through import recovery

Status: four bounded local scenarios pass; no application defect reproduced in
these recovery paths and no runtime change/release in this batch. Shared disk
admission and other scratch lifetimes remain open. Baseline: deployed main
`999c34d5b3435d160865a05c8ba3ff1bd3a0ec29` (Section 6L).

## Method and evidence boundary

Ran the actual staging helper, import processor, status reconciliation, stalled
reaper, notification deduplication and settlement wrappers on Linux/Node 24.21.0.
A dedicated container mounted a **2 MiB tmpfs** at `/scratch` and shared the
network namespace of the existing isolated audit database container, connecting
to its loopback Postgres. It did not use the primary development database or
production credentials. Each scenario used a transaction that was rolled back.
SQL statement timeout was 10 seconds; fixture IDs were unique. The probe refused
to proceed if the isolated import queue already contained pending/processing work.

The app's Supabase calls were translated into real SQL by the bounded database
adapter from the existing worker-crash suite. Credits started at 500, with 200
promotional, and the real `start_generation` reserved 120 credits. The provider
task was attached using its real RPC. Mobile push was disabled for each fixture;
the real notification code inserted into the actual deduplicated notification
table. Preview generation returned null deliberately.

Remote media was a bounded in-memory source; Storage upload consumed the actual
staged stream into a local sink. Provider status HTTP returned an injected
success payload. Unexpected external fetches threw. These substitutions exclude
provider delivery/authentication, Storage transport and FFmpeg from this batch.
They do **not** replace disk writes, kernel ENOSPC, staging cleanup, queue SQL,
reservation/settlement SQL, retry classification or notification deduplication.

The 614,400-byte single-output source could not fit while an active leased
workspace held 1,843,200 bytes. Multi-output used 614,400-byte and 1,228,800-byte
sources while another workspace held 1,048,576 bytes. The lease prevented the
sweeper from freeing the pressure fixture. Each failure verified that active
bytes remained intact and the failed new workspace was removed. Before each
retry the probe advanced only its fixture job's `next_attempt_at` to `now()`;
no wall-clock backoff timing claim is made. For the reaper scenario, the fixture's
creation time was moved one hour back to cross its eligibility threshold.

## Results

| Scenario | Actual disk failure and recovery | Verified outcome |
| --- | --- | --- |
| Temporary shortage | One ENOSPC during staging; release pressure and run the pending job again | Job succeeds, one upload, credits 380/promotional 80, no refund, one success notification |
| Partial multi-output | First file uploads; second staging gets ENOSPC. Settlement is deferred with `Persisted 1 of 2` error. Release pressure and retry both outputs | Three upload calls total (the first path is uploaded again using the app's upsert option), complete output list succeeds, unchanged balances and one success notification |
| Exhaustion then callback reconciliation | Ten real ENOSPC attempts exhaust the job. Releasing pressure alone yields no claim. Feed a repeated success payload through `syncGenerationStatusByPredictionId` | Same job ID reopens, subsequent import succeeds, attempt history remains 10, unchanged balances and one success notification |
| Exhaustion then stalled reaper | Ten real ENOSPC attempts exhaust another job. Releasing pressure alone yields no claim. Real reaper polls the injected provider-success response and requeues | Same job ID reopens and succeeds without a new charge/refund; one success notification |

All **22 actual disk failures** left the generation without a durable output or
success notification and preserved credits at 380/promotional 80 after the
original reservation. Successful recovery did not charge again. After success,
a duplicate enqueue plus processor invocation claimed no work, performed no
additional upload, and left the complete captured state unchanged.

The local Storage sink verifies stream bytes and upload-call counts; it does not
certify Supabase upsert semantics. The repeated callback test enters the status
reconciliation seam directly; it does not test webhook signature verification or
actual edge/provider delivery. Likewise, the reaper test verifies its real
eligibility and reconciliation behavior with a synthetic provider response, not
provider URL longevity.

All scenarios ended with an empty staging namespace. Transaction rollback was
verified inside the probe. A separate database read found zero `audit-disk-*`
generations and import jobs; fixture user IDs were also checked after rollback.
No existing data was modified. Expected ENOSPC logs are retained as evidence.

## Interpretation and remaining work

There is no basis here for a speculative queue or credit fix. The import queue
retries temporary capacity failures correctly in these cases. Its exhausted
state does not by itself prove a stranded credit hold: the stalled reaper and
repeated provider-success reconciliation can reopen it. The managed generation
job explicitly runs stalled reconciliation before the import drain.

Recovery still requires capacity to return and provider output to remain
obtainable. Persistent pressure, unavailable/expired provider outputs, all
supported media/models, concurrent workers, actual process death during these
specific disk failures, and platform scheduling latency are not certified by
this probe. Reopening an exhausted job preserves its attempt count; if capacity
remains unavailable, that reopened attempt can exhaust again. That behavior was
not changed. Avoid claiming a system-wide retry ceiling from the import job's
10-attempt cap alone.

**MEDIA-06 remains failed/open** for concurrent capacity admission, as reproduced
in Section 6K. This batch adds recovery evidence without claiming to prevent
ENOSPC. MEDIA-07 still covers poster/frame/rendition scratch lifetimes and metadata
accumulation. The 53-obligation ledger remains **21 passed, 28 untested, 1 failed,
3 external**. Do not add or close rows solely to improve the count.

Next: inventory overlapping source/output footprints and ownership of the five
remaining scratch namespaces, using actual writer/reader lifetime evidence before
introducing sweeping or reservation changes. Reconcile current job/source budgets
with any proposed shared admission mechanism. Then continue workflow execution,
partial failure, cancellation and billing invariants from the completion ledger.

## Reproduction and cleanup

Private evidence: `.audit-evidence/backend-section-06m/`.

- `build.cjs` bundles the actual modules and extracts the bounded DB adapter from
  the existing worker-crash test; `adapter.ts` preserves the generated adapter.
- `probe.ts`, `source.ts`, `preview.ts`, `probe.cjs` are the final fixture and
  bundle. `probe-single-only.ts` records the earlier three-scenario probe.
- `probe-first.log`, `probe-final.log`, `results.json` preserve raw and structured
  observations; only synthetic IDs/paths are present in these local results.
- `Dockerfile` pins the Node image digest and fs-ext 2.1.1. Image build logs retain
  the initial metadata-resolution stalls and successful isolated Docker-config
  fallback. No user's Docker configuration was changed. PG is bundled from the
  checkout; no new application dependency was installed.
- `verification-manifest.json` records source/probe hashes and native image ID.
- `cleanup.json` records the separate zero-fixture readback.

Build the private fixture with `node .audit-evidence/backend-section-06m/build.cjs`.
Build that directory's Dockerfile as `audit-capacity-recovery-6m:local`. Run the
image with `--network container:supabase_db_magicbooklet-auth-section-one`, a
read-only mount of this evidence directory at `/input`,
`--tmpfs /scratch:rw,size=2m,mode=700`, `TMPDIR=/scratch`,
`NODE_PATH=/probe/node_modules`, and the non-secret `KIE_AI_API_KEY=isolated-fixture-key`.
Execute `node /input/probe.cjs`. Only the named isolated DB is suitable; the probe
uses that namespace's loopback port 5432, not the host's primary database port.

The probe container, local sink and fixture filesystem were removed; the dedicated
image was removed after recording its identity. Existing database containers were
left running. Production remains verified Section 6L. No migration, mobile change,
provider charge, customer repair or production fixture occurred. The full unit
suite was not rerun for documentation-only changes; the real disk/DB probe and
artifact/link checks provide this batch's verification. Preserve local Section 6L
release evidence and unrelated changes for the next appropriate audit PR.
