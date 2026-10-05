# Section 9H — atomic push registration

Baseline `f69759ed` (9G candidate, incorporating released 9F). A deterministic
race in `registerMobilePushTokenForRoute` reproduces with real isolated Auth,
PostgREST and SQL state. A disposable registered user signs in through two
independent clients. They submit different valid Expo token strings for the same
device ID. A transport barrier waits until both token upserts have committed,
then allows both existing stale-device cleanup statements to proceed.

Both calls return `{ok:true, body:{success:true}}`. Both stored token rows are
inactive afterward: each request disables the other's token. Thus successful
registration can leave that device with no active push destination. The barrier
controls scheduling only; Auth user verification, table writes, preferences and
RLS use the real local services. Only the unrelated rate-limit helper is stubbed
to avoid adding fixture counters. No provider is contacted.

Private evidence: `.audit-evidence/backend-social/mobile-registration-race-probe.test.ts`,
`mobile-registration-race.config.ts`, `mobile-registration-race-baseline.log`.
The passing characterization asserts the defective state. User deletion cascades
its token fixtures and SQL confirms cleanup. No production state was changed.

## Implemented transition

The verified-user API now invokes one service-only, invoker-rights RPC after
payload validation and the existing rate limit. The RPC serializes the incoming
Expo token, then the affected accounts in UUID order. It retires foreign ownership
and older same-device tokens, upserts the new token, and initializes preferences
in one transaction. Any failure rolls the entire transition back. Existing paused
preferences and token row IDs survive repeated registration. There is no mobile
request/response change, new auth grant, or SECURITY DEFINER escalation.

The first draft attempted a redundant auth.users read; actual service-role
execution exposed that role's missing SELECT privilege. The final function relies
on the API's verified registered identity and the existing ownership foreign key.
Guest rejection remains at the API boundary. No auth-table privilege was added.

## Verification

The permanent Auth/PostgREST regression fails against the baseline service at
34fc96ee: both calls succeed but zero tokens remain active. The same test passes
against the atomic implementation. Seven actual local cases pass: this race,
eight same-device rotations with a separate device preserved, eight same-token
account handoffs, opposite account transfers, injected preference-write failure
with full rollback and retry, idempotence with paused preferences, and denied
anonymous/invalid-input calls. Authenticated direct RPC access is also denied.
All disposable owners/tokens are removed. No Expo request is made.

Three additional real SQL concurrency cases run in Quality's isolated database
job, which has no Auth/PostgREST services. They cover eight rotations, eight
account handoffs and opposite transfers using separate service-role connections.
The full Auth/PostgREST suite remains an explicit local integration run.

Clean migration replay passes, followed by 2,068 SQL assertions across 96 files
(including 22 registration assertions). Public schema diff reports no changes.
The 92 focused service/route/notification tests, application and test typechecks,
and scoped lint pass. Migration 20261005100245 is not yet released. Private logs
are under .audit-evidence/backend-social/mobile-registration-*.

## Limits and release gates

This serialization covers callers using the new RPC. Existing authenticated
mobile_push_tokens table grants/RLS are preserved for compatibility; direct table
writes and older server deployments do not join its advisory lock protocol.
Rolling deployment therefore has a mixed-version interval until the new backend
is serving requests. No unique-device index or historical token backfill is
introduced, and physical-device push delivery is not established by these tests.

PR exact-head Quality, the mobile-store idle check immediately before merge,
exact-main Quality, standard release and independent production schema/rollback/
cleanup/advisor verification remain required. JOB-03 remains failed pending this
release, notification summary-write recovery and broader device evidence. This
batch does not complete the full backend audit.
