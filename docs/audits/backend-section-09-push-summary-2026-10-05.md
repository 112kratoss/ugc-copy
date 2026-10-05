# Section 9I — report legacy push-summary write failures

Baseline 07d43d14. Actual local PostgREST fault injection reproduced an ignored
notification-summary update failure both before commit and after a successful
commit whose acknowledgement is replaced by a 503. The permanent two regressions
fail because no backend error is logged. In both cases the delivery row already
contains the accepted ticket, and repeating notification creation with the same
dedupe key does not send another push.

The implementation checks the summary response and logs
mobile_push_summary_update_failed with notification ID and the database error.
It preserves the created notification and durable delivery outcome; it does not
retry the provider or turn a diagnostic failure into a failed business action.
Eleven actual first-send cases (the original nine plus these two), 69 focused
notification tests, application/test typechecks and scoped lint pass.

Repository inspection found no current application reader of mobile_notifications
pushed_at/push_error or its legacy push_ticket_id summary. Receipt/retry recovery
uses mobile_push_deliveries. The summary is explicitly best effort: a failed
write can leave it absent or stale, and this change adds observability, not an
automatic repair queue. Revisit that contract before a consumer treats those
columns as delivery truth. Existing historical summary rows are not backfilled.

No migration, mobile runtime change, real push or production data repair is
required. Release gates remain. Private before/after evidence is under
.audit-evidence/backend-social/mobile-summary-*. JOB-03 stays open for the
registration release and broader notification/device matrix.
