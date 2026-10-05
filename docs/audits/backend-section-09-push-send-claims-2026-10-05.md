# Section 9E — durable push retry claims

Released in PR #356, merged as `cd264d39` on October 5 at 04:36:54 UTC.
See the [release verification](backend-section-09-push-claims-release-2026-10-05.md).
The candidate was based on 9D head `469d3231`.
The [baseline investigation](backend-section-09-push-send-budget-2026-10-05.md)
reproduces undercounting by overlapping workers, sends beyond the configured
cap when ticket writes fail, and lost accounting after SIGKILL.

## Implementation

Migration `20261005031821_fence_mobile_push_retry_attempts.sql` adds a claim ID,
expiry and recorded outcome to each delivery, plus a partial recovery index.
Three service-only SECURITY INVOKER functions with empty search paths claim,
record and finalize. A compare-and-set against the observed attempt count admits
one claimant and durably increments the counter before the provider request.
The claim lives for 60 seconds; the existing provider request timeout is five
seconds. Each maintenance pass makes one request per claimed delivery. Transient
failures spend subsequent attempts on later scheduled passes instead of doing
several unrecorded requests within a pass. The configured three-attempt total is
unchanged. A killed worker consumes its reserved attempt, even if it died before
sending; this conservative bound can sacrifice a delivery opportunity.

Unknown results retain `PushRetryOutcomeUnknown` with the spent attempt. Recorded
results cannot be replaced by another claim and survive cleanup failure. Each
maintenance run recovers saved results first, even at the attempt cap. Token
retirement and delivery finalization are one transaction; repeated/foreign/old
claims cannot finalize or retire a token. A matching replacement token row is
bound during claim; finalization additionally checks its owner and token string.
Paused/inactive closure cannot overwrite an already recorded provider result.

If the provider accepted a request but its result never became durable, a later
expired claim can still send again within the remaining budget. No exactly-once
or guaranteed-delivery claim is made. When the cap is reached with an unknown
outcome, it remains recorded for inspection and is not resent. First-send
persistence and genuine device/provider delivery remain separate audit work.

## Verification

Sixteen actual isolated PostgREST/SQL and worker cases pass: eight contenders,
active/expired claims, real 60-second expiry, stale completion, exhaustion,
malformed outcomes, anon/auth role denial, token-row replacement, transactional
rollback under an injected token trigger failure, concurrent maintenance, failed
claim before send, repeated outcome-write failure, lost write acknowledgement, saved refusal recovery at cap,
and SIGKILL recovery. Provider responses and selected write failures are injected;
no actual push is sent. Fixtures are deleted and child exit awaited.

Two prior paused/inactive closure transport cases remain. The other four 9D
transport cases are superseded by the claim/outcome/cleanup controls; their
original expected PATCH behavior no longer describes this worker. Eighty-five
focused notification, route, deep-link and migration tests pass. Full migration
replay and all 1,991 SQL tests in 93 files pass. Application/test types and scoped
lint pass. The public-schema comparison before the final partial-index addition
reported no drift; the final index is included in the subsequent clean replay. Normal CI runs
the focused/unit and SQL regressions; transport suites require the explicit
loopback configuration and are opt-in.

Private evidence: `.audit-evidence/backend-social/mobile-claims-*`, the original
`mobile-send-budget-*` failure probes, and the worker safety logs. Docker stopped
between runs; it was restarted without removing volumes. The initial attempt to
use psql failed because it is not installed; local SQL uses the existing pg
client. Early test-harness type/lint failures were repaired; they were not counted
as successful validation. Production application and independent verification are now recorded in the release report.

Release must apply the migration before the worker. Retain the additive schema
if rolling back application code; rolling back to the pre-claim worker forfeits
these retry guarantees and needs explicit operator handling of recorded outcomes.
The full audit remains open, including poison-work progress and external delivery.
