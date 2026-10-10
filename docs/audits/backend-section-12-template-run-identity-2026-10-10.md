# Section 12Y — template run identity and HTTP action recovery

Twenty-five actual local Auth/PostgREST/Storage controls pass for template run
read, cancel, retry and approval handlers. No application or schema fix was
needed. The tests run the native Request/Response adapters with real bearer
verification and service database calls; they capture deferred workers without
executing paid work. The sequential Supabase API CI job includes the suite.

Twelve cases reject another authenticated user, unsigned requests and malformed
bearers across all four methods. Denials return private, non-cacheable errors,
leave the run, steps and queue unchanged, and schedule no worker. Additional
controls reject unknown step IDs and actual steps from another user's run.

Owned reads fetch the exact original image bytes using the returned signed
Storage URL without mutating the run. Owned cancellation is repeatable; retry
and approval refuse cancelled runs. Approval commits the checkpoint and one
queue ticket and rejects duplicate approval. Checkpoint retry creates exactly
one new generation/approval pair; replay creates no extra attempt or ticket.
Failed-generation retry resumes the queue and likewise reuses its new attempt.

Two transport controls return HTTP 503 for the actual run lookup or atomic
approval RPC. The handler reports HTTP 500 with no state change or deferred
work; removing the fault permits a healthy retry. The read case retains the
installed PostgREST client's real retry/backoff behavior. Its initial test used
the default five-second test timeout and expired during that backoff; the final
case has a bounded 30-second allowance and passes without altering application
retry policy. This was a test timeout, not evidence of a product defect.

All 25 cases pass in 9.19 seconds, including 8.54 seconds of test execution.
Test typechecking, scoped lint and diff checks pass. Per-case cleanup checks
zero run, step, job, template and rate-limit fixtures; suite cleanup verifies
fixture Auth users and the Storage object are absent. Every case verifies
unchanged credit balances, no generations or usage ledger entries, and no
external network requests. The first 21-case run and the intermediate timeout
are retained alongside the final evidence in `.audit-evidence/backend-social/`
(`template-run-auth-*`).

This adds handler-level proof to WORKFLOW-02/03; it does not certify deployed
proxy/session lifecycle admission, browser/mobile routing, provider execution,
worker recovery, hosted signed-URL expiry, or the whole workflow matrix. The
approval path depends on the still-pending 12V migration in PR #433. Candidate
CI inclusion and release verification for this test-only batch remain pending.
