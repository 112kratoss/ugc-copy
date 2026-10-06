# Section 11K — catalog operator boundaries

`clone_generation_model_catalog(text,text,text,text)` is a documented SQL
operator entrypoint among the 24 functions with no current application caller
located in the [caller reconciliation](backend-audit-caller-reconciliation-2026-10-04.md).
This batch exercises that function's role and transaction behavior without
changing runtime, migrations, grants, the live catalog or provider configuration.

All 22 actual pgTAP assertions pass on the owned clean replay database:

- Anonymous and authenticated calls fail with permission denial; the service
  role clones through its actual table permissions, with SECURITY INVOKER intact.
- The clone is an unactivated draft with the same schema version and platform
  defaults, recorded operator/change note, and every model/adapter/provider/price/
  validation/verification field copied. The active source and its entries remain
  unchanged.
- Missing source, short revision, blank operator and duplicate revision are
  rejected. Failed requests leave no partial release.

Every assertion executes against real Postgres; there is no SDK stand-in or
provider request. The test transaction rolls back and an independent query finds
zero `audit-clone-*` releases owned by `audit-operator`. A read-only production
query confirms the function definition digest, invoker setting, fixed search
path and role metadata match this tested local definition. That parity does not
claim a fresh production clone, publish, rollback or recent operator execution.

An additional 35 actual SQL assertions pass for mobile product provisioning,
activation and provisioning-gap reporting. They deny all three entrypoints to
anonymous/authenticated callers, exercise actual service-role calls, preserve
fixed credit packs, reject conflicting SKU/price/currency requests, and verify
idempotent deactivation/reactivation with only one active SKU per tier. Active
and unlisted marketplace fixtures contribute to gaps; a draft does not. No
purchase, intent, settlement or external store operation runs. The fixture
profile starts and remains at zero credits; sales/earnings stay zero. Independent
Auth/profile/asset/SKU/wallet fixture readback is empty. All three tested function
definitions and role metadata match a separate read-only production query.

Together, 57 SQL assertions pass across four documented operator routines. The
permanent mobile regression is
`supabase/tests/database/mobile_catalog_operator_boundaries.test.sql`.
This does not certify store product existence, legacy receipt binding or
installed-client purchase/restore; those compatibility/provider obligations
remain open.

The permanent clone regression is
`supabase/tests/database/catalog_clone_operator_boundaries.test.sql`; private
results and parity/cleanup evidence are under `.audit-evidence/backend-social/catalog-clone*`.
This adds bounded evidence to DB-03/MAP-02/GEN-05. Those obligations remain untested
for their broader matrices, and no new checklist row or full-audit closure is
claimed. Keep this evidence separate from #388's final tested runtime head.
