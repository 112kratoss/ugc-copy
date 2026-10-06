# Section 11D/E/F — independently verified collector release

The combined collector changes in [PR #382](https://github.com/112kratoss/ugc-copy/pull/382)
passed all five exact-head Quality jobs in run `37518573233` on
`d5c0cb0845bfd868eb4329c7ad0455ebffdc0393`, including 107 actual API cases.
The independently verified #381 parent and an immediate idle mobile-store check
preceded the October 6 19:34:48 UTC merge as
`6e7b8ddb51a68841242bbbe491c41e59f1b65d9f`.

All five exact-main Quality jobs pass in `37520033768`; standard release
`37521541451` succeeds. Independent checks at October 6 19:52:00 UTC confirm the
exact live build and the expected Supabase project. Public schema fingerprints
change only for one added function and its execute grant; all existing function
definitions and privileges remain unchanged.

`admin_job_run_summary(timestamptz)` matches the clean replay digest
`9e81773eca4a78073a313259707def79`, STABLE declaration, fixed definer search path
and service-only execution privileges. Bounded production rollback fixtures
verify the time window, equal-time latest failure and empty window. An independent
cleanup query finds zero fixture job rows. All 110 security advisor findings
are unchanged. Live feed, admin redirect and unsigned webhook smoke return
200, 307 and 401 respectively.

The standard workflow records source migration `20261006190707` under production
ledger version `20261006194754` with name `admin_job_run_summary`. This release
mapping was read back independently; no ledger repair was performed.

The release includes the web purchase mirror exclusion, bounded revenue rail
pagination with exact truncation disclosure, uncapped daily job aggregation and
active catalog lookup independent of ten-entry history. Before/after reproductions
and scope limits remain in the separate [11D](backend-section-11-admin-purchase-counter-2026-10-07.md),
[11E](backend-section-11-admin-collector-limits-2026-10-07.md) and
[11F](backend-section-11-admin-catalog-coverage-2026-10-07.md) reports.

GitHub marked #383 merged into its candidate base branch when its commits were
incorporated into #382; there was no separate main merge or production release.
Both attached PRs preserve that history. This record certifies the combined
release, not the pending wallet and user-detail error findings. OPS-04 remains
failed, and the complete audit remains open.
