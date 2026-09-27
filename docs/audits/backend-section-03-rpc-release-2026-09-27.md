# Section 3 — client RPC production verification

PR [#228](https://github.com/112kratoss/ugc-copy/pull/228) merged as
`f7069603e00481d7684f000d172728a18a477ddd`.

- PR Quality [36332746914](https://github.com/112kratoss/ugc-copy/actions/runs/36332746914) passed all four jobs.
- Exact-main Quality [36336781374](https://github.com/112kratoss/ugc-copy/actions/runs/36336781374): passed all four jobs.
- Production release [36337405189](https://github.com/112kratoss/ugc-copy/actions/runs/36337405189): passed migration, staging, public/authenticated health, promotion and live verification.

Local evidence: 41 focused RPC assertions, full clean replay of 255 migrations
and 1,610 assertions across 79 files. A 30-request local concurrency probe
admitted 20 requests and rejected 10, leaving exactly 20 runs, tickets and
counter units.

Before release, a production transaction accepted 21 direct initializer calls,
confirming the quota bypass. That transaction rolled back; no jobs became
visible to workers. Independent fixture cleanup checks were zero. A separate
real-session production probe passed 38 ownership/identity checks at 16:20 UTC;
those checks intentionally omitted the not-yet-fixed quota assertion.

The prior financial audit PR #226 is merged in `9282e408ba4abde3312e70542737fa4c6f9dc704`.
Its exact-main Quality run 36332205486 and production release 36332781404 passed.

After the production migration, the rollback SQL verifier passed **41 checks**.
At **17:35:26 UTC**, the real-session HTTP verifier passed **42 checks**,
including both exhausted-quota denials. Successful worker creation was confined
to the rolled-back transaction; no provider work was committed. Independent
cleanup queries returned zero fixture users, canvases, runs, jobs and rate counters.

Schema fingerprints: **15 of 16 categories unchanged**. Only the functions
category changed, from `a09dad24ac613d41849fe025176e1ae3` to
`6adb41185494b5e487721c7fb9823193`. Table/column shape, grants, policies,
triggers, views and storage configuration remained unchanged. There are still
306 public functions. Security advisors remained 1 INFO / 37 WARN / 0 ERROR
in the current advisor response, identical to this batch's pre-release baseline.
This does not resolve the existing warnings or certify other business workflows.

Independent `/api/app-version` verification after release returned exactly
`f7069603e00481d7684f000d172728a18a477ddd`. The client-callable privileged
RPC batch is complete; the remaining backend sections are still open.
