# Section 6Q — encoder output-limit release

Status: deployed and independently verified.

[PR #277](https://github.com/112kratoss/ugc-copy/pull/277) merged at
2026-10-02 09:36:22 UTC (15:06:22 IST) as
`a8dd6c1fa40a1a74d4f1f5115d611f830a8ced28`.
Runtime branch commit: `c80bd22ac1cd87cb055412b3dc9e9c2a5b5730f6`.

[PR Quality 36989530190](https://github.com/112kratoss/ugc-copy/actions/runs/36989530190)
passed all four jobs on its first attempt:

- 6,407 web tests passed, 121 skipped (838 passing files, 10 skipped).
- 2,848 mobile tests passed across 286 files.
- 19 browser smoke tests passed.
- 1,941 SQL assertions passed across 90 files; clean migration replay passed.
- 122 real database integration/concurrency checks passed (2 + 35 + 18 + 67),
  with one expected worker child-harness skip.
- Real FFmpeg inherited-lock, scratch/abort/orphan and output-bound probes passed.
  CI's 2,002-byte fixture stopped at exactly 2,048 bytes with an empty workspace.
- Lint, all three type projects, performance-budget validation, production build,
  native staging locks and all 163 media route traces passed.

No mobile store release was active before merge. Remote main still matched the
reviewed base, and all required checks were green. Squash merge has a distinct
commit identity from the feature branch; the audit checkout moved to a fresh
`codex/media-capacity-admission-6r` branch at the merged main. Unrelated receipt
edits and Section 1 files remain unchanged; no reset or discard was used.

[Exact-main Quality 36990750061](https://github.com/112kratoss/ugc-copy/actions/runs/36990750061)
passed all four jobs. Standard [Production release 36991829551](https://github.com/112kratoss/ugc-copy/actions/runs/36991829551)
succeeded on attempt 1 at 2026-10-02 09:51:18 UTC (15:21:18 IST). Exact-SHA
staged verification, stale-build guards, promotion, live-SHA verification and
protected production health all passed.

Independent live checks after the workflow confirm:

- `/api/app-version` returns 200 and exact build `a8dd6c1f` (full SHA above).
- Public showcase feed returns 200 with an items array.
- Unauthenticated admin payout access redirects to login (307).
- Unsigned Kie webhook is rejected (401).

Remote main still matches the deployed SHA. The prior `626f398c` production build
is superseded. No provider was charged or customer data changed by these probes.
Release evidence is saved locally for the next audit PR.

Private evidence is in `.audit-evidence/backend-section-06q/`. This release does
not certify a production media encode or a shared-capacity solution. MEDIA-06
shared admission and MEDIA-07 legacy/unpublished metadata remain open; the scoped
ledger is unchanged at 21 passed, 27 untested, 2 failed and 3 external obligations.
