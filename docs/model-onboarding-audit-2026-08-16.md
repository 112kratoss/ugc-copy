# Model onboarding audit — making future Kie model updates seamless (2026-08-16)

Every claim below was verified against the code or lived through in the 2026-08-15 session that
added seven drop-in models. That session is the measured specimen this audit is built on.

## 1. Empirical baseline: what adding 7 models actually costs today

Seven models, all the *easy* case — existing kinds, existing pricing shapes, existing input
UIs, no new features:

- **13 files modified, ~600 lines**, plus 2 release manifests and 1 manifest test suite
- **A manifest generator written and then deleted** (`tmp-emit-dropin-manifests.ts`) because
  manifests must byte-match the code catalog build and no committed tool produces them
- **4 validator round-trips** to learn undocumented manifest rules (empty
  `passthroughSettingKeys` rejected while the code build emits exactly that; `rules` must be
  present even when empty; `acceptanceQuotes` only evaluable for `reference-adjustment`;
  descriptors need `schemaVersion` stamped)
- **~10 traps dodged from memory**, none of which are enforced by any gate (§3)
- Three throwaway evidence scripts (spec fetcher, enum extractor, price scraper) because
  pricing lives only on Cloudflare-gated marketing pages and docs paths lie about model ids

Per model, the same fact set (id, provider ids, price, limits, labels) was restated in up to
**seven representations**. `generation-services.ts` alone contains **59 `model === '…'`
comparisons**.

## 2. Root causes

### 2a. One fact, many homes

| Fact | Lives in |
| --- | --- |
| Identity/labels | `models.ts`, `client-generation-models.ts`, mobile `media-creation-view-model.ts` (fallback), catalog descriptor, manifest, `source-tools.ts` |
| Provider model ids | `IMAGE_PROVIDER_MODELS`/`VIDEO_PROVIDER_MODELS` (runtime.ts:96/139), `getKieImageModelId` (services.ts:1070, dead-but-tested), manifest `providerModelMap`, `VERIFIED_PROVIDER_IDS` test table |
| Pricing | `models.ts` tables, `getImageCost`/`getVideoCost` branches, `imagePricingExpression`/`videoPricingExpression`, manifest `pricingConfig`, `models.test.ts` cases |
| Input limits/slots | `getVideoInputLimits` + `videoInputModes` (catalog.ts:308/380), payload builder branches, client `catalogInputs` overlay |
| Request payload | bespoke if/else chains (services.ts:1531 images, :2189+ videos) |
| Misc registrations | enhancer `MODEL_ALIASES` (400s without it), `generation-timing` maps, family predicates |

Nothing verifies the mirrors agree. `client-model-boundary.test.ts` checks *imports only*;
real drift already exists (`getImageQualityModes` hardcoded client-side, differing
descriptions).

### 2b. Two pricing engines, one of which lies quietly

The declarative expressions are quote-authoritative. The imperative `getImageCost`/
`getVideoCost` run **on every generation start** as a cross-check
(`resolveQuotedGenerationCost`, services.ts:1533/2164). Parity between engines is tested only
at default settings (catalog.test.ts:142). `getVideoCost` has **no default branch** — an
unmatched id silently returns Veo pricing (models.ts:1002), which poisons the cross-check.

### 2c. Routing falls through to the wrong API

Worse than the pricing fallthrough: the video payload chain's final `else` **routes to
`https://api.kie.ai/api/v1/veo/generate`** (services.ts:2453-2454). A video model with no
explicit provider branch isn't just mis-priced — it's sent to a different provider API. This
is guarded by nothing.

### 2d. The declarative adapter exists but has zero adopters

`kie-task-v1` (generation-model-adapters.ts) is a complete, validated, DB-allowlisted
declarative adapter: slots/settings/variant-selector → createTask body. **No model uses it.**
All 36 ride `image-v1`/`video-v1` shims plus hand-coded payload branches, and the
workflow-runner has no `kie-task-v1` dispatch (workflow-runner.ts:657 hardwires the legacy
starts). The runbook itself promises the end state — "a model using schema-v2 controls and an
existing allowlisted server adapter can be launched with another reviewed manifest and no
mobile build" — the migration just never happened.

### 2e. The catalog is generated *from* code, not the source of truth

