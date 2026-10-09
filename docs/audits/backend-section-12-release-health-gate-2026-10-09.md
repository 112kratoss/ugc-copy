# Section 12R — exact build identity at protected release gates

The staged and promoted health verifiers used `body.buildId && mismatch`. A
successful health response without `buildId` therefore passed without proving
that the inspected backend was the intended commit. Separately, post-promotion
verification made one request: a valid old build response immediately failed,
even if the following request would serve the intended healthy build. Actual
standard releases 37882874131 and 37914826551 failed that mismatch check before
unchanged retries passed; their underlying serving behavior is not diagnosed.

The existing workflow's actual shell block was run as a subprocess against a
loopback HTTP server. A missing-ID/healthy response incorrectly exited zero;
an old-then-current sequence failed after the first response. Four controls
(matching, degraded, unauthorized and malformed responses) passed. Before logs
are retained privately. This reproduces verifier behavior, not a Vercel routing
fault or an actual unidentified production health response.

Both gates now require an exact SHA. The staged gate remains immediate. After
promotion, the new script retries only a valid different SHA, for at most twelve
requests within sixty seconds. Each request has a five-second timeout constrained
by the remaining overall budget. Requests bypass caches and include release and
attempt query fields. Redirects are rejected; credentials and response bodies are
not logged. A matching build must report `ok`; all other errors and missing or
malformed IDs fail immediately. Exhaustion fails, never silently succeeds.

Twenty-two checks pass: nine actual workflow-shell/HTTP cases, actual twelve-
request stale exhaustion and a nonresponding endpoint, a deterministic deadline
case, four executions of the staged Node verifier, and six workflow integration
guards. Test typing and scoped lint pass. No application runtime, schema,
credential, provider or customer data changes are involved.

Private evidence uses `production-health-gate-*` under
`.audit-evidence/backend-social/`. OPS-04 is reopened for this operational health
verification gap until CI and the modified standard release prove the exact
candidate. This does not close the wider operations or recovery matrix.
