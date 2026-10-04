# Backend caller reconciliation — October 4

This review refines MAP-02 and DB-03 without closing either. The
[reviewed inventory](backend-audit-caller-reconciliation-2026-10-04.json) reconciles
the 152 functions with no identified JavaScript caller in the October 1 surface
map. Its local catalog snapshot contains 326 signatures at candidate 9e340125,
including the subsequently released 7I increment function. It is not a production
catalog snapshot or an inventory of every behavior on current main.

The exclusive categories are 85 functions with catalog trigger/policy bindings,
nine with located source/operator callers, 34 with manually inspected SQL call
statements, and 24 without a current caller located. SQL signatures in the latter
34 were checked for overload ambiguity; no target had multiple local signatures.
Other candidate SQL references on already-bound rows are explicitly unreviewed.
The snapshot's policy dependency list can repeat a function for different policy
expressions; its 162 entries are not 162 distinct policies.

Two lexical false positives were comments in `merge_guest_account` mentioning
`canonical_account_id()` and `linked_account_ids()`. Neither is a SQL call there.
The latter does have an explicit SQL caller in the shell acceptance script
`scripts/ops/guest-checkout-acceptance.sh:101`, outside the JavaScript scanner.
The original scan covered 1,319 JS/TS files, 179 literal RPC sites and ten dynamic
sites, so it cannot by itself rule out shell, SQL, hosted or installed-client use.

Additional reviewed source paths include `posts-server.ts:630`, which uses
`rpc.call` with the public bundle summary constant, and the dynamically expanded
workflow/identity calls in `verify-client-rpc-boundaries.mjs`. Name mentions of
`increment_post_remix_count` and `list_media_rendition_repair_candidates` in source
are compatibility error handling, not invocation sites.

## The 24 entries needing entrypoint or compatibility evidence

| Functions | Current evidence and next check |
| --- | --- |
| `provision_mobile_store_product`, `set_mobile_store_product_active`, `bind_legacy_mobile_store_transaction_product`, `list_mobile_store_product_provisioning_gaps` | Explicit manual SQL in `docs/mobile-store-product-catalog.md`; provisioning also appears in operator SQL fixtures. Documented operation is not proof of recent execution. |
| `clone_generation_model_catalog` | Explicit operation in the production deployment runbook. Verify current operator use and role/transaction behavior. |
| `hook_block_password_signups_until_smtp` | Auth hook documented in the deployment runbook; local `supabase_auth_admin` execute grant. Hosted hook configuration and actual provider flow remain AUTH-04/06 evidence. |
| `consume_upload_byte_reservation`, `release_upload_byte_reservation`, `reserve_upload_bytes` | Legacy compatibility routines retained beside the current capability flow. The benchmark calls `reserve_upload_bytes_v2`, not the legacy name. Installed-client and old-server use remains a DB-05 decision. |
| `reconcile_mobile_credit_refund`, `refund_ai_usage_event` | Existing wrappers delegate to the newer settlement routines; no current production source caller located. Preserve compatibility pending evidence. |
| `complete_mobile_marketplace_purchase`, `complete_mobile_post_resource_purchase`, `reserve_creation_credits`, `refund_creation_credit_reservation` | Retained commerce/reservation functions; no current entrypoint located. Map compatibility, grants and transaction behavior before any retirement. |
| `increment_post_remix_count` | Current definition is intentionally a no-op; its source mention is a compatibility check. |
| `increment_remix_count`, `list_media_rendition_repair_candidates`, `list_referenced_post_resource_storage_paths`, `match_post_content_embeddings`, `set_feed_creator_feedback`, `set_feed_post_feedback`, `canonical_account_id` | Retained function bodies; no current source, catalog binding or inspected SQL caller located. Historical migrations/plans are not execution evidence. |
| `retire_sold_post_resource_bundle_instead_of_delete` | Trigger binding removed by `20260806120000_freeze_sold_post_resource_bundles.sql`; function remains. No local anon/authenticated/service execute grant. No deletion is inferred. |

Read-only local privilege inspection found no anon or authenticated execute grant
on these 24 entries. All except the detached trigger function are service-role
executable; the Auth hook is also executable by `supabase_auth_admin`. These are
catalog observations, not substitutes for role/ownership tests, hosted settings,
table constraints, or caller validation. No function or grant was removed.

Remaining MAP-02 work includes method-level behavior outside workflows, table
read/write paths, SQL callers of other functions, edge/operator entrypoints and
installed mobile access. DB-03 still needs positive/negative behavioral fixtures
for uncovered policies, triggers and transactions. Raw definitions and the
reproducible private mapping scripts are preserved under `.audit-evidence/backend-map-02/`.
