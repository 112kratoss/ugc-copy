# Section 8C — follow/block serialization release

October 4, 2026. [PR #338](https://github.com/112kratoss/ugc-copy/pull/338)
passed all four Quality jobs in 37201786228 on 6e193727. It merged as
`7116126d2a9dd1b4919a7dc554ec9640fc37d036` at 14:02:51 UTC / 19:32:51 IST.
No mobile store release was active immediately before merge. Exact-main Quality
37207818947 passed; standard release 37208546610 succeeded at
14:18:52 UTC / 19:48:52 IST.

Independent checks verify the same live build, feed 200, admin login redirect 307
and unsigned webhook 401. Migration
`20261004121413_serialize_follow_block_relationships.sql` maps to production ledger
version `20261004141520`. Both deployed function digests and grants match the
clean local replay. Only function fingerprints changed relative to 8B; trigger
bindings, policies and constraints are unchanged. Security advisor groups remain
unchanged (one INFO group, 37 WARN groups, no ERROR).

Four bounded production rollback controls pass: block removes follows in both
directions, subsequent follow insertion is denied in either direction, and an
explicit unblock permits a new follow. Separate readback confirms zero fixture
accounts and zero existing follows across blocks. Concurrency reproduction and
verification were local/CI only, with six permanent SQL cases. No historical
relationship repair was needed. Private evidence:
`.audit-evidence/backend-social/block-release/`.

The [8C finding](backend-section-08-follow-block-race-2026-10-04.md) is fixed and
released. SOCIAL-03 remains failed for the subsequently reproduced 8D blocked
creator comment-thread read until its candidate is released. Broader moderation
and lifecycle matrices remain open.
