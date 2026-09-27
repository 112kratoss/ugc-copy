# Section 2 — public projections and private generation data

Status: production behavior verified; clean-replay compatibility fix pending release.

## Scope and result

This batch covers direct Data API access to `follows`, `source_tools`,
`source_tool_models`, `templates`, `generations`, `generation_input_media` and
`ai_usage_events`. Internal template versions/runs/steps and generation job
records also have assertions denying all client-readable columns.

No new production access-control bypass was reproduced. On production commit
`711d2a2fcfa5a0fd5535495912401f216c1adcc7`, **61 live checks passed** at
2026-09-27 04:34:54 UTC. Two registered identities and one actual anonymous
identity used inert private generations, input metadata, usage events, draft
templates and inactive catalog entries. None were published; no files,
provider work, purchases, delivery jobs or actual social actions were created.
All three accounts and dependent fixtures were removed. Independent SQL
returned zero remaining fixture users, generations, input media, usage events,
templates, source tools and source models.

| Surface | Verified boundary |
| --- | --- |
| Follows | Intentionally public relationship projection; direct insertion denied. Public fixture visibility tested locally, production read scoped to a disposable identity with no follows. |
| Source tools/models | Public active entries; inactive fixtures hidden from anonymous, registered and guest clients. Direct inserts rejected and updates/deletes affect no rows. |
| Templates | Active, enabled, attributed entries publicly readable; own drafts only for authenticated identities. Local fixtures additionally check disabled, inactive and orphaned rows. Full-row and private authoring-field reads denied. |
| Generations | Only eight resume-metadata columns are directly readable, only for the owner. Prompt, media output and actual provider cost excluded. Local tests include a foreign public generation. |
| Input media | Both child and parent ownership required: a deliberately mismatched fixture is hidden. Storage-object access is a separate audit. |
| AI usage | Only owner rows readable. Insert rejected; updates/deletes affect no rows. Cost here is the user's credit charge, not permission to alter settlement. |
| Lifecycle | Active guests retain their own generation-related records; banned and revoked identities lose access. |

Public reads do not imply an entitlement to private graph snapshots or media.
Template execution, API hydration, media URL signing, paid resources, RPCs and
Storage are separate review surfaces. Catalog provider labels are source-tool
attribution, not private generation-provider credentials or routing secrets.

## Clean-replay finding

The three older `ai_usage_events`, `source_tools` and `source_tool_models`
tables inherited authenticated CRUD permissions from historical Supabase
platform defaults. Their only permissive policies allow SELECT, so direct
mutations remain denied by RLS. The historical active-identity installer
selected tables by existing ACLs, so new databases could miss those policies
as well as authenticated reads. CI exposed the same missing SELECT grant
and identity policy on `generation_input_media`; revoking that local grant
reproduced the exact CI error. Its contract is SELECT-only, unlike the three
older tables.

Removing those ambient ACLs/policies on the isolated database reproduced
`permission denied for table ai_usage_events` in the behavioral matrix. The
new migration states the exact production ACLs and restrictive identity
policies. Re-running the same no-ambient setup plus the migration passed all
52 assertions. This preserves current production behavior, adds no permissive
mutation policy and rewrites no data. Lock acquisition is bounded to five
seconds. It is a rebuild-compatibility repair, not a claim of a new production
cross-account vulnerability.

## Regression evidence

- New matrix: **52 database assertions** covering exact column allowlists,
  owner/foreign/guest/public identities, real-row mutation attempts, inactive
  catalogs, draft/disabled/orphaned templates, parent ownership, bans and
  revocation.
- Clean replay: 254 migrations; full database suite 77 files / 1,521 assertions.
- Live verifier: `scripts/ops/verify-projection-table-boundaries.mjs` (61 checks).
- Production mutation attempts target only disposable fixtures. All potentially
  inserted catalog IDs are retained for cleanup even if a deny assertion fails.

The remaining Section 2 ledger is `backend-section-02-tables-2026-09-27.md`.
