# Backend Section 2 — table and view ownership

Status: first fix batch validated locally; production release pending.
Scope: public table/view Data API privileges and row ownership. RPCs, Storage,
Realtime, and the rest of the backend remain separate review batches.

## Coverage ledger

The production catalog contains **130 public base tables and two views**.
All 130 base tables have RLS enabled. **26 relations** have client-readable
table or column grants; counting table grants alone misses generations and
templates. The timestamped JSON inventory records all 132 relations, the client
column projection, and the policies inspected for this batch.

| Surface | Evidence and current status |
| --- | --- |
| All public tables/views | Catalog inventory complete; behavioral certification remains in progress |
| Workflow history, runs, assistant proposals/messages | Self-owned children could reference foreign canvases; reproduced and fixed locally |
| Workflow run steps | Could reference another user's generation; reproduced and fixed locally |
| Message-to-proposal association | Could reference another user's proposal or another canvas; reproduced and fixed locally |
| Private views | admin_user_account_state and playback_metrics_daily have no client grants; latter is security-invoker |
| Profiles, generations, transactions | Existing row/column tests retained; full database regression suite passes |
| Save tables and deletion audit | Direct writes need separate reproduction against intended service-only paths |
| Marketplace content | Policy dependencies reference parent tables without client grants; investigate real API compatibility before changing anything |
| Notifications, push tokens, preferences | Owner policies inventoried; dedicated cross-account behavioral matrix still pending |
| Public follows, source tools/models, template projections | Grants inventoried; public-versus-private data contract review still pending |
| Service-only tables | Client grants absent in inventory; RPC/trigger access and business invariants are not certified by that fact |

## First fix batch: workflow parent ownership

Before this change, the child policies compared user_id to auth.uid() but did
not compare the referenced canvas's owner. An authenticated user who knew
another canvas UUID could insert a row with their own user_id and the foreign
canvas_id, or reparent an existing own row. Message proposal and run-step
generation references had similar gaps.

The existing application services often add their own user_id filters,
including the generation hydration path. This finding demonstrates a direct
database ownership/integrity gap; it does **not** establish a successful
cross-account content disclosure through those guarded API paths.

Six restrictive policies validate the parent canvas on four child tables,
the optional proposal's owner and canvas, and the optional generation's owner.
They compose with the existing CRUD policies and active-identity restriction.
No grants, service-role privileges, stored records, or API signatures change.
Lookups use the referenced primary keys. The migration sets a five-second lock
timeout so acquisition fails rather than waiting indefinitely.

Production's read-only mismatch check returned zero rows in all six relationship
categories before the fix. No existing customer rows need repair.

## Validation

- Reproduction on the pre-fix database: **16 failures / 31 assertions**.
- Fixed focused suite, expanded with live-session revocation and service-role
  compatibility: **40/40 passed**.
- Clean replay: **251 migrations** completed on the isolated database.
- Full database suite after replay: **74 files, 1,396 assertions passed**.
- Migration contract: **3/3 Vitest checks passed**.
- Focused ESLint, syntax check, and whitespace checks passed.
- Production verifier: `scripts/ops/verify-workflow-parent-ownership.mjs`.
  Requires `--confirm --project-ref ildfmhozpibwiopeavfg` and environment
  credentials. It creates two disposable identities with empty workflows and
  inert media rows, performs real authenticated Data API calls, revokes one
  fixture's session, and removes only its own fixtures. No provider work or
  purchases are initiated. Pending release before execution.

The Supabase security advisory baseline has no ERROR findings. Its warnings
include guest-access policies (the product intentionally supports guests) and
six callable authenticated definer functions, which remain in the RPC audit.
RLS-without-policy INFO entries require interpretation with grants and trusted
server access, not blanket permissive policies.

References:
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[explicit Data API privileges](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
