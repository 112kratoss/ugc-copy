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
- Materialized release parity and UTF-8 payload checks. Legacy aggregate size is
  reported without disabling models to satisfy the old ceiling.
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
- Clean local migration replay and all 64 database files / 1,182 assertions pass,
  including the new published-only reads and 500-model SQL pagination fixture.
- Web full run: 787 files / 5,668 tests, with one obsolete persistence source
  assertion failing. That assertion was updated to match preserved references;
  its focused file rerun passes (2 tests). All other 5,667 tests passed.
- Mobile full suite: 207 files, 2,025 tests pass. This includes native compilation
  of the sheet backdrop, added after an iOS runtime crash exposed a JSX alias bug.
- Shared transport tests cover synthetic 100/500-model payloads and pagination,
  cursor category/revision binding, missing models, shadow rejection, ETags,
  concurrent/overlapping batches, corrupt/offline storage, rollback and eviction.
- Earlier iOS simulator checks exercised restored media, picker search, selected
  descriptor loading and settings on the shipped runtime. iOS fingerprint matches
  build 52. Android requires the existing guarded publisher's declared setAside
  procedure for build 71; fingerprints and native configuration were not changed.

## Release gates still required

Repository Quality must pass for the exact release commits. Run the protected
production workflow, verify the new APIs against the published Supabase revision,
and measure production latency/transfer size. Finish installed Android UI checks
(the computer-control surface cannot operate the emulator; ADB authorization is
pending) and broader iOS video/motion/workflow checks before publishing mobile.

Publish through the guarded OTA script only after both shipped runtime preflights
pass. Start at 10%, then wait at least 24 hours of healthy telemetry and successful
device checks before 100%. No production migration, deployment, catalog publish,
or OTA has been performed as part of this implementation yet.
