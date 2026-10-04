# Section 8D — comment visibility release

[PR #339](https://github.com/112kratoss/ugc-copy/pull/339), head
`3720477850ad85335693ca8aec5dc4ab0a75efcb`, passed all four Quality jobs in
37208266763. It merged as `6808cd7c4fd1345c8f436bc1a3c15e33f3fbfae7`
at 2026-10-04 15:53:46 UTC / 21:23:46 IST. No mobile store release was active
immediately before merge.

Exact-main Quality 37214724770 passed all four jobs. Standard production release
37215325204 succeeded at 16:07:17 UTC / 21:37:17 IST, including staged and live
protected health checks. Independent live verification confirms the exact merge
SHA, public feed HTTP 200, unauthenticated admin redirect 307 and unsigned provider
webhook rejection 401. Private evidence: `.audit-evidence/backend-social/comment-release/`.

The [comment-thread finding](backend-section-08-comment-lifecycle-2026-10-04.md)
is released. Eight actual PostgREST controls, eleven SQL lifecycle controls and
46 focused tests passed locally; permanent SQL lifecycle cases now run in CI.
No migration, mobile runtime change or historical data repair was needed.

SOCIAL-03 returns to untested for the remaining moderation/visibility matrix.
The scoped block/comment fixes do not establish complete community or account
lifecycle coverage. This release does not change provider or external audit gates.
