# Model onboarding

How to add a generation model to Magicbooklet, or a new tier of a model we already run, from
Kie's spec to production. This page is the order of work and the checklist. The release
mechanics are in [generation-model-catalog-operations.md](generation-model-catalog-operations.md),
and the rules for capturing provider evidence are in
[model-api-references/README.md](model-api-references/README.md). Agents load this page through
the `add-generation-model` skill (`.agents/skills/add-generation-model/SKILL.md`).

`src/__tests__/model-onboarding-runbook.test.ts` fails when a file, symbol, test or npm script
named here stops existing, so a change that moves one updates this page in the same PR.

## How it fits together

Production reads each model's controls, prices and Kie routing from the Supabase catalog, not
from code. A model therefore ships in two halves, always in this order:

1. **Code** that can price, validate and call the model. It deploys like any other change, and
   users see nothing yet.
2. **A catalog release** that switches the model on. Web and the installed mobile apps pick it up
   with no app release.

If the release is published before the code is live, the pickers list a model the server cannot
run. Deploying first leaves the new code unused until the release, and `rollback` undoes a
release in one command.

## 1. Check the provider

Capture evidence first. Never guess an id or a price.

```bash
node scripts/ops/kie-evidence.mjs spec <vendor>/<model>
```

`slugs` lists every market model, and `price <slug>` prints the credit lines from its market page.
Write what you find to `docs/model-api-references/<model>.md` with the capture date and source
URLs; [gpt-image-2-5.md](model-api-references/gpt-image-2-5.md) is the template. Then check:

- [ ] **Live and priced.** `kie.ai/<slug>` shows a credit price for every option we will offer.
  "Upcoming", "Coming soon", or an option with no price (Grok Imagine 1.5 at 1080p) means that
  option does not ship.
- [ ] **The model id.** Copy the `model` enum from the spec body. The docs path is not the id:
  `market/qwen3-pro/*` documents `qwen3/pro-*`.
- [ ] **Inputs from the schema.** Field names, enums, `maxItems`, resolution caps per aspect ratio,
  and `anyOf`/`allOf` rules about which fields must go together. The script prints `required`
  but not those rules. Marketing copy overstates: Seedance 2.5's page says 50 references and 4K,
  and its schema says 30 and 1080p.
