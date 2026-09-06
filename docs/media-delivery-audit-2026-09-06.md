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

## Native viewer failed-request recovery (local, unreleased)

The current checkout was served through a separate Metro instance to Android API
36 and the iPhone 17 Pro iOS 26.4 simulator. The owner-generation API was replaced
in memory with one synthetic creation descriptor pointing to the previously
verified local original and rendition. No production data was written. The real
`studio-creations` viewer adapter selected the 150,439-byte rendition, and the
fixture server observed no request for the 1,790,943-byte original.

Before the fix, forcing HTTP 503 on a fresh video URL reproduced an empty black
viewer on Android. The native player reported `error`, zero duration and no
playback. There was no error message or retry control. Restoring the server and
tapping the video did not recover: `play()` retained the failed native source.
This is a reproduced failure mode, not proof that every reported black tile has
the same cause.

The shared full-screen viewer now displays “Video couldn’t load” and a “Retry
video” button. Retry remounts only the active playback attempt, releasing the
failed player and resolving its source again. The effect also reads the player's
current status when subscribing so an early error is not missed. Retry is an
explicit action; this change adds no automatic retry loop or original fallback.
The existing SecondaryButton supplies its touch target and typography. The
recovery panel was visually checked on both simulators; the HIG type/contrast
guard passed, with Apple's [UI design guidance](https://developer.apple.com/design/tips/)
used for the touch/text review.

Both platforms displayed the error and remained recoverable when Retry was used
while the server still returned 503. Once restored, Android's Retry button was
activated by an ADB screen tap; on iOS its rendered button handler was invoked
through the native JS inspector. Both players reached `readyToPlay`, duration
2 seconds, `playing: true`, and visible moving fixture frames. The error panel
cleared. Dismissing the viewer left no mounted FeedMediaFrame video player on
either platform, and reloading the development apps cleared the fixture overrides.
The iOS check verifies the rendered handler and playback, not physical
finger hit testing. Native decoder/request retries are included in the fixture
server log; there is no claim of one HTTP request per user retry.

An Android background/return check on a successfully loaded video paused playback
and retained its ready player at the same position on return. Automatic resume
was not added. This pass did not simulate a real offline network, long background
signature expiry, reduced-motion recovery, or memory pressure. It also does not
verify every caller of the viewer. The generic `MediaPreview` and lightbox video
branches still need their own failure/recovery checks.

Validation: 183 mobile test files / 1,775 tests and typecheck passed. Android and
iOS production-configured Hermes exports passed, and the bundled environment
validator found no missing values. The first export attempt used blank development
RevenueCat values; explicit loading of the existing production env resolved it
without modifying env files. No OTA, store build, web deploy or migration was
performed for this viewer change.

### Repeatable native acceptance case

1. Open a fresh synthetic video through the `studio-creations` viewer, with
   distinct original and rendition URLs. Confirm frames and rendition-only reads.
2. Make the rendition endpoint return HTTP 503 and open a new URL to avoid cache.
   Wait for native `error`; confirm the message and Retry button are visible.
3. Retry while the endpoint still fails. Confirm the error remains actionable.
4. Restore successful video responses and activate Retry. Confirm a new source
   load, `readyToPlay`, advancing playback time, and disappearance of the error.
5. Leave the viewer and confirm the active player is unmounted. Restore all
   in-memory API overrides or reload the development app after the check.

Ignored evidence: `android-third-pass-error.png`,
`android-third-pass-restored-tap.json`, `{android,ios}-third-pass-retry.png`,
`{android,ios}-third-pass-retry-still-failed.json`,
`{android,ios}-third-pass-recovered.{json,png}`, `native-third-pass-requests.json`,
`mobile-third-pass-checks.log`, `native-third-pass-export.log`, and
`native-third-pass-env-verification.jsonl` under `output/media-audit/`.

## Shared native preview and lightbox recovery (local, unreleased)

The template detail page reproduced a failed-video state on both Android API 36
and iOS 26.4 using a synthetic template response and a local video endpoint
returning HTTP 503. The player reported `error` with zero duration; the surface
showed a black video with native controls and no app-level failure explanation.
After restoring the endpoint, Android's native play control recovered in this
case, whereas an iOS `play()` request retained the failed state. This differs from
the immersive viewer reproduction above and is not evidence that all native
controls fail identically.

The actual MediaLightbox component was also mounted in a temporary native fixture
host using an in-memory module override. It reproduced an errored black video on
both platforms. This exercised the shared lightbox and native player, not the
composer's upload/navigation journey. The fixture did not create a template,
start a generation, upload user content, or modify production data.

`RecoverableVideoPreview` now supplies one loading/error/retry implementation to
both MediaPreview and MediaLightbox. It shows loading feedback while the native
source is idle/loading and a labelled Retry video action on error. Retry releases
the failed attempt and resolves/loads its source again, then plays after the
explicit action. Initial result previews remain paused and lightboxes retain
their existing autoplay. Changing to a different URL resets the retry state and
does not transfer an earlier retry's autoplay decision to the new result. The
original URLs, authenticated-source helper and audio mixing policy are preserved.

On both native platforms, retrying during continued failure left an actionable
error. Restoring the server and retrying produced `readyToPlay`, two-second
duration, advancing time and visible frames in template previews and lightboxes.
The Android lightbox retry was activated by screen tap; other retry checks used
the rendered SecondaryButton handler through the inspector. This is not an iOS
finger hit-test or physical-device performance measurement. Loading feedback was
observed during native retry; slow-network timing and stalled-request timeout
behavior remain unmeasured.

The shared preview is used by creation/motion result workspaces, template demos,
intermediate steps and final results. Those callers inherit the implementation,
but only the template detail caller was navigated end to end here. Generation
results, template-run final results, composer/reference lightbox navigation,
background audio ownership and expired template asset URLs remain separate
acceptance cases. Source review alone does not close those rows in the matrix.

Six new component regression cases cover loading, early error, attempt release,
repeated failure, autoplay and source replacement. Existing image/feed tests now
mock the unrelated shared video leaf; the lightbox native mock includes status
listeners. The HIG player inventory was moved to the shared constructor without
weakening the exhaustive audio-policy scan. Full mobile suite: 184 files / 1,780
tests passed; typecheck passed after correcting test-renderer host element types.
Android/iOS production Hermes exports and bundled-environment checks passed.
No backend code, database migration, store artifact or OTA was released here.

Evidence in ignored `output/media-audit/`: `{android,ios}-template-before.json`,
`{android,ios}-template-restored-before.json`, `android-template-before.png`,
`{android,ios}-template-recovered.{json,png}`, `{android,ios}-lightbox-before.json`,
`{android,ios}-lightbox-retry.png`, `{android,ios}-lightbox-recovered.{json,png}`,
`native-fourth-pass-full-checks.log`, `native-fourth-pass-typecheck.log`,
`native-fourth-pass-export.log`, `native-fourth-pass-env-verification.jsonl`.
