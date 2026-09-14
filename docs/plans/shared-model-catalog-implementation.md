# Shared model catalog implementation — 2026-09-14

The transport separates discovery from configuration: clients load a small current
revision, progressively page summaries, and load descriptors for selected or restored
models. Supabase publication remains the availability and pricing authority. Existing
catalog endpoints and descriptor schemas 1–3 remain available.

The accepted refresh policy is creation-screen entry or opening the model picker.
There is no periodic poll or five-minute freshness promise. The cached revision works
offline; reopening selection or Retry reconciles it when connected.

## Implemented

- Versioned current, summary, individual-detail and eight-model batch routes;
  bounded SQL projections, ordering indexes, published/retired release checks,
  revision-bound cursors, conditional ETags and bounded origin caches.
- Shared client session protocol with partial inventory state, selected/default
  prefetch, two concurrent detail batches, race handling, validated persistence,
  and a 100-descriptor/two-revision cache cap.
- Web and mobile pickers, descriptor controls, direct restored-model loading,
  missing-model notices and quote/start gating. Prompts and references survive
  refresh and model removal. Motion options use published descriptors.
- Workflow remote model IDs, referenced-descriptor batching, persisted catalog
  settings and execution through the existing generic adapter/credit pipeline.
- Per-platform reads (`platform=web|mobile` on every endpoint, bound into
  cursors) with UTF-8 payload checks measured for each platform's availability
  and defaults, so web-only or mobile-only releases stay publishable. Legacy
  aggregate size is reported without disabling models to satisfy the old ceiling.
- Mobile CORS/operation contract, shared future-model fixture, endpoint performance
  targets, backend read/cache logs and the updated catalog operations runbook.

## Verification evidence

- Production web build and FFmpeg/libvips runtime artifact checks pass.
- App, script and test TypeScript checks pass. ESLint has no errors and one
  pre-existing unused-variable warning in generation-media-preview.test.ts.
- Four browser checks pass at desktop/mobile widths and on remote video/motion
  models; the image check preserves an edited deep-link prompt during refresh.
- iOS and Android production JavaScript exports with source maps pass, using
  isolated Metro caches and non-production placeholder configuration.
- Expo dependency alignment and all 20 Expo Doctor checks pass.
- Clean local migration replay and all 64 database files / 1,196 assertions pass,
  including the published-only, platform-scoped reads, the current-revision
  projection and no-active-release case, and the 500-model SQL pagination fixture.
- Web full run: 787 files / 5,671 tests pass, including the canvas and editor
  guards for catalog-only model ids, the runner's bundled-model routing, and
  the platform-scoped transport, read-service and cursor tests.
- Mobile full suite: 207 files, 2,027 tests pass, including malformed-id
  isolation and the coalesced cache write. This includes native compilation
  of the sheet backdrop, added after an iOS runtime crash exposed a JSX alias bug.
- Shared transport tests cover synthetic 100/500-model payloads and pagination,
  cursor category/revision binding, missing models, shadow rejection, ETags,
  concurrent/overlapping batches, corrupt/offline storage, rollback and eviction.
- Earlier iOS simulator checks exercised restored media, picker search, selected
  descriptor loading and settings on the shipped runtime. iOS fingerprint matches
  build 52. Android requires the existing guarded publisher's declared setAside
  procedure for build 71; fingerprints and native configuration were not changed.

## Release record — 2026-09-14/15

- PR #163 merged as `c162beb` after Repository Quality passed on `200bcf9`. The
  first two Quality runs failed in the web job: Vite resolves the nearest
  tsconfig for every file it transforms, and the shared modules under
  `ugc-mobile/lib` reached `ugc-mobile/tsconfig.json`, whose `extends` only
  resolves with the mobile dependencies installed. They now live in
  `ugc-mobile/lib/model-catalog/` with a self-contained `tsconfig.json`.
- The first production release (`c162beb`) applied the migration and deployed
  the edge function, then failed in the staged Vercel build: `.vercelignore`
  excluded the whole mobile workspace, so the same two files never reached the
  builder. `ebef768` re-includes only that folder (pinned by
  `vercelignore-shared-catalog-modules.test.ts`); its release promoted at
  ~17:55 UTC on 2026-09-14 and passed the post-promotion health check.
- Verified on production for `platform=web` and `platform=mobile`: current
  revision `gpt-image-2-5-20260911` with counts 18/15/2, conditional 304,
  immutable page and detail responses, 400/404 error paths, and the legacy
  `/api/generation-models` still serving 56,385 bytes.
- Production Performance run 34882051241: the four catalog targets passed with
  0% errors and P95 TTFB of 40–83 ms against 800 ms budgets. The workflow itself
  is red for reasons that predate this work (the signed-in showcase feed's TTFB
  and the Lighthouse mobile budget, failing on every scheduled run since
  2026-08-24).
- OTA published through `publish-ota.mjs` at `ebef768` for both platforms at a
  10% rollout on 2026-09-15 (iOS group `1e9d0703…` on build 52, Android group
  `71db8612…` on build 71 with the expo-video patch set aside), then raised to
  100% the same day at the owner's call, ahead of the 24-hour telemetry window.
  Installed-device checks were not repeated for `ebef768`; the first telemetry
  read showed no launches on the new groups yet.

Open follow-ups: a device check of the creation screen on both platforms now
that the update is at 100%. The performance-workflow failures noted above were
fixed on 2026-09-15 by #164 (the public stylesheet is inlined again) and #165
(the proxy verifies bearer tokens locally); run 34900530965 passed the load
and Lighthouse mobile budgets.
