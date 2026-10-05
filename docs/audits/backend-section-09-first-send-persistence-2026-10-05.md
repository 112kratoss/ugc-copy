# Section 9F — initial push persistence

October 5, 2026; baseline 9E candidate `690aa98f`. Two actual isolated PostgREST
characterizations reproduce failures in `createMobileNotification` / the batched
initial send, outside the retry worker changed in 9E.

An injected accepted Expo batch reply followed by a failed delivery-row INSERT
leaves a notification in history but no delivery/ticket record. The function logs
the push error and still returns the notification. Retrying with its dedupe key
returns that existing notification and neither sends nor repairs the missing
ledger entry. Thus a provider-accepted notification has no receipt-recovery row.

An injected DeviceNotRegistered batch refusal writes a terminal (`stale`) delivery
and then fails token retirement. The notification call again returns success for
history creation, with the token still active and a terminal delivery outside
pending-receipt/retry selection. Subsequent notifications can target that token.

Both observations are verified with SQL readback and fixture cleanup. The initial
provider stub returned a single ticket object, which is invalid for the batch API;
those failures were setup errors. After changing it to the required ticket array,
both characterization cases pass by asserting the bad persisted state. They are
reproductions, not safety certificates. Only local API/SQL calls occurred; the
provider fetch is injected and no actual notification was sent.

Private evidence: `.audit-evidence/backend-social/mobile-first-send-probe.test.ts`,
`mobile-first-send.config.ts`, `mobile-first-send-baseline.log`.

## Candidate implementation

`sendMobilePushForNotification` reserves delivery rows, each with a unique claim,
before any Expo request. All device batches are reserved first. The row records
an unknown result and the full three-slot initial budget. Accepted tickets and
refusals are saved with the same claim through a bounded (100-item) batch RPC;
a second RPC atomically finalizes delivery state and matching token retirement.
The existing retry recovery worker can finish saved initial results after a
sender dies or finalization fails, including rows at the reserved attempt cap.
Only a known recorded result refunds unused slots to its actual attempt count.

Migration `20261005043056_reserve_initial_mobile_push_deliveries.sql` adds the
initial-reservation flag, updates the existing claim finalizer, and adds two
service-only invoker RPCs with empty search paths. Each batch save/finalization
is transactional, locks deliveries in stable ID order, and validates a 1–100
item bound. Finalization retains claim identity and owner/token matching.
Legacy rows default to false and retain the retry-claim behavior from 9E.

The existing initial batching, transient retry and refused-batch single-device
fallback behavior remains. The configured three slots refer to that established
per-device attempt accounting: a rejected multi-device batch can precede up to
three individual fallback requests. This is not a new universal three-HTTP-call
limit. Maintenance still performs one request per durable claim.

The push remains best effort. Reservation failure prevents provider contact but
leaves the in-app notification; dedupe does not re-initiate sending. A crash or
lost outcome consumes the full reservation, even for unsent later batches.
That can lose a delivery opportunity, but prevents an unknown accepted initial
send from being repeated just because its database write failed. Saved results
recover without another send. This cannot guarantee exactly-once provider/device
delivery. Notification summary-write recovery and genuine device delivery remain
separate obligations; JOB-03 is not closed by this candidate.

## Local validation

Nine actual PostgREST/SQL cases pass: reservation readback at the provider
boundary; failed reservation with no provider call; accepted result followed by
failed save; saved refusal recovery after failed finalization; 101 devices with
mixed tickets/refusal across batches of 100 and one; transient refusal continued
through the durable retry worker; real SIGKILL at the provider boundary and after
outcome save; and failure saving a later batch without replaying the finalized
first batch. Child exit is awaited, dedupe is checked after death, and cleanup
asserts no delivery/token remains for each fixture user. Provider responses are
injected and no real push is sent.

All 16 existing actual retry-claim/worker regressions also pass, including real
lease expiry. Seventy focused notification/migration tests, app and test typechecks, and scoped
lint pass. Clean replay succeeds; all 2,023 SQL checks across 94 files pass,
including 32 new controls for invoker/grant boundaries, malformed/oversized
batches, claim identity, budget refunds, idempotence, save rollback and full
finalization rollback (including token retirement). Clean-replay public schema
diff reports no changes. The first diff mistakenly targeted the fixture stack
whose workdir has no migration directory; it compared against an empty history
and is not parity evidence. The corrected run uses the replay workdir with the
repository migration symlink. Transport suites require
explicit loopback credentials; ordinary CI runs unit and database controls.

Private evidence: `.audit-evidence/backend-social/mobile-first-send-*`. The
original two bad-state probes remain baseline evidence, not passing safety
controls. The candidate is now released in #361 with [independent production verification](backend-section-09-first-send-release-2026-10-05.md).
