# Section 11F — active catalog lookup and actual collector controls

After eleven newer shadow catalog releases, the admin System collector reported
no active catalog and zero entries, although the active release was unchanged.
The actual PostgREST regression fails with `activeRevision: null` before the fix.
The collector now queries the newest active release independently of its
ten-entry history list. The existing history bound stays intact; lookup errors
remain visible rather than being converted into an empty active catalog.
No catalog is activated, retired or republished by this reporting change.

The actual API suite now exercises all six admin collector modules across 21
cases: overview guest/registered and purchase counts; revenue rail exclusion,
range budgets and second-page failure; content timestamp ties, hidden filtering,
out-of-range recovery and generation windows; explicit user lookup/detail and
mirror exclusion; current contact triage activity; system job aggregation and
active catalog lookup; and denied anonymous reads of private collector tables.
These are bounded behavior controls, not an assertion that every query or
failure path in each module is covered.

All 21 actual Auth/PostgREST/SQL cases and 50 focused cases pass; app/test types
and scoped lint pass. Initial generation fixture construction used `starting`,
which the actual SQL constraint disallows. The fixture now uses supported
`waiting` as the excluded control alongside pending/processing; no lifecycle
constraint or runtime generation behavior was changed. Exact fixture Auth,
profile, transaction, post, generation, contact, job and shadow-release cleanup
reads back empty. No provider task or payment was initiated.

A read-only production lookup finds active revision `gpt-image-2-5-20260911`,
38 entries and no newer releases. No current production catalog disappearance
or customer incident is attributed. Private before/after and aggregate evidence
is under `.audit-evidence/backend-social/`.

11D/E/F are consolidated into collector PR #382, retaining separate reports
and all reproduction controls. #383's row-limit code is included rather than
released separately. The combined exact head must pass all five Quality jobs
and wait for #381 to be independently verified live. Standard deployment and
independent schema/function/privilege checks remain. OPS-04 remains failed for
pending known findings; wallet limits, partial failures and broader deployed
method behavior remain audit work. The complete audit is still open.
