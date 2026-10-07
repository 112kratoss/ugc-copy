# Backend catalog and caller reconciliation — October 7

Source and independently verified live build:
`3f04cb16f9435d8a20735a2ac7ca7514db9ddb3a`. Production metadata was read at
04:25:24 UTC, with matching live build reads before and after. This updates
MAP-01 scheduling evidence and MAP-02/DB-03 reconciliation; it does not close
their behavioral scope. The October 1 and October 4 snapshots remain historical.

The [current surface map](backend-audit-surface-map-2026-10-07.json) contains
162 API routes, 201 services, 337 public functions, 138 public relations and
12 jobs, with zero unassigned routes. Seven services still have reviewed page
entrypoints. Nine source RPC sites use indirect names; all are reviewed. The
additional site calls five supplementary retention routines through the existing
error-reporting helper. Static file reachability still over-approximates actual
execution. The [explicit method map](backend-audit-http-method-map-2026-10-04.md)
remains 162 routes/186 explicitly exported methods; generated HEAD/OPTIONS
behavior is separate.

There are 14 added routine signatures and two added tables relative to October 1,
with no removed routines or relations. Named argument signatures are compared
using the same PostgreSQL identity representation in both snapshots; comparing
named arguments with types-only `regprocedure` text would produce false deltas.
All 14 current production definitions and anon/authenticated/service execute
privileges match the owned clean replay read-only. Thirteen routines are
service-role executable and deny anon/authenticated execution. The new Auth
save-cleanup trigger is enabled and has no direct execute grant for these roles.

| Added routines or relations | Existing actual behavior and release evidence |
| --- | --- |
| `approve_workflow_checkpoint`, `retry_template_checkpoint`, `increment_workflow_share_import_count` | [7F approval](backend-section-07-atomic-approval-release-2026-10-03.md), [7A retry](backend-section-07-template-lifecycle-release-2026-10-03.md), [7I share counting](backend-section-07-share-import-release-2026-10-04.md); permanent real-database runner, retry and import suites |
| `remove_post_saves_before_auth_user_delete` | [8B save counters](backend-section-08-save-counters-release-2026-10-04.md); Auth deletion trigger and permanent database controls |
| `claim_mobile_push_retry`, `finish_mobile_push_retry`, `record_mobile_push_retry_outcome` | [9E retry claims](backend-section-09-push-claims-release-2026-10-05.md); actual PostgREST recovery and SQL claim controls |
| `record_initial_mobile_push_outcomes`, `finish_initial_mobile_push_outcomes` | [9F initial sends](backend-section-09-first-send-release-2026-10-05.md); actual worker interruption and SQL reservation controls |
| `scan_mobile_push_maintenance`, `mobile_push_maintenance_scans` | [9G bounded progress](backend-section-09-push-progress-release-2026-10-05.md); actual poison-batch controls and SQL scan assertions |
| `register_mobile_push_token` | [9H registration](backend-section-09-push-registration-release-2026-10-05.md); real Auth/PostgREST concurrency and SQL controls |
| `user_interest_refresh_state` | [9L interest progress](backend-section-09-feed-interest-release-2026-10-06.md); actual 1,000-user empty-result regression and SQL marker controls |
| `latest_generation_model_provider_checks` | [9N verification history](backend-section-09-model-verification-release-2026-10-06.md); actual worker/SQL sparse-history controls |
| `admin_job_run_summary`, `admin_creator_wallet_totals` | [11E collector limits](backend-section-11-admin-collectors-release-2026-10-07.md), [11G wallet totals](backend-section-11-admin-wallet-release-2026-10-07.md); actual API ceiling regressions and SQL aggregates |

These links identify already recorded tests and releases. The catalog refresh
does not claim that every earlier test was rerun or that every function behavior
has been covered.

The [current secondary caller review](backend-audit-caller-reconciliation-2026-10-07.json)
has 153 entries: 86 with catalog trigger/policy bindings, nine with located
source/operator callers, 34 with inspected SQL call statements and the same
24 retained entries without a current executable caller located. The additional
bound entry is the Auth save-cleanup trigger. Current SQL caller definitions
are unchanged except `refresh_user_interest_weights`; its four qualified
normalization calls were inspected again in SELECT/WHERE expressions. Missing
callers do not authorize removing functions or grants.

The wider scanner covers 1,327 production JS/TS files across source, mobile,
scripts and the edge function: 184 literal RPC sites and eleven dynamic sites.
Shell/manual SQL and installed-client history still need separate evidence.
The 121 trigger bindings and 162 policy-function dependencies are catalog
observations; dependencies can repeat across policy expressions. They are not
counts of behavioral passes. The 24 compatibility entries still deny anon and
authenticated execution; the Auth hook additionally permits Auth admin. The
prior operator controls remain bounded evidence, not proof of recent hosted use.

Raw definitions, scanner output, rejected signature comparison and replay parity
are private in `.audit-evidence/backend-map-current/`. No production row data,
raw definitions, function/grant removals or runtime changes are published.
Method, table, role/ownership, SQL-chain and installed-client behavior remain
MAP-02/DB-03/DB-05 work. The 53-obligation ledger is unchanged.
