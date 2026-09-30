# Section 6E — incomplete provider task receipts

Status: deployed and verified on `d5d71fba` through PR #251; see the
[release evidence](backend-section-06-start-recovery-release-2026-09-30.md).

## Finding

An HTTP-success response from task creation could contain unreadable JSON, no
body status, or no usable task ID. The shared parser treated some of those
responses as rejections, immediately refunded the generation and cleared its
request key. A subsequent callback was acknowledged but could not recover the
terminal generation. A retry could therefore create another provider task.

Six real-PostgreSQL regressions failed before the fix: malformed JSON, null body,
missing code, missing task ID, blank task ID and numeric task ID. The missing-data
case already passed because its TypeError happened to enter the network-error
classifier. That incidental behavior did not cover the other incomplete receipts.
The first harness attempt failed callback URL preflight; it is preserved
separately and is not defect evidence.

An actual local HTTP POST to `/api/generate-image` with an isolated provider
returning HTTP 200 and truncated JSON produced HTTP 500, a failed/refunded row,
cleared request key, and restored balance 500. A subsequent correctly signed
callback returned 200 but left that row failed and created no completion job.

## Fix and verification

The parser requires a success code plus a nonblank string task ID. An incomplete
HTTP-success receipt enters the existing ambiguous-submission hold, preserving
the generation, credits and request key for callback/reaper recovery. Explicit
numeric body-level rejections retain their refund behavior. Valid task IDs are
trimmed before attachment. The existing provider outcome recorder counts the
incomplete receipt as a failure instead of recording success without an identity.

The signed HTTP retest returns 409 `submission_pending`; a callback attaches and
resumes processing; same-key retry returns the existing task with
`idempotentReplay: true`. One provider call occurred and the balance remains 492
after the actual catalog's 8-credit reservation. No second hold or refund occurs.

Fourteen permanent real-database cases cover the seven receipt shapes, lost
provider response, callback before either a complete or incomplete creation
response, standalone and template rejection controls, template recovery, and
20 overlapping same-key requests. The latter pauses the winning request at the
provider boundary, then issues 19 concurrent requests over a connection pool;
all reuse/refuse the existing hold, one provider call occurs, and a changed
payload is rejected. This is not a simultaneous first-read barrier test.

The database harness uses actual reservation, request-claim, lock, attachment,
settlement and callback-admission RPCs with committed local fixtures. Admission
telemetry and provider fetch are test boundaries. The HTTP harness runs real
Next routes and PostgreSQL behind a local REST bridge; Auth validation is stubbed
for a synthetic identity, provider requests are redirected locally, and every
nonlocal fetch is blocked. This proves neither production authentication nor
genuine Kie/edge delivery. Fixtures are deleted and the HTTP server is stopped.

The existing 409 error is now recorded in the shared contract. Web route and
mobile API tests consume that fixture; the mobile client classifies it as an
ambiguous start so it can retain the request key. No mobile runtime code changes,
binary or OTA is required. No database migration is required.

Local validation: 136 focused web/DB checks (including 14 DB cases), 133 mobile checks,
app/test/mobile typechecks and targeted lint. The new DB suite runs in Quality's
clean-replay job. Private evidence: `.audit-evidence/backend-section-06e/`.

A read-only production aggregate found seven refunded rows with no provider task
and no ambiguity marker, zero marked ambiguous rows and zero active rows without
a task. These seven rows also match legitimate start rejection and cannot be
attributed to this defect from this aggregate. No customer repair was attempted.

The documented successful response shape is `code: 200` with a string task ID:
[Kie task creation reference](https://docs.kie.ai/market/google/nano-banana).
The recovery policy for malformed responses is our defensive behavior, not a
claim that the provider documents or routinely produces them.

Next: failure to persist the ambiguity marker (including lost write response),
followed by worker process termination. Those paths remain separate audit
obligations and are not certified by this batch.
