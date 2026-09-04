# Generation-model catalog operations

Supabase is the curated source of truth for the production generation-model
catalog. Browser and mobile clients read the public projection through
Magicbooklet APIs; they never read Kie or the private catalog tables directly.

The release workflow is deliberately non-interactive and revision guarded:

1. Validate a version-controlled manifest locally.
2. Diff its fully materialized release against the active Supabase release.
3. Stage it atomically as an immutable `shadow` release.
4. Exercise the shadow release through application preview, quote, and provider
   payload tests.
5. Publish it atomically with the expected active revision.
6. Roll back atomically if post-publication checks fail.

Provider capability checks remain advisory. They can inform a new manifest, but
they never edit or publish a release.

## Files

- Release manifests:
  `config/generation-model-catalog/releases/`
- Operations CLI:
  `scripts/generation-model-catalog.ts`
- Schema-v2 control plane:
  `supabase/migrations/20260724090000_generation_model_catalog_schema_v2.sql`
- Database contract test:
  `supabase/tests/database/generation_model_catalog_schema_v2.test.sql`

The initial v2 manifest is
`2026-07-24-seedance-2-hd.json`. It is pinned to production revision
`e271b74557d1e248`, asserts the complete 29-model inventory, upgrades every
legacy descriptor to v2, and replaces Seedance 2 with:

- 480p, 720p, 1080p, and 4K controls;
- 19/41/102/208 credits per output second without a reference video;
- 11.5/25/62/128 credits per input-plus-output second with reference video;
- a required reference-video duration plus a 15-second combined video limit;
- reference-audio count/per-file metadata remains advisory until clients can
  report audio duration reliably;
- the generic private `kie-task-v1` adapter mapping; and
- acceptance quotes of 714 credits for 7-second 1080p and 1,456 credits for
  7-second 4K generation.

The manifest keeps provider model IDs, mappings, validation rules, and pricing
outside `publicDescriptor`. API keys and arbitrary provider endpoints are
rejected.

## Prerequisites

Apply pending Supabase migrations before using any mutation command. Commands
that read Supabase require:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

`NEXT_PUBLIC_SUPABASE_URL` may be used instead of `SUPABASE_URL`. The service
role key must only exist in a trusted operator environment. Never put it in a
manifest, shell history, mobile build, browser bundle, issue, or command output.

Production application servers must use:

```text
GENERATION_MODEL_CATALOG_SOURCE=database
```

Do not publish until the backend’s schema-v1 projection and schema-v2 endpoint
both pass against the staged release.

## Validate

Validation is local, read-only, and does not require Supabase credentials:

```sh
npx tsx scripts/generation-model-catalog.ts validate \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json
```

Validation rejects, among other failures:

- an unexpected base revision or model inventory;
- invalid defaults or control defaults;
- incompatible descriptor schemas;
- unsupported adapters, pricing strategies, or validation rules;
- arbitrary adapter endpoints or embedded credentials;
- negative prices; and
- acceptance quotes that do not match the declarative pricing config.

Use `--json` for machine-readable, sanitized output.

## Diff

Diff reads the active release and materializes the complete target locally. It
never prints provider mappings, adapter payload mappings, or prices:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts diff \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json
```

The command fails if the active revision or model inventory differs from the
manifest guard. Update the manifest from a reviewed active snapshot instead of
overriding that guard.

## Stage

The first command is a read-only dry run:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts stage \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json
```

After reviewing the diff, stage the full release atomically:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts stage \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json \
  --apply \
  --expected-active e271b74557d1e248 \
  --confirm-revision seedance2-hd-v2-20260724
```

The database repeats the policy checks inside the same transaction and marks
the successful release `shadow`. No partial release survives a failure.

## Shadow verification

Before publishing, exercise the staged revision without deducting real user
credits:

1. Fetch both public schema projections and confirm v1 hides v2-only models.
2. Confirm Seedance 2 exposes 480p/720p/1080p/4K to schema-v1 and schema-v2
   compatible clients.
3. Quote 7-second 1080p and 4K requests and confirm 714 and 1,456 credits.
4. Quote a reference-video request with known duration and confirm billing uses
   the reference-video duration plus output duration.
5. Build the Kie request and confirm `bytedance/seedance-2`, `1080p`/`4k`, and
   slot URLs are mapped correctly.
6. Confirm invalid settings, missing duration metadata, stale revisions, and
   unavailable adapters fail closed before any credit deduction.

Do not call Kie from a client or expose the shadow release’s private columns in
preview responses.

## Publish

Preview publication with a read-only command:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts publish \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json
```

Publishing requires the manifest, `--apply`, the exact active revision, and the
exact target revision:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts publish \
  --manifest config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json \
  --apply \
  --expected-active e271b74557d1e248 \
  --confirm-revision seedance2-hd-v2-20260724
```

The RPC locks the target and active releases, validates the target again,
retires the previous release, and activates the target in one transaction.

After publication, force-refresh the API catalog cache and verify:

- `GET /api/generation-models?platform=mobile&schemaVersion=1`;
- `GET /api/generation-models?platform=mobile&schemaVersion=2`;
- ETag behavior;
- the 714/1,456-credit quotes; and
- a controlled provider payload build before enabling real generation traffic.

## Roll back

Preview the rollback target without mutating:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts rollback \
  --target-revision e271b74557d1e248
```

Rollback also requires exact revision confirmation:

```sh
npx tsx --env-file-if-exists=.env.local \
  scripts/generation-model-catalog.ts rollback \
  --target-revision e271b74557d1e248 \
  --expected-active seedance2-hd-v2-20260724 \
  --apply \
  --confirm-revision e271b74557d1e248
```

The RPC switches the active release atomically. Keep the failed release and its
provider-check history for audit; do not edit a staged, active, or retired
release in place.

## Adding later models

A model using schema-v2 controls and an existing allowlisted server adapter can
be launched with another reviewed manifest and no mobile build. A new provider
protocol still requires a backend adapter deployment. It must never be modeled
as an arbitrary URL or executable payload template in the database.

To make the CLI available as an npm command, add this package script:

```json
{
  "ops:generation-model-catalog": "tsx --env-file-if-exists=.env.local scripts/generation-model-catalog.ts"
}
```

## Every release is emitted, then pinned

Manifests come from `npm run ops:generation-model-catalog:emit` (see the header of
`scripts/emit-generation-model-catalog-entries.ts`), never from editing JSON by hand, and
each committed release gets a test under `src/__tests__/*-manifest.test.ts` asserting its
entries equal the code build (`buildGenerationModelCatalog` and
`buildCodeGenerationModelOperations`). The 2026-09-04 MiniMax release showed why: its
pricing strategy was changed in the manifest alone, so the code build still emitted the
previous shape and the next emitted release would have carried production back to it. A
pinned test fails the moment a manifest and the code disagree, whichever side moved.
