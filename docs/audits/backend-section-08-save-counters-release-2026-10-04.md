# Section 8B — save counters release and reconciliation

October 4, 2026. [PR #337](https://github.com/112kratoss/ugc-copy/pull/337)
passed all four Quality jobs in 37201195516 on 91e38f05. It merged as
`e5bc769b33cce373b3911bb93c4c8513f6841ae2` at 12:19:48 UTC / 17:49:48 IST.
No mobile store release was active immediately before merge. Exact-main Quality
37201725874 passed, then standard release 37202416554 succeeded at
12:35:38 UTC / 18:05:38 IST. Independent live SHA, feed 200, admin redirect 307
and unsigned webhook 401 checks pass on the same build.

Migration `20261004114652_maintain_post_save_counters.sql` maps to production
ledger version `20261004123218`. All three deployed function digests and grants
match the clean replay; the private trigger function is not directly executable
by client or service roles. The production rollback probe now passes 4/4
(previously 2/4). Separate cleanup confirms zero fixture accounts.

After verifying prevention was deployed, a bounded production reconciliation
was rehearsed with rollback and then committed. It corrected nine stored save
counts to the actual number of `post_saves` rows. NOWAIT table locks prevent
concurrent writes from invalidating the snapshot; five-second statement timeout,
500ms lock timeout and a 20-row cap bound the repair. The full before/after rows
are retained privately. A separate readback reports 38 posts, zero mismatches,
and zero net counter difference. No user saves or balances were changed.
Existing drift is not attributed to one historical cause.

Evidence is in `.audit-evidence/backend-social/save-release/`. Local repair
controls verify rollback, immediate refusal when tables are busy, accurate
commit and a correct subsequent unsave. The [8B prevention report](backend-section-08-save-counters-2026-10-04.md)
records 12 permanent SQL cases, clean replay and the actual Auth API control.
Broader SOCIAL-02 lifecycle coverage remains open after this scoped repair.
