# Section 11B — operations ingress and diagnostic timestamps

The public mobile diagnostics parser checks that an event timestamp is finite
and positive, then calls `new Date(at).toISOString()`. Finite numbers outside
the Date range pass the first check and throw `RangeError`. Two actual loopback
HTTP regressions reproduce this with `8640000000000001` and `Number.MAX_VALUE`:
the route rejects with an unhandled exception, caught by the audit bridge as
HTTP 500, instead of returning its normal invalid-report 400. This establishes
a local input-validation defect; no production incident is attributed.

The candidate checks the constructed Date's numeric time before formatting it.
Unrepresentable timestamps return the existing private/no-store 400 without
logging the report. Existing valid timestamps, including the previously accepted
maximum Date boundary, remain accepted. This does not add a new age/future-time
policy. No schema, grant, auth, dependency or client release changes.

The 25-case integration suite uses actual Node HTTP requests, the real route
adapters, bounded body reader, network-key selection, service client,
PostgREST and local SQL limiter. It covers:

- Valid anonymous CSP, diagnostics and playback reports; actual playback rows
  contain the submitted numeric values and CSP labels omit query/fragment data.
- Both CSP formats, unsupported content types, malformed JSON and oversized
  streamed bodies without Content-Length.
- All three real SQL limiter buckets, Retry-After denial and trusted network-key
  precedence over a client-supplied forwarding header. The denial fixture seeds
  its isolated bucket to the limit before the actual next HTTP/RPC request.
- Injected limiter transport failures, playback insert failure followed by a
  successful retry, and anonymous direct table-write/RPC denial.
- The two unrepresentable timestamps, the valid Date boundary and release-build
  precedence/no-store app-version output.

Baseline: 23/25 pass, with both timestamp cases reporting the captured
`RangeError`. Candidate: all 25 pass. All rate buckets and playback rows are
deleted by their specific random fixture keys/session IDs and independently
read back empty after every case. Credentials and API/DB hosts are explicitly
loopback; the suite never loads `.env.local` or contacts production.

All 54 focused cases across seven existing operations/body/network suites pass.
Shared contract examples document the accepted timestamp bound and invalid
response; nine web contract cases and 143 mobile contract/diagnostics cases
pass. App, web-test and mobile types and scoped lint pass on Node 24. Two
adapter regressions and the shared web contract test run in regular CI; the
actual PostgREST suite requires explicitly supplied local fixture credentials.
Private evidence is in `.audit-evidence/backend-social/ops-ingress-*`.

The HTTP bridge does not certify Next middleware, generated HEAD/OPTIONS,
deployed CORS/version gating, genuine device delivery or admin page collectors.
Those remain in OPS-04/MAP-02. Seven services lack API callers in the inventory:
six admin collectors belong to OPS-GATE and the home dashboard belongs to
SOCIAL-GATE. OPS-04 remains failed until both this reproduced defect and 11A's
FX finding are independently released/verified, then returns to untested for
its remaining scope. Hold merge until parent #380 is independently verified.