Production reads the DB catalog, but the DB catalog is emitted from the hand-maintained code
registries. So "the catalog is authoritative" is only true at runtime; at authoring time the
truth is 13 files. The emit step isn't even committed.

## 3. Trap register (all live today)

| # | Trap | Location | Guard today |
| --- | --- | --- | --- |
| 1 | Unknown video id → **Veo endpoint** | services.ts:2453 | none |
| 2 | Unknown video id → Veo pricing in cross-check | models.ts:1002 | none |
| 3 | `getVideoInputLimits` silent default `{images:3, startFrame:true, endFrame:true}` | catalog.ts:326 | none |
| 4 | `modelId.startsWith('seedance-2')` family matching — bit seedance-2-5 (wrong 15s cap) | catalog.ts:388/401 | helper added 08-15; pattern remains |
| 5 | Two same-sounding predicates, different membership: `isSeedance2VideoModelId` (assets, includes `-mini`) vs `isSeedance2VideoModel` (canvas, excludes it) | seedance-assets.ts:33, workflow-canvas.ts:103 | none |
| 6 | Model absent from enhancer registries → enhance endpoint **HTTP 400** | prompt-enhancement-service.ts:92 | none |
| 7 | Missing timing entry → no progress bar (silent UI loss) | generation-timing.ts | none |
| 8 | Descriptor text containing the word "pricing" trips the catalog leak-guard | catalog.test.ts | test (blunt) |
| 9 | Client/mobile mirror drift | client-generation-models.ts | none (import-boundary only) |
| 10 | Manifest validator quirks (empty `passthroughSettingKeys`, `acceptanceQuotes` strategy limit) | scripts/generation-model-catalog.ts | discovered by trial |
| 11 | Kie's own pricing table lags/contradicts its market pages (O3 absent; PixVerse absent + self-contradictory; flux-flex two rows) | kie.ai | evidence-file convention |
| 12 | Docs path ≠ model id (`qwen3-pro` → `qwen3/pro-*`, `v3-omni` → `kling-3.0-omni/*`) | docs.kie.ai | evidence-file convention + tests |

## 4. What already points the right way — finish, don't rebuild

- **DB catalog control plane** with immutable releases, shadow verify, atomic publish,
  rollback CLI. Production-proven.
- **`kie-task-v1`** — the declarative payload path, fully built and DB-allowlisted.
- **Mobile is already catalog-first**: picker = `getCatalogModels(catalog, tool)`; installed
  builds received all 7 new models with zero release.
- **Web is closer than assumed**: `useWebGenerationModelCatalog` →
  `applyGenerationModelCatalogToRegistries` (client.ts:418/431) **upserts catalog models into
  the web registries at runtime**, creating entries that don't exist (client.ts:196-243). The
  web deploy is currently needed for *payload builders, styling fields, and helper coverage* —
  not for list membership.
- **`webEnabled`/`mobileEnabled` per manifest entry** — the editorial exposure gate already
  exists where it belongs.
- **`minClientSchemaVersion`** — client gating machinery exists (capped at 1–2 by DB CHECK).

## 5. Target state

> **One model = one evidence file + one manifest entry + one publish. No app deploy on
> either platform for models that fit existing kinds.**

Adding a model becomes:
1. `scripts/kie-evidence` fetches spec + market price, writes `model_api_references/` entry
2. Author one manifest entry (the entry *is* the spec: descriptor + adapterConfig +
   providerModelMap + pricingConfig + validation)
3. `emit → validate → stage → verify → publish`
4. Mobile and web pick it up from the catalog; `webEnabled`/`mobileEnabled` control exposure

## 6. Phased roadmap

### Phase 1 — hardening (small, each item deletes a trap; do before the next model add)

1. **Commit the manifest emitter** as a CLI subcommand (`emit-entry --models a,b,c`) —
   resurrect the deleted `tmp-emit-dropin-manifests.ts` logic including the
   `passthroughSettingKeys` strip and descriptor `schemaVersion` stamping. Kills trap 10.
2. **Mirror-parity test**: iterate `models.ts` vs `client-generation-models.ts` shared fields
   and fail on drift (extend later to the mobile mirror). Kills trap 9.
3. **Close both fallthroughs**: make the video payload chain and `getVideoCost` throw on
   unknown ids (`assertNever` on `selectedModel.provider` / exhaustive switch), and make
   `getVideoInputLimits` a total `Record<VideoModelId, …>` so TS forces an entry. Kills
   traps 1–3.
