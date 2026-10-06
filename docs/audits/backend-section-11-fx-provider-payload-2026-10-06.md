# Section 11A — reject incomplete or invalid supported FX rates

The actual FX route accepted and publicly cached upstream responses with a
valid USD rate but a missing, null, zero or negative EUR/GBP/AUD/CAD/SGD rate.
The response promises all six supported currencies; incomplete responses violate
that contract, and a negative rate can produce a negative approximate price in
the pricing display. This establishes a fixture defect, not an incorrect charge
or a production provider incident. The read-only live baseline returned all six
positive rates.

The regression uses a real Node HTTP server bound to loopback and the actual
route adapter, rate service and provider fetch. Only the transport destination
is redirected: the test asserts the requested upstream URL before forwarding
the request to the local server. No external FX provider request, purchase or
customer mutation is made by the regression.

Before the fix, 20 of 28 actual HTTP cases fail: each non-USD supported currency
with a missing/null/zero/negative rate returns HTTP 200. The eight passing
controls cover a valid response, invalid USD and malformed/disconnected/503
provider responses. The candidate requires every supported rate to be numeric,
finite and strictly positive before applying the existing USD/INR plausibility
check. Invalid responses use the existing `503 { error: 'fx_unavailable' }`
and no-store policy. A complete valid response still returns all six rates with
the existing public hourly edge cache; unsupported currencies are omitted.

All 28 actual HTTP cases pass after the fix. All 54 focused cases across the
HTTP, service, adapter, route and currency suites pass under the regular Vitest
configuration. App/test types and scoped lint pass on Node 24. The actual HTTP
test uses the Node environment; the shared test setup now checks that `Element`
exists before installing its DOM-only scroll stub. Browser test behavior is
unchanged. No migration, grant, dependency or client contract changes.

Private before/after, focused, types and lint evidence is under
`.audit-evidence/backend-social/fx-provider-payload-*`; the live baseline is
`fx-live-before.json`. The candidate includes separately committed 10I signed
webhook retry evidence and the independently verified 10F release record.

OPS-04 remains failed until this fix passes exact-head and exact-main Quality,
the standard production release and independent live/schema/advisor checks.
Afterward, its other assigned methods and seven page-only services still need
behavioral coverage. Parent retention fix #379 must be independently verified
before merging this candidate. The full backend audit remains active.
