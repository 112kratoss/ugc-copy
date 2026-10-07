# Sections 11X–11Z — credit and onboarding release

PR [#401](https://github.com/112kratoss/ugc-copy/pull/401) merged at
07:35:23 UTC on October 7, 2026 as `0dbef436224bafae647f8a40979daad8a4d5bb90`.
All five candidate jobs in [Quality 37583632596](https://github.com/112kratoss/ugc-copy/actions/runs/37583632596)
passed on `ae248eb8105d5a55460ec6be753e4531d07a8dcc`. All five exact-main jobs
in [Quality 37588261608](https://github.com/112kratoss/ugc-copy/actions/runs/37588261608)
and the standard [production release 37589599345](https://github.com/112kratoss/ugc-copy/actions/runs/37589599345)
passed. PRs #399/#400 were superseded and closed; their changes are included.
Fresh verified-parent, schema/advisor, live/main and mobile-store-idle gates
passed before merge.

Independent verification at **14:54:13 UTC** confirms the exact live build and
project, all six tested runtime-source digests, unchanged schema fingerprints
and all **110** unchanged security findings. Feed/build return 200, protected
admin redirects with 307, and unsigned Kie delivery returns 401. Private evidence:
`.audit-evidence/backend-social/credit-inputs-combined-release/`.

Admin credit, onboarding state and welcome claim reject unsigned null requests
with private 401s. Public onboarding events and credit-order null bodies return
private 400s. The initial verifier incorrectly expected an unsigned credit-order
null body to return 401: source inspection confirms absent Authorization is
delegated by identity admission, and the handler validates the plan before Auth.
The original verifier is retained; the corrected verifier additionally proves an
unsigned valid plan and an invalid bearer both return private 401s. This is a
verification correction, not a runtime change or a relaxed authentication gate.

The combined local suite passes **56 actual Auth/session/PostgREST/SQL cases**.
11Y separately passes 50 focused/component controls; 11Z passes 33 focused
order/provider controls. [Actual browser evidence](backend-section-11-admin-credit-browser-2026-10-07.md)
confirms goodwill previews and commits 500/0 → 507/7, and clawback restores
500/0 through the real local form, session, route and SQL. All owned rows were
removed, with independent zero counts. No migration or mobile runtime change.

The prevention fix is released. A historical promotional-only production
adjustment still needs intent/activity review and reconciliation; no customer
balance was changed. PAY-04 remains open for this review and broader lifecycle
coverage. MAP-02 remains failed pending the separate 12A commerce-input release.
No provider purchase/refund or installed-client restore is certified here.
