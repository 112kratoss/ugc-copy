# Section 8H — share attribution and lifecycle controls

Thirteen actual local PostgREST/database tests pass. This batch adds behavioral
evidence, with no reproduced runtime defect or migration. It does not close
SOCIAL-02/04, MAP-02 or the full community matrix.

The permanent suite is `src/__tests__/social-share-postgrest.test.ts`, opt-in via
`vitest.social-share-postgrest.config.ts`. It invokes the real profile/post share
services and SQL RPCs; only post notifications are replaced with a call recorder
to avoid external delivery. It covers:

- Signed and anonymous actor attribution, event rows and aggregate counters.
- Private, archived and hidden post denial without an event or notification.
- Both block directions denying profile and post shares without side effects.
- Removed usernames refusing profile events.
- Eight concurrent clicks per target producing eight events and counts.
- Invalid RPC event inputs rolling back without a counter change.
- Anonymous direct RPC calls denied even with an existing actor ID.
- Actor deletion anonymizing events while preserving lifetime counts.
- Creator deletion cascading both target event ledgers.

Six actual Next HTTP requests supply ten additional passing assertions:
signed profile sharing binds the verified caller despite forged actor fields;
anonymous post sharing ignores those fields; both block directions return 404
on both routes; rejected requests add no events. Signed response caching is
private/no-store. Disposable Auth users, posts and per-user rate entries were
removed, absence checked, and the isolated server stopped afterward.

Local test typecheck and scoped lint pass. The first typecheck caught the
notification stub returning undefined instead of its declared nullable result;
the stub was corrected to null. No application change was needed. Private raw
logs and HTTP probe/results live under `.audit-evidence/backend-social/share-*`.

Limits: post notifications are observed at their call boundary; this does not
verify provider delivery. Requests here cover established block/visibility state,
not overlapping moderation transactions. Clicks represent separate events rather
than idempotent purchase-like operations. Rate exhaustion, request byte limits,
share-visit attribution, retention and remaining direct client roles still need
coverage. Anonymous public sharing remains intentionally available.
