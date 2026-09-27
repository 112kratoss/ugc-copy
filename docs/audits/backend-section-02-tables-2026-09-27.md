# Backend Section 2 — table and view ownership

Status: workflow ownership batch deployed in PR #216 and verified (24 live checks).
Save/audit/marketplace batch deployed in PR #218 and verified (29 live checks); evidence is in backend-section-02-social-marketplace-release-2026-09-27.md.
Notification table batch deployed in PR #219 and verified (36 live checks); evidence is in backend-section-02-notifications-release-2026-09-27.md.
Projection compatibility batch deployed in PR #221 and verified (61 live checks); evidence is in backend-section-02-projections-release-2026-09-27.md.
Financial ownership batch validated: 48 production SQL assertions and 74 live HTTP checks passed; see backend-section-02-financial-2026-09-27.md. No runtime/schema fix was needed.
Scope: public table/view Data API privileges and row ownership. RPCs, Storage,
Realtime, and the rest of the backend remain separate review batches.

## Coverage ledger

The production catalog contains **130 public base tables and two views**.
All 130 base tables have RLS enabled. **25 relations** currently have client-readable
table or column grants (26 at baseline, before PR #218 restricted marketplace
content); counting table grants alone misses generations and
templates. The timestamped JSON inventory records all 132 relations, the client
column projection, and the policies inspected for this batch.

| Surface | Evidence and current status |
| --- | --- |
| All public tables/views | Catalog inventory complete; behavioral certification remains in progress |
| Workflow history, runs, assistant proposals/messages | Self-owned children could reference foreign canvases; fixed and verified in production (PR #216) |
| Workflow run steps | Could reference another user's generation; fixed and verified in production (PR #216) |
| Message-to-proposal association | Could reference another user's proposal or another canvas; fixed and verified in production (PR #216) |
| Private views | admin_user_account_state and playback_metrics_daily have no client grants; latter is security-invoker |
| Profiles and generations | Existing row/column tests retained; full database regression suite passes |
| Transactions, creator wallets, wallet entries, payouts | Financial batch passed 48 populated-row SQL assertions and 74 live HTTP checks; no defect found in this scoped boundary; financial workflows remain separate |
| Save tables and deletion audit | Direct-write bypass fixed and verified in production (PR #218) |
| Marketplace content | Production draft-create HTTP 500 fixed; own edits work and foreign edits/direct content access rejected (PR #218) |
| Notifications, push tokens, preferences | Guest-boundary fix deployed in PR #219; 40 database assertions and 36 live checks passed; fixtures removed |
| Public follows, source tools/models, template projections | PR #221 deployed; 52 local assertions and 61 post-release live checks passed across this group and private generation data; cleanup confirmed |
| Generation-input media and AI usage | Owner, parent ownership, guest, ban/revocation and direct-write behavior verified in projection batch; Storage and RPC access remain separate |
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
The migration explicitly restates the four existing production workflow CRUD
grants, which newer Supabase clean databases no longer inherit. Service-role
privileges, stored records, and API signatures do not change.
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
- CI initially exposed missing ambient workflow grants on its newer Supabase
  image. Revoking those same four local grants reproduced the exact failure;
  explicit grants and the matching active-identity policies now preserve the
  deployed contract on fresh databases. Removing the four identity policies
  also reproduced CI’s three revoked-session failures before they were fixed.
- Production verifier: `scripts/ops/verify-workflow-parent-ownership.mjs`.
  Requires `--confirm --project-ref ildfmhozpibwiopeavfg` and environment
  credentials. It creates two disposable identities with empty workflows and
  inert media rows, performs real authenticated Data API calls, revokes one
  fixture's session, and removes only its own fixtures. No provider work or
  purchases are initiated. All 24 live checks passed after PR #216 deployed; fixtures removed (see workflow release evidence).

The Supabase security advisory baseline has no ERROR findings. Its warnings
include guest-access policies (the product intentionally supports guests) and
six callable authenticated definer functions, which remain in the RPC audit.
RLS-without-policy INFO entries require interpretation with grants and trusted
server access, not blanket permissive policies.

References:
[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[explicit Data API privileges](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).