4. **Registration-completeness test**: one test iterating all models asserting presence in
   enhancer allowlist, timing maps, `source-tools`, and (images) `VERIFIED_PROVIDER_IDS`.
   Turns "13 places to remember" into one failing test that lists what you forgot. Kills 6–7.
5. **Unify the seedance predicates** into one exported function; lint/grep-ban bare
   `startsWith('seedance-2')`. Kills traps 4–5.
6. **Commit the evidence tooling** (`scripts/kie-evidence.ts`: sitemap → market page →
   docs spec, browser-UA fetch, enum extraction) and document the convention in
   `model_api_references/README`. Shrinks trap 11–12 to a script run.

### Phase 2 — one payload path (the structural fix)

1. Add the **workflow-runner `kie-task-v1` dispatch** (branch on `adapterKey` after quoting,
   call `startCatalogGeneration`; add `templateContext`/`privateRecipe` params). This is the
   *same code* the deferred background-removal/avatar wave needs — one investment, two
   payoffs.
2. **Migrate models to `kie-task-v1` one at a time**, simplest first (`z-image`,
   `imagen-4*`, `qwen3`, `grok-imagine-image-2`), deleting each one's if/else branch as it
   moves. The 59-comparison chain shrinks with every migration.
3. **New models default to `kie-task-v1`** — payload defined in the manifest, zero
   `generation-services` code.

### Phase 3 — catalog-first exposure on web

1. Accept the runtime upsert as the official list mechanism: add per-kind styling defaults so
   catalog-only models render properly, keep `models.ts` as optional enrichment rather than a
   gate. A published model then appears on web *and* mobile with no deploy;
   `webEnabled: false` remains the hold-back switch.
2. Mobile bundled-registry fallback: degrade by kind (generic labels) instead of masquerading
   as `nano-banana-2` on old builds. Cosmetic, low priority.

### Phase 4 — optional inversion (decide after Phase 2)

Flip the generation direction: manifest entries become the authored source and the dev-mode
code catalog derives from them. Only worth designing once Phase 2 has shrunk what "code side"
means; may reduce to deleting the by-then-thin registries.

## 7. Process guardrails

- **Pricing drift check**: we resell Kie credits 1:1 at cost, so a silent Kie price change
  changes our economics with no signal. A scheduled job (or monthly runbook step) scraping the
  36 shipped models' market pages and diffing against `models.ts` closes that loop. The
  provider-verification cron can't do this — pricing is not in any API.
- **Evidence convention**: verbatim `model` enums, dated, with source URLs
  (`dropin-models-2026-08-15.md` is the template); `VERIFIED_PROVIDER_IDS` comments cite the
  evidence file.
- **Release hygiene**: chained `basedOnRevision`, one manifest test per release pinning
  "changes exactly N entries, others byte-identical" (wan-fix pattern).

## 8. Explicit non-goals

- **No new model kinds** without a schema-v3 migration + mobile release — the mobile parser is
  fail-closed and all-or-nothing; one unknown kind blanks the catalog for fresh installs.
- **No big-bang codegen framework** before Phase 2 — migrating payloads to the existing
  declarative adapter removes most of what codegen would have generated.

## 9. Rough effort

| Phase | Size | Payoff |
| --- | --- | --- |
| 1 | ~1–2 days | every silent trap gated; next model add loses the trial-and-error |
| 2 | dispatch ~1 day, then ~1 hr/model | payload code deleted; new models = manifest-only server-side |
| 3 | ~1 day | zero-deploy exposure on web; editorial control via manifest flags |
| 4 | decide later | single source of truth |

---

## 10. Implementation status (2026-08-16, same session)

### Phase 1 — DONE

- Manifest emitter committed: `scripts/emit-generation-model-catalog-entries.ts`
  (`npm run ops:generation-model-catalog:emit`), exporting `emitManifest` for
  scripted regeneration. Handles the `passthroughSettingKeys` strip and
  descriptor `schemaVersion` stamping the validator demands.
- Evidence tooling committed: `scripts/kie-evidence.mjs` (`slugs` / `price` /
  `spec`) + `model_api_references/README.md` documenting the conventions.
