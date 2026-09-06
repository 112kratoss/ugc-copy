# Media delivery audit — second pass, 6 September 2026

Scope and remaining surface coverage: [whole-app plan](media-delivery-plan.md).
Earlier integrity repairs: [first pass](media-delivery-audit-2026-09-05.md).
Reviewed baseline: `85c137ea49267584932d3fcdcdd700113626f142`.

## Release state

The earlier reliability checkpoint is live. Production release
[33991876534](https://github.com/112kratoss/ugc-copy/actions/runs/33991876534)
completed successfully for `85c137e`, including both preview/teaser migrations.
The live `/api/app-version` was rechecked and reports that exact SHA.
Earlier production OTA publication covered Android builds 70/71 and iOS 47/51.

The additional mobile changes described below are local to
`fix/private-video-delivery`. No new migration, production data repair, deployment
or OTA publication was performed in this second pass. The private-generation
rendition producer remains unimplemented.

## Verified production video integrity

Read-only inspection and complete FFmpeg video/audio decoding covered 27 stored
objects, totaling 279,075,816 bytes:

| Objects | Count | Full decode | 1 KiB range response |
| --- | ---: | ---: | ---: |
| Succeeded generation originals in `generated_videos` | 14 | 14 passed | 14 passed |
| Published post originals | 6 | 6 passed | 6 passed |
| Published playback renditions | 6 | 6 passed | 6 passed |
| Published teaser | 1 | 1 passed | 1 passed |

Each range check returned 206 with exactly 1,024 bytes and the expected
Content-Range. All six renditions and the teaser have MP4 metadata before the
media payload (fast-start layout). Three original objects have metadata after
the payload: generations `d32fb47c-56cc-43f1-a1e3-90a4ef74f812` and
`09fdc615-eb59-4ab5-a69f-934c6a32b829`, and post media
`9726f0e9-fa8a-48fd-9a75-07c9929d286e`. This can require an extra tail request
before playback; it is not a measured startup delay or a decode failure.

The initial probe admitted only `posts/<post-id>/` published objects. Four older
posts use `showcase/<generation-id>/`; their eight objects were checked in a
second bounded probe after validating each prefix against the post's actual
generation link. None remained excluded. Owner prefixes were validated for
private originals. Probes used a 64 MiB per-object cap, 512 MiB per-run total,
download/decode timeouts, and temporary files removed after decoding. Reports
contain IDs and measurements, not signed URLs, credentials or media contents.

This accounts for the stored objects selected above. It does not include expired
provider-only URLs, template demo assets, audio-only files, reference uploads,
or every mobile codec/device combination. The three unavailable legacy records
from the first pass remain open.

## Reproduced mobile cache collision

The image branch of the full-screen viewer passed the descriptor's preview
cache key while requesting `mediaItem.url`, the original. A previously cached
thumbnail can therefore satisfy the original request, or an original can be
written into the thumbnail entry.

An Android API 36 emulator reproduced the native cache behavior using Expo
Image and two synthetic HTTP fixtures: a 16 × 16 thumbnail and an 80 × 80
original. Loading both under the same cache key returned 16 × 16 for the
original. A clean run with separate keys returned 16 × 16 and 80 × 80 as
expected. Changing only the key after an already-poisoned URL was loaded did
not clear its native memory entry; fresh fixture URLs were used for the
independent control. This is why old cache contents are not evidence of a
successful new fetch.

`getShowcaseSourceImageCacheKey` now selects the existing `:source` namespace
when the original differs from its preview, consistent with the feed's original
fallback. The image viewer uses this helper; poster keys remain preview keys.
The actual helper from this checkout was compiled and evaluated with native
Expo Image: thumbnail 16 × 16, original 80 × 80, distinct keys. Regression tests
cover descriptor precedence, original-equals-preview, and missing cache keys.

This shared viewer is used by feed, saved, creator-profile, owner-post and
creation sources. The native check verifies cache selection and decoded sizes;
it is not a complete UI/navigation run on all callers, an iOS verification, or
proof that this caused the user's intermittent black media.

## Reproduced creation descriptor loss

The generation-to-viewer adapter reconstructed media slides using legacy URLs,
discarding rendition URLs, preview cache keys, ThumbHash, dimensions and expiry
metadata. A failing regression supplied a descriptor for a video in the second
slot of a multi-output creation: the playback resolver selected its original.

The adapter now attaches the descriptor only to the matching output and kind.
Playback selects the rendition when supplied, and the original URL remains
available to download/remix actions. Other outputs receive no foreign poster or
rendition. The API client also normalizes relative rendition/teaser/feed URLs,
preserving omitted fields from older servers and explicit null feed decisions.
The API normalization defect reproduced independently before the fix.

The full suite caught added null properties in the older shared API fixture;
normalization was corrected to preserve optional-field absence. No server API
contract or storage permission changed.

## Remaining delivery work

| Path | Finding and evidence | Next verification |
| --- | --- | --- |
| Private generation encoding and owner API | Measured 14 originals / 187 MB. Private producer, owner signing and deletion cleanup implemented and locally verified below. | Release migration/code through Quality and the release workflow; measure native playback and backlog drainage. |
| Web profile/Creations viewers | Generation previews and detail modals now use the descriptor rendition, retaining original downloads. | Browser fixture verification below; expired-signature and reconnect cases remain open. |
| Creation/motion results, workflows, templates | Source review: direct video elements consume result URLs. No common renewal/rendition integration is established across these callers. | Check expiry, poster continuity, background return and the original/download distinction on each supported surface. |
| Full-rendition worker interruption | Source review: `claim_media_rendition_repairs` leases without incrementing attempts; the worker increments at terminal updates. A process killed before that update may retain its attempt count. | Reproduce lease-expiry/crash exhaustion locally before changing claim semantics; account for claimed rows deferred by the time budget. |
| Generation deletion | Source review: Private playback cleanup now uses DELETE RETURNING to capture a concurrently published derivative; linked posts retain outputs. Preview cleanup remains source-only. | Continue preview/reference retention audit; no orphan purge has been performed. |
| Remaining device coverage | Offline/reconnect, background expiry, rapid navigation, audio/resources, avatars/covers and physical-device performance remain incomplete. | Continue the whole-app matrix; do not infer caller coverage from shared unit tests. |

## Validation and evidence

- Mobile: 183 test files / 1,774 tests passed under Node 24; typecheck passed.
- Android and iOS production-configured Hermes exports passed. Existing bundle
  configuration verification found no missing required client values.
- Android native cache reproduction and helper verification passed as described.
- Production: all 27 selected video objects decoded and passed range checks.
- These first second-pass checks preceded the backend implementation below.
  Native exports are not store builds or OTA releases.

Ignored local evidence in `output/media-audit/`: `private-descriptor-before.log`,
`private-descriptor-after.log`, `viewer-cache-before.log`,
`mobile-tests-second-pass-final.log`, `android-cache-collision-before.json`,
`android-cache-isolation-control.json`, `android-cache-verification-after.json`,
`video-integrity-second-pass.json`, `video-integrity-legacy-second-pass.json`,
and `native-exports-second-pass-verification.jsonl`. Bounded read-only audit and
synthetic native fixture scripts are kept alongside those receipts.


## Private playback producer checkpoint (local, unreleased)

The private-generation pipeline now persists a separate playback object in the
owner's private `generated_videos/<owner>/playback/<generation>/<hash>.mp4`
namespace. The original URL and bytes remain unchanged. The owner API batches
signing with its existing media reads and exposes only the signed rendition URL,
not its raw path/status columns. It suppresses failed, processing, foreign-owner
and stale-source metadata. Web Studio and profile use the playback resolver;
the earlier mobile adapter fix preserves the same descriptor.

Migration `20260905213637_private_generation_playback_renditions.sql` was captured
from the isolated local schema using Supabase CLI 2.75.0 and replayed cleanly.
Service-only claim/preflight RPCs admit existing owner-scoped stored videos whose
recorded size is positive and at most 64 MiB. Each claim consumes one of three
attempts before I/O, so expired leases cannot retry forever after process kills.
One video runs only on an otherwise idle preview sweep within its first 30 seconds.
Encoding uses the existing H.264/AAC fast-start ladder and rejects outputs that
are not meaningfully smaller. Downloaded size must match the admitted size, and
stored derivative bytes must match the encoder output before publication.

A 150-second cancellation signal bounds downloads and FFmpeg work, with narrower
30/15-second source/readback timeouts. The current SDK upload and DB mutations do
not accept that signal here; this is not a hard end-to-end deadline. Platform
termination is still covered by the consumed attempt and expiring lease. Busy
preview/post queues take priority, so private backfill can be delayed.

Deletion now returns the row it actually deleted, capturing a rendition published
between the initial read and delete. A worker whose generation disappears before
publication removes only its new derivative. Regression tests reproduce both
races. Linked-post retention is preserved. A process killed after upload and
before publication can still leave an unreferenced content-addressed object;
there is no general orphan purge in this checkpoint. If the original path later
changes, the API hides the old rendition; automatic requeue is not implemented.

### Local Storage and browser evidence

A synthetic 656 × 1376, two-second original was uploaded as a correctly typed
Blob to the isolated local Storage service. The real claim, worker, FFmpeg,
readback and owner-route service produced a 610 × 1280 rendition:

| Measurement | Result |
| --- | --- |
| Original | 1,790,943 bytes |
| Private playback | 150,439 bytes (91.60% smaller) |
| Original readback | Exact byte equality; original path unchanged |
| Rendition decode | Full FFmpeg decode passed |
| Signed Range request | HTTP 206, exactly 1,024 bytes |
| Unauthenticated public-object request | HTTP 400; no public read |
| Repeat sweep | No new attempt after ready publication |

Chromium opened the actual Studio page with the local owner API payload supplied
through request interception. Both the tile and detail player selected the
private rendition, decoded at 610 × 1280, and reached readyState 4 without a media
error; the detail player was playing. The download link retained the original.
The owner profile was also loaded with a real synthetic local Supabase session;
its creation detail player selected the rendition, decoded at 610 × 1280, reached
readyState 4 and was playing without a media error. Its inactive grid player had
not loaded a source, so this does not claim profile-grid autoplay coverage.
This is synthetic local browser evidence, not production/mobile latency data.

### Backend checkpoint validation

- Full web suite: 747 files / 5,321 tests passed before the final scheduler and
  cancellation/contract cases; the final affected run passed 7 files / 64 tests.
- Clean isolated migration replay and full database suite: 62 files / 1,155 tests.
  Includes lease recovery/exhaustion, owner/size admission, path/ready constraints,
  and service-only access checks.
- Web application, script and test typechecks plus lint passed. Production build
  and runtime FFmpeg/libvips artifact checks passed before formatting/test-only
  changes; no subsequent production-code behavior changed.
- Shared contract now includes a private-video response preserving the original
  and playback URLs. Mobile contract suite: 102 tests passed; mobile typecheck
  passed. No mobile runtime code changed in this backend checkpoint.
- This migration and backend code have not been applied to production or released.
  Quality on the exact release SHA and the normal production workflow remain required.

Local evidence: `private-playback-local-smoke.json`,
`private-playback-browser-creations.log`, `private-playback-browser-profile.log`,
`private-playback-web-tests.log`,
`private-playback-db-suite.log`, `private-playback-build.log`,
`private-playback-checks-complete.log`, and `private-playback-contract-mobile.log`
in ignored `output/media-audit/`. All media in this smoke run is synthetic and
local. Original production media has not been overwritten by this checkpoint.
