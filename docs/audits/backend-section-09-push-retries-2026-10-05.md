# Section 9D — push send retry persistence

October 5, 2026. Baseline `e1b1abc3` (9C candidate); isolated audit checkout and
Supabase API 55321/database 55322. No production fixture or actual push was sent.

## Reproduced failures

Six actual PostgREST cases fail before the fix: paused preference closure, inactive
token closure, accepted-ticket persistence, refused-request persistence, invalid
token retirement and delivery finalization after retirement. Each fixture uses a
real user, token, notification and delivery. Selected HTTP PATCH requests return
an injected 503; other table operations go through real PostgREST. Provider
responses are injected; unrelated retention RPC execution is stubbed. SQL reads
verify durable state, and user deletion plus delivery/token readbacks verify cleanup.
The fixture initially omitted its first attempt count (database default zero);
that setup error was corrected to one and the baseline and fix rerun.

The old worker reports success on failed delivery writes. When token retirement
throws, the broad catch mislabels the database failure as a provider failure and
consumes the remaining attempt budget after having finalized the refusal. An
active token can then be stranded behind a delivery outside retry selection.

## Change and validation

Unsent closure and each retry-result update now check errors. Only the provider
request is inside the provider-error catch. Persistence failures escape to the job
runner without a second fabricated provider-error update. Invalid tokens retire
before the delivery becomes terminal. If finalization fails afterward, the next
run sees an inactive token and closes the delivery without another provider send;
the first retirement timestamp is preserved. Missing-notification handling uses
the same checked closure helper.

All six actual PostgREST cases pass after the fix. Four permanent unit regressions
exercise accepted, refused, permanent refusal and paused-preference persistence
failures in normal CI. The focused notification/deep-link suite passes 77 cases.
Application/test typechecks and scoped lint pass.
No migration, client contract or mobile runtime change is involved.

Private logs: `.audit-evidence/backend-social/mobile-retry-{before,after,focused,app-types,test-types,lint}.log`.
Opt-in transport suite: `vitest.mobile-retry-postgrest.config.ts` with explicit
`AUDIT_STORAGE_CONFIG` and `SUPABASE_TEST_DB_URL` pointing only to loopback.

## Remaining gap

An accepted push whose ticket write fails remains eligible for another send.
The actual test performs the next maintenance run and observes two provider
calls, one final saved ticket and a recorded attempt count of two after the
original plus two simulated sends. This patch makes failure observable but does
not repair this attempt-accounting/acknowledgement gap. JOB-03 remains failed
until the bounded-send policy and interruption cases are addressed; there is no
exactly-once certificate. Durable pre-send accounting and recovery need separate
reproduction/design, including worker death and concurrent invocations.

Expo itself documents best-effort, at-least-once handoff to APNs/FCM, with rare
loss or duplicates. That provider limitation does not excuse our own uncounted
sends. Source checked October 5: [Expo delivery guarantees](https://docs.expo.dev/push-notifications/faq/#delivery-guarantees).
Genuine installed-device delivery, credentials and receipt behavior also remain
open; no simulator result is presented as evidence for those external boundaries.