- Both fallthroughs closed **at compile time**: `getVideoCost` and the video
  payload ladder end in `satisfies never` + runtime throw; `getVideoInputLimits`
  is a total `Record<VideoModelId, …>` (veo-3.1's silently-defaulted values are
  now explicit).
- Seedance predicates unified: canvas delegates to `isSeedance2VideoModelId`
  (fixing the mini-exclusion divergence).
- `model-registry-parity.test.ts`: server/client mirrors pinned field-by-field.
  Found and fixed 6 live drifts (4 description strings, 2 missing
  `qualityModes`), plus the root cause: both `getImageQualityModes` copies are
  now data-driven — which also surfaced that **ideogram-character's Speed
  selector never rendered** (its modes weren't in the per-id list). Fixed.
- `model-registration-completeness.test.ts`: every model must be registered in
  the enhancer (**13 live models were 400-ing on enhance** — fixed with
  aliases), the timing maps (13 missing estimates — filled), and the
  first-party source-tools catalog (13 missing — filled).

### Phase 2 — DONE for everything currently expressible

- Dispatch seam inside `startImageGeneration`: when the loaded operational
  config says `kie-task-v1`, the request is delegated to
  `startCatalogGeneration` (which gained `templateContext`/`privateRecipe` and
  template-aware failure settlement). Because the seam sits inside the start
  service, the legacy routes AND the workflow-runner get it with no further
  changes.
- **12 image models migrated** to declarative adapter configs
  (`KIE_TASK_IMAGE_ADAPTER_CONFIGS` in generation-model-runtime.ts): imagen ×3,
  z-image, grok-imagine-image-2, nano-banana ×3, qwen3, qwen3-pro, flux-2-pro,
  gpt-image-2. `kie-task-image-adapter-parity.test.ts` pins each adapter body
  byte-equal to the legacy ladder's output — the deletability proof.
- Release `2026-08-16-kie-task-image-adapters.json` (validated) flips the nine
  already-shipped models in production; the two pending drop-in manifests were
  regenerated via the emitter (the three new kie-task models carry their
  adapter configs from day one).
- **Deliberately kept**: the legacy ladder branches. Production reads the DB
  catalog, so until the migration release is ACTIVE, prod configs still say
  `image-v1` and the ladder is the live path. Deleting branches now would break
  the deploy→publish window and pinned-revision replays. Delete after the
  release is active — the parity suite proves the deletion is safe.
- **Not migratable yet** (needs value-map transforms / per-variant field sets):
  grok-imagine-image, seedream ×2, wan-image ×2, ideogram ×2, and all video
  models. A completeness test asserts no video model adopts `kie-task-v1` until
  a video dispatch seam exists.

### Phase 3 — web DONE; mobile fallback deferred with reason

- `catalog-first-web-registry.test.ts` proves a catalog-only model upserts into
  the web pickers with renderable defaults and survives
  `getActiveRegistryModels`, while static styling wins when present. Combined
  with the seam above: a kie-task-v1 model published to the catalog now works
  end-to-end on web AND mobile with no deploy; `webEnabled`/`mobileEnabled`
  remain the editorial gates.
- Mobile bundled-registry fallback (masquerades unknown ids as nano-banana-2 /
  kling-3.0-video) is **deferred**: the fallback feeds capability/validation
  lookups (`durations`, `maxDuration`, `modeOptions`), not just labels;
  synthesizing generics risks old-build validation paths that cannot be tested
  from this repo, and mobile ships separately anyway. Revisit inside the next
  planned mobile release.

### Phase 4 — decision recorded: DO NOT invert yet

Spec-first inversion (manifest as the authored source, code registries derived)
is **deferred**. Rationale: after Phase 2, the per-model code surface is already
thin (registry entry + provider map + adapter config in one file each for
migrated models), and the emitter makes code → manifest mechanical and tested.
Inversion would buy little until (a) the remaining ladder models get value-map
transforms and (b) video models become expressible — at which point the
"code side" left to generate is small enough to delete rather than generate.
Revisit criteria: >80% of models on `kie-task-v1` AND a new model still
requiring more than two code touches.

### Follow-ups queued

1. After the adapter-migration release is active in production: delete the nine
   migrated ladder branches (parity suite is the safety proof).
2. Next mobile release: degrade bundled-registry fallback by kind.
3. Adapter v2 candidates when a model demands them: value-map transform,
   per-variant field sets.
