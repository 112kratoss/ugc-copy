# Section 6L release evidence — 2026-10-01

Status: deployed and verified; no Section 6L release work remains pending.

PR [#256](https://github.com/112kratoss/ugc-copy/pull/256), head
`bc0b2e3c7b8388e7249a1762799e45decb1cf032`, merged as
`999c34d5b3435d160865a05c8ba3ff1bd3a0ec29` at 12:35:45 UTC
(18:05:45 IST). No mobile store release was active before merge.

PR Quality [36853752909](https://github.com/112kratoss/ugc-copy/actions/runs/36853752909)
passed all four jobs on its first run: 6,176 web tests (118 DB/child-only skips),
2,802 mobile tests, 19 browser cases, 1,941 SQL assertions across 90 files and
119 database checks (2 credit, 35 commerce, 18 payment, 64 generation). Actual
FFmpeg inherited-lock verification and native packaging checks passed, including
162 API route traces. Lint, all type checks, performance checks and build passed.

Exact-main Quality is [36862814234](https://github.com/112kratoss/ugc-copy/actions/runs/36862814234).
All four jobs passed on the first run with the same test counts and native checks.
Standard production release
[36864062596](https://github.com/112kratoss/ugc-copy/actions/runs/36864062596)
passed on attempt 1 at 12:50:32 UTC (18:20:32 IST), including staged verification,
promotion, live exact SHA and protected production health. Independent checks
afterward confirmed live `999c34d5`, feed HTTP 200, admin payout login redirect
307 and unsigned provider webhook 401. Remote main still matched. No manual
deployment bypass or failed-job rerun was needed. Protected release health is
not a synthetic production media/lock transaction or resolution of the separate
operator moderation review.

The cleanup pass now limits successful reclamations to 128 and inspects beyond
preserved entries. Publication/lease/identity checks remain mandatory. Real
filesystem regression fails before the fix. Local Linux 2 MiB tmpfs verification
reclaims two dead owners beyond 128 unpublished entries; a new import succeeds,
unpublished entries stay and active/inherited reader bytes survive disk pressure.
Separate fresh-process tests drain 140 dead owners as 128 then 12 and preserve a
locked prefix. See [finding and tradeoff](backend-section-06-scan-progress-2026-10-01.md).

Inspection is linear in namespace size, with no total wall-clock bound. The
local idle-host sample for 10,000 unpublished entries was 400–405 ms; this is not
production capacity certification. Metadata accumulation and shared disk admission
remain open (MEDIA-06/07, OPS-03). No SQL migration, mobile runtime/OTA change,
provider charge, customer repair or production fixture is involved.

Section 6J release records, Section 6K investigation and the initial 53-obligation
closure ledger/surface map are included in PR #256. Unrelated local changes remain
preserved. Private logs are under `.audit-evidence/backend-section-06l/`.

MEDIA-05 is now passed. The 53-obligation ledger has 21 passed, 28 untested,
1 failed and 3 external; these are scoped obligation counts, not a completion
percentage. Next: actual disk failure through import retry/settlement, followed
by other scratch lifetimes. See private `next-capacity-boundary.md`.
