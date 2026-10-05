# Section 9H investigation — concurrent device registration

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

No fix is included yet. Follow-up needs an atomic device/token registration
transition with ownership-safe serialization, failed-write rollback and actual
concurrent registration/rotation/account-handoff tests. Preserve guest rejection,
rate limits, user ownership/RLS, first-use preferences and response contracts.
Do not let an earlier request's cleanup deactivate the token registered by a
later successful request. JOB-03 remains failed; this is not an additional
closure obligation or a completed registration audit.
