# Section 9C — push receipt write recovery

Four real local PostgREST fixture cases reproduce false successful receipt
maintenance results when receipt or token updates fail. The provider responses
and specific database HTTP 503s are injected; all allowed reads/writes use the
real isolated database. No Expo request is sent.

Before the fix, a failed token retirement still finalized its DeviceNotRegistered
receipt as error while the token remained active, removing that receipt from
future pending scans. Failed stale or successful-receipt writes also incremented
success counters even though their database rows remained pending.

Receipt maintenance now checks stale/receipt update errors and counts only
successful writes. Token retirement checks its update error. DeviceNotRegistered
processing retires the token before finalizing the receipt. If retirement fails,
the pending receipt survives for retry; if finalization fails afterward, retrying
the already inactive token preserves its first disabled_at timestamp.

All four actual PostgREST cases pass afterward, including partial-write retry.
Four unit regressions run in ordinary CI, alongside the existing notification
suite (73 focused cases total). App/test typechecks and scoped lint pass.
Fixtures are isolated users/tokens/notifications/deliveries, removed by Auth-row
cascade with separate delivery/token absence checks. The test blocks provider
telemetry persistence to avoid a default environment client. Private evidence:
`.audit-evidence/backend-social/mobile-receipts-*`.

No migration or mobile app runtime change. The shared token-retirement helper
also now surfaces failures to its existing send/retry callers; their existing
notification cases pass. Remaining retry-send persistence, provider acknowledgement
loss, device delivery and notification lifecycle matrices stay open. This release
only repairs the demonstrated receipt-maintenance failures. JOB-03 is failed
until the scoped fix is deployed, then returns to untested for its larger scope.
