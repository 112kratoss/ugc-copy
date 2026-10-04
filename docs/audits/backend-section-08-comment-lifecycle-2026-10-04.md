# Section 8D — comment thread visibility and lifecycle

October 4, 2026. SOCIAL-02/03 partial evidence. Based on main 7116126d, which
includes the separately verified save-counter release and merged block/follow fix.

## Reproduced visibility gap

The comment list service verified that a post was public and filtered individual
comment authors against the viewer's block relationships. It did not check the
post creator. As a result, a viewer who blocked the creator (or whom the creator
blocked) could still retrieve the thread's comments written by other people.
Both cases fail in the actual local PostgREST/service probe; six other lifecycle
and visibility controls pass before the change.

The service now checks the post creator against the already-loaded block set
before reading comments. If that set was truncated at its cap, an exact lookup
checks the creator. A block in either direction returns the existing 404
post-unavailable response. Anonymous public reads and unblocked thread reads
keep their current behavior. This adds no database migration or client contract.

## Verification

- Eight real local PostgREST/service cases pass after the fix: create/read/remove,
  denied foreign removal, retained parent/reply, blocked comment author, creation
  across a creator block, private/archive/moderation visibility, and both creator
  block directions. These are service transport tests, not outer JWT admission.
- Eleven permanent actual PostgreSQL cases pass: author/owner boundaries,
  cross-post/nested/removed parents, private/archive/hidden posts, denied client
  RPCs, deleted-author anonymization, retained replies, rollback, competing
  removals, and a reply waiting on parent removal. Quality's database job runs
  these cases. No additional SQL defect was established by this scoped matrix.
- 46 focused service/route/database tests pass, including denying the blocked
  creator beyond the block-set cap before any comment row is read.
- App/test types, scoped lint and diff checks pass.

Run transport cases only with explicit local credentials and database:

```sh
AUDIT_STORAGE_CONFIG=.audit-evidence/backend-storage/local-status.json \
SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
npx vitest run --config vitest.comments-postgrest.config.ts
```

Both endpoints are loopback-guarded. Fixture users/posts and rate-limit entries
are removed; user absence is read back. Private logs under
`.audit-evidence/backend-social/comment-*` retain the two-failure baseline.
No production mutation, push send or provider charge is part of these probes.
Candidate CI/release remain pending. Full social lifecycle, moderation, client
visibility and comment transaction combinations remain open; these controls
are not a claim of full comment or account-deletion certification.
