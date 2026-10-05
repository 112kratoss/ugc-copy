# Section 9F investigation — initial push persistence

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

Required follow-up: durable initial delivery intent before provider calls, saved
per-device outcomes and independently recoverable token cleanup, preserving batch
performance and notification deduplication/aggregation contracts. Cover worker
death between each step, partial/mixed batch results, ledger-write failure and
retries that do not re-notify users merely because recording failed. Reuse claim
primitives where appropriate without silently changing the first-send budget or
initial batch fallback rules. JOB-03 remains failed; no fix is claimed here.
