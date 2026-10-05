# Sections 9A–9D — release verification

Production SHA `9903c6dcdfe63c9fa66398d572864061650cb2d2` contains shared job-lock
coverage #349, retention reporting #352, receipt recovery #353 and retry-write
recovery #354. The last PR passed all four Quality jobs in 37258797988 on
`469d3231f54d35ead0ebf364455490947b5f8d51` and merged October 5 at 03:27:13 UTC,
immediately after the mobile-store-release idle check. Independent changes from
main (#351 Android preview and #355 prompt moderation) are preserved.

Exact-main Quality 37259501863 passed. Standard production release 37260329433
passed at 03:43:32 UTC. Independent live checks at 04:10:28 UTC matched the exact
SHA and observed public feed 200, admin payout login redirect 307 and unsigned
provider-webhook rejection 401. Private readback evidence is under
`.audit-evidence/backend-social/push-retry-release/`. Diff of the notification,
retention and lock-test files against the PR head is empty.

Earlier 9A staging stopped at the stale-main promotion guard; subsequent main
CI runs were cancelled when independent commits advanced main. These are not
successful release evidence. The first 9D CI attempt failed installing FFmpeg
because its upstream README download returned HTTP 500, before app tests. A
retry installed successfully; a subsequent main merge required fresh head CI,
and only that final passing run was used for the merge.

No migration or mobile runtime release was needed for 9A–9D. JOB-02 returns to
untested for the remaining retention/bounded-progress matrix. JOB-03 remains
failed for the reproduced send-budget/worker-death gap documented in 9E; its
candidate claim migration is not included in this production SHA. Genuine
installed-device/provider delivery and the full audit remain open.