- [ ] **Price.** App credits are Kie credits 1:1 (1 credit = $0.005), copied into `models.ts`
  unchanged. Read `pricingDesc`, never `pricingDescCn`. On a page with several models, each price
  block belongs to the model id that comes after it. When the page marks a price "limited-time"
  or "% off", pin the full price, because a release never reprices itself when an offer ends.
  Match how the model bills: per image, per second, with or without audio, or input plus output
  seconds. A setting that cannot be priced before the run (Wan 3.0's `duration: -1`) must be
  refused.
- [ ] **What the prompt enhancer needs.** Does the model always generate audio? Does Kie rewrite
  prompts on its side (`expand_prompt`, `prompt_extend`)? Both change the model's playbook.
- [ ] **Endpoint.** Market models use `jobs/createTask` and the shared status and callback path. A
  model on an endpoint of its own, as Veo is on `veo/generate`, also needs status-polling work in
  `src/lib/video-generation-status-service.ts`.
- [ ] **Probe.** Send `{"model":"<id>","input":{}}` to `jobs/createTask`. An unknown id comes back
  as `code: 422` with "not supported"; a known id fails on its missing fields and creates no task.
  A model whose spec has no required fields starts a real, paid task on this probe, so read the
  spec first. Then send the exact payload once, in the cheapest configuration. Kie reports a
  schema error as `code: 422` inside an HTTP 200, and a failed task's reason is in
  `data.failMsg`, not in `msg`.

The id probe reads the key from `.env.local` and prints only Kie's code, message and task id:

```bash
node --env-file=.env.local -e "fetch('https://api.kie.ai/api/v1/jobs/createTask',{method:'POST',headers:{Authorization:'Bearer '+process.env.KIE_AI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:process.argv[1],input:{}})}).then(r=>r.json()).then(j=>console.log(j.code,j.msg,j.data?.taskId??''))" '<model-id>'
```

## 2. Register it in code

The compiler and the tests below name anything left out. This is where each fact lives:

| What | File | Symbols |
| --- | --- | --- |
| Registry entry: name, options, credits | `src/lib/models.ts` | `IMAGE_MODELS`, `VIDEO_MODELS` |
| Video cost on the start path | `src/lib/models.ts` | `getVideoCost` |
| Browser copy of the entry, without credits | `src/lib/client-generation-models.ts` | `IMAGE_MODELS`, `VIDEO_MODELS` |
| Kie model ids | `src/lib/generation-model-runtime.ts` | `IMAGE_PROVIDER_MODELS`, `VIDEO_PROVIDER_MODELS` |
| Image ids on the hand-written path | `src/lib/generation-services.ts` | `getKieImageModelId` |
| Image request body, declarative | `src/lib/generation-model-runtime.ts` | `KIE_TASK_IMAGE_ADAPTER_CONFIGS` |
| Request body, hand-written | `src/lib/generation-services.ts` | `startImageGeneration`, `startVideoGeneration` |
| Video price in the catalog | `src/lib/generation-model-runtime.ts` | `videoPricingExpression` |
| Extra quote rules | `src/lib/generation-model-runtime.ts` | `validationConfigForModel` |
| Video input slots and caps | `src/lib/generation-model-catalog.ts` | `VIDEO_INPUT_LIMITS` |
| Progress bar estimate | `src/lib/generation-timing.ts` | `IMAGE_MODEL_BASE_ESTIMATE_MS`, `VIDEO_MODEL_BASE_ESTIMATE_MS` |
| Prompt enhancer | `src/lib/prompt-enhancer-playbooks.ts` | `ENHANCER_PLAYBOOKS`, `MODEL_ALIASES` |
| "Made with" attribution | `src/lib/source-tools.ts` | `APP_SOURCE_TOOL` |

Only when it applies:

| When | File | Symbols |
| --- | --- | --- |
| Image resolutions depend on the aspect ratio | `src/lib/models.ts`, `src/lib/client-generation-models.ts` | `getImageResolutionOptions` |
| The model joins the GPT Image 2.5 family | `src/lib/models.ts` | `isGptImage25ModelId` |
| The model joins the Seedance 2 family | `src/lib/seedance-assets.ts` | `isSeedance2VideoModelId` |
| Reference clips or audio have a length cap | `src/lib/generation-model-catalog.ts` | `referenceAssetCapSeconds` |

- **Image request body.** When the body is settings mapped to fields, reference images as one URL
  array, and a text or reference variant, give the model a `KIE_TASK_IMAGE_ADAPTER_CONFIGS` entry.
  It then runs on the declarative `kie-task-v1` adapter, which skips the branches in
  `startImageGeneration`, so it needs none. Pin its request body in
  `kie-task-image-adapter-parity.test.ts`. Any other body is a branch in `startImageGeneration`.
- **Video request body.** Video models stay on `video-v1` until a video dispatch seam exists, and
  `model-registration-completeness.test.ts` enforces that. Most branches in
  `startVideoGeneration` match on the entry's `provider`, so a new model in an existing family
  (Wan 3.0 under `wan`) compiles and silently reuses that family's body. Compare that body with
  the new schema field by field.
- **Two video prices.** `getVideoCost` prices a start that arrives without a catalog quote, and
  `videoPricingExpression` becomes the published price production charges. Keep them equal.
- **Enhancer.** Use an alias only when the model has the same request schema and prompt grammar
  as its target. `prompt-enhancer-playbook-contract.test.ts` pins the alias table, so add the
  pair there, with the evidence, too. Anything else gets its own playbook.
- **Settings the web page lacks.** The web create pages draw a fixed set of controls from the
  registry entry (aspect ratio, resolution, quality mode, duration, sound, mode); mobile draws
  whatever the catalog descriptor declares. A setting outside that set, such as GPT Image 2.5's
  `background`, needs web UI work or stays unsent.

Tests that name what is missing:

- `model-registration-completeness.test.ts`: the enhancer, the progress bar and the attribution
  entry; video stays on `video-v1`.
- `model-registry-parity.test.ts`: the server and browser copies agree field by field.
- `kie-image-model-id-mapping.test.ts`: every image model's Kie ids, against a table that cites
  the evidence file.
- `kie-task-image-adapter-parity.test.ts`: declarative image request bodies.
- `prompt-enhancer-playbook-contract.test.ts`: every model resolves to a model-specific playbook
  with a word budget, and the alias table matches exactly.
- `models.test.ts`: add the new model's prices and caps.
- `npm run typecheck`: a new video model does not compile until `getVideoCost`,
  `videoPricingExpression`, `VIDEO_INPUT_LIMITS` and `VIDEO_PROVIDER_MODELS` handle it.

## 3. Emit the catalog release

Never write or edit a release file by hand. The emitter builds the entries from the code, and a
manifest test pins them to it, so the code and the release cannot drift apart. The 2026-09-04
MiniMax release changed pricing in the JSON alone, and the next emitted release would have
quietly put production back on the old pricing.

```bash
npm run ops:generation-model-catalog:emit -- --models <ids> --adds <new-ids> --revision <name-YYYYMMDD> --based-on <active-revision> --change-note "<why>" --out config/generation-model-catalog/releases/<YYYY-MM-DD>-<name>.json
```

- `--models` lists the entries this release adds or changes, and `--adds` the new ones among them.
- `--based-on` is the revision production runs now; `/api/model-catalog/v1/current` reports it.
- `--acceptance-quotes <file>` records prices that `validate` recomputes, but only for
  `reference-adjustment` pricing. Pin every model's prices in the manifest test instead.

Add `src/__tests__/<release>-manifest.test.ts`, copied from `gpt-image-2-5-manifest.test.ts`. It
checks that the release chains onto the one production runs, adds exactly the new ids, equals the
code build entry by entry, quotes the prices in the evidence file, refuses what Kie cannot render,
and uses only control types that installed apps already read. Then:

```bash
npm run ops:generation-model-catalog -- validate --manifest config/generation-model-catalog/releases/<file>.json
```

## 4. Ship

1. **Code.** Open a PR, wait for Quality, squash-merge. `production-release.yml` deploys `main`;
   wait until `/api/app-version` reports the merge commit.
2. **Catalog.** The CLI takes its Supabase key from `.env.local`, so first check which block is
   active: that is the database you release to. Then run each command with
   `--manifest <file>`:
   - `diff`, and read the list of changed models.
   - `stage` (read-only), then `stage --apply --expected-active <active> --confirm-revision <new>`.
     The CLI measures every response's byte budget on the full release, and the database re-runs
     the policy checks in the same transaction that stores the `shadow` release.
   - Work through the runbook's
     [Shadow verification](generation-model-catalog-operations.md#shadow-verification) list.
   - `publish` (read-only), then `publish --apply --expected-active <active> --confirm-revision <new>`.
3. **Check it live.**
   - `/api/model-catalog/v1/current?platform=web`, then `platform=mobile`, report the new
     revision and counts. `/api/generation-models?refresh=1` refreshes the older endpoint.
   - Quote the model's main settings on web and compare the credits with the evidence file.
   - Run one real generation per mode (text only, and with references) on web and on a phone. The
     output imports into Storage, credits settle, the progress bar moves, and Enhance works. An
     import that fails with "Remote media host is not allowlisted" means the model serves media
     from a new host: add it to `MEDIA_IMPORT_HOST_ALLOWLIST` in Vercel.
   - `/models` and `/models/<id>` (dots become dashes) pick the model up from the catalog within
     an hour; both revalidate hourly.
4. **Roll back** if anything is wrong:
   `rollback --target-revision <previous> --expected-active <new> --apply --confirm-revision <previous>`.
   The code can stay deployed, because nothing reaches the model without the release.

## Mobile

A model needs no store build and no OTA update when installed apps can read its descriptor.
Mobile validates a creation against the catalog (`validateCatalogCreationDraft` in
`ugc-mobile/lib/generation-model-draft.ts`), and its parser in
`ugc-mobile/lib/generation-model-catalog.ts` drops any descriptor that uses a value it does not
know. A mobile release is needed only for:

- a new control type, input slot kind or role, or constraint type;
- a new model kind;
- a `minClientSchemaVersion` above what the shipped apps read.

New optional keys are fine.

## Changing a model we already run

A new price, cap or option follows the same path without the id work: change the code, emit a
release that lists only the changed model, pin it with a manifest test, deploy, then stage and
publish.

## Background

- `docs/audits/model-onboarding-audit-2026-08-16.md`: why the registration tests and the
  exhaustive video checks exist.
- `docs/audits/kie-new-models-2026-09-11.md`: the latest scan of Kie models we do not run yet.
- Worked examples: GPT Image 2.5 (#148, two image tiers on the declarative adapter) and commit
  `c4ab9b10` (seven models, video included).
