# Realtime exposure — current configuration

DB-04 passes for the current configuration: no application table is published
through Postgres Realtime. This is an absence-of-exposure certificate, not a
certificate for a future table-stream feature or its revocation semantics.

Fresh production Management API inspection on October 5 (Asia/Kolkata) finds
exactly one publication, `supabase_realtime`, with `all_tables=false` and zero
published tables. The isolated local catalog matches. Both have zero policies
on the Realtime schema. Current `src/` and `ugc-mobile/` source has no Supabase
Postgres Changes channel/subscription consumer; source/migrations contain no
Realtime broadcast/send producer. Other UI/query-cache subscriptions are unrelated.

An actual local WebSocket probe uses independently authenticated owner and other
users plus an anonymous client. All three channels reach SUBSCRIBED. Existing
connections remain open while the owner profile changes, that Auth user is
deleted, and the other profile changes. Zero row events arrive. Two channels also
receive the explicit Postgres Changes system error that the requested table is
not enabled. The owner channel has no recorded system message; the catalog,
not absence of that message, establishes the empty publication. This matches
published-table absence rather than claiming an exercised RLS filter.

The first attempt hit transport failure because the audit stack omitted Realtime;
it is preserved as an infrastructure failure, not counted as an access-control
pass. Restarting only `magicbooklet-auth-section-one` with Realtime enabled made
all three connections work; the primary stack was untouched. Both attempts
removed disposable users, checked absence, removed channels and disconnected.

Private evidence: `.audit-evidence/backend-realtime/production-publications.json`,
`local-publications.json`, `subscription-results.json` and the original failed
transport result. No production identity, publication, table or policy was changed.

Reopen DB-04 before enabling a table publication or introducing application
broadcast/private channels. At that point it needs real positive delivery,
column/row ownership controls and already-open-connection revocation tests for
the enabled feature. Arbitrary empty client-created channels contain no
application-produced data in the current implementation.
