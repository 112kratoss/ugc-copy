# Sections 11Q/R — workflow input validation and billing release

PR [#393](https://github.com/112kratoss/ugc-copy/pull/393) merged at October 7,
2026, **05:07:28 UTC** as `547b6658acaac7e9234efb1ce3ee2826da3304ec`.
Final exact-head [Quality 37573889158](https://github.com/112kratoss/ugc-copy/actions/runs/37573889158)
passes all five jobs on `af4f6941c2d971f4295f8a5fea7155f40b682234`, including
the merged #392 parent and all 25 actual authoring/billing API cases. Initial
Quality 37572636133 is historical; it did not gate the final candidate.
Exact-main [Quality 37574773814](https://github.com/112kratoss/ugc-copy/actions/runs/37574773814)
and the standard [production release 37575379640](https://github.com/112kratoss/ugc-copy/actions/runs/37575379640)
pass. Fresh parent schema/advisors, exact main/live and immediate mobile-store
idle gates passed before merge.

Independent readback at **05:21:27 UTC** confirms the exact live build/project,
unchanged public schema and all **110** unchanged security findings. Both changed
runtime source digests in that live commit match the 25-case tested candidate.
Unauthenticated blueprint POST and canvas PATCH return private/no-store 401.
Build/feed return 200, admin redirects with 307 and unsigned Kie delivery returns
401. These live probes do not claim a fresh signed production authoring fixture.

[11Q](backend-section-11-workflow-authoring-inputs-2026-10-07.md) records the nine
input failures and their real local Auth/PostgREST reproductions. Validation now
rejects invalid roots, malformed JSON and wrong-type required planner fields
before authoring, billing or provider work. Valid-body semantics, ownership,
pricing, schema and installed mobile contracts are unchanged.
[11R](backend-section-11-blueprint-billing-2026-10-07.md) records nine real local
billing/replay/refund controls with controlled provider replies and independent
zero fixture cleanup. No paid request or customer balance change is performed.

The reproduced WORKFLOW-04 defects are resolved; the row returns to **untested**
for its remaining publication/assistant/input matrix. WORKFLOW-03 stays open
for broader conservation and recovery evidence. Private release comparison is
in `.audit-evidence/backend-social/workflow-inputs-release/`.
