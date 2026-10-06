# Section 11D — keep the overview purchase counter on the web rail

The admin overview labels its 30-day paid-order counter as Razorpay credit
purchases, but counted successful mobile credit ledger mirrors as web orders.
The revenue and user-detail collectors already exclude those mirrors. Actual
PostgREST/SQL fixtures reproduce a one-order increment for a mobile-only mirror
and two orders for a mixed web/mobile fixture whose web count should be one.
Baseline: two failures, five passing exclusion/security controls.

The overview now requires `mobile_product_id IS NULL`, matching the web revenue
rail. Test-mode, non-success and older purchases retain their exclusions. This
changes reporting only; no credits, settlement, provider, schema or mobile code
changes. A read-only production aggregate found zero recent mobile mirrors and
zero recent successful web purchases, so no current production miscount or
customer incident is established.

All seven actual API/SQL cases pass, with specific transaction/Auth/profile
cleanup read back empty. The existing overview/revenue unit cases also pass
(16 cases). App/test types and scoped lint pass. Fixtures use explicit loopback
credentials and never load `.env.local`; no real purchase or charge is made.

Quality now includes an independent Supabase API job using the pinned Linux CLI
2.109.1, a minimal isolated config and a clean migration replay. It runs the 61
account-deletion/Auth/Storage cases, 25 HTTP operations cases and seven collector
cases sequentially. Generated local keys stay in private runner files and are
removed, without logging or uploading them. The separate SQL replay/concurrency
job remains. Exact-head CI must verify this new job before merge; local success
alone does not certify the Linux stack.

OPS-04 remains failed until the known operations findings are released and
independently verified. Broader semantics for the other admin collectors and
deployed method behavior remain open. The home dashboard is in SOCIAL-GATE.
The complete audit remains in progress; this bounded fix does not close it.
