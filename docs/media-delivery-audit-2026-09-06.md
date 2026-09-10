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
| Creation/motion results, workflows, templates | Web video/motion results and expanded workflow rendition selection are verified. Generated workflow video/motion cards now use batched posters. Template run final/intermediate media can renew through owned-run GET; template rendition metadata and input/approval thumbnails remain open. | Continue template optimization and remaining thumbnails; test long-session expiry, poster continuity and background return per surface. |
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

## Retained-screen playback and template-run acceptance (local, unreleased)

Reproduced another lifecycle defect on Android API 36 and iOS 26.4: a playing
template-detail demo remained `playing: true` after pushing the template list.
The previous screen and VideoView remained mounted, so player release on unmount
did not stop offscreen playback. This used the actual template route with a
synthetic API response and a silent two-second local video; it establishes
unwanted playback, not measured audible sound, CPU, memory or battery cost.

The shared RecoverableVideoPreview now pauses when its owning navigation screen
loses focus. A player created while hidden cannot autoplay. Returning to the
screen leaves it paused until requested; source loading and retry still use the
existing shared implementation. On both platforms, native inspection confirmed
`playing: false` after navigation and the same paused position on return. A play
request resumed playback, with visible fixture frames checked in screenshots.

Backgrounding the playing template demo paused the Android player; returning
retained its paused position and ready state. iOS's inspector did not answer while
the app was suspended; after returning from Safari, its retained player was ready
and paused. Both played again on request. This short background/return case does
not verify long-lived signature expiry, offline recovery or PiP/fullscreen modes.
No additional AppState policy was added.

The actual `/template-runs/[runId]` result route was then exercised on both
platforms using an in-memory completed-run response, without creating a run,
spending credits or writing production data. HTTP 503 produced the visible error
and Retry video button; retry during continued failure remained actionable.
After restoring the server, Android's rendered Retry button was tapped through
ADB and iOS's rendered button handler was invoked through the JS inspector.
Both reached `readyToPlay`, two-second duration and advancing playback with visible
frames. Pushing the template list paused each retained result player; returning
preserved that paused position. This covers the final-result caller, not actual
generation execution, publishing, intermediate-step previews or original download.
Development apps were reloaded afterwards to clear the fixture API overrides.

Validation: 184 mobile test files / 1,782 tests and typecheck passed. Two regression
cases cover retained-screen focus and hidden autoplay. Android/iOS production
Hermes exports and bundled-environment checks passed. No migration is needed for
this focus fix, and no deployment or OTA was performed.

Ignored evidence under `output/media-audit/`: `{android,ios}-navigation-*`,
`android-preview-background.json`, `{android,ios}-preview-foreground.json`,
`{android,ios}-run-{error,still-failed,recovered,hidden,return}.json`,
`{android,ios}-run-{error,recovered}.png`, `native-fifth-pass-requests.json`,
`native-fifth-pass-checks.log`, `native-fifth-pass-export.log` and
`native-fifth-pass-env-verification.jsonl`.

## Composer video source and creation-result acceptance (local, unreleased)

Reproduced a composer-specific playback defect on Android API 36 and iOS 26.4.
Editing an existing video post hydrates `uri` from the video's URL and
`previewUrl` from its image poster. ComposerMediaLightbox preferred previewUrl
for every media kind, so it handed the JPEG to the native video decoder. The
actual `/post/new?postId=…` route, supplied with a synthetic owner-post response,
showed a black player and the earlier audit's error panel on both platforms.
Native state was `error`, duration zero; the fixture request log contained JPEG
reads and no MP4 request before the fix. This is a source-selection failure,
not a missing video or a slow connection.

Video lightbox items now select `uri`; image items retain their preview selection.
A regression test failed on the poster URL before the change and passes after
it, including image-preview and local-video cases. Both native composer players
then loaded the MP4, reached `readyToPlay`, and displayed moving frames. Moving
to the adjacent image removed the video player, returning to the video loaded
it again, and closing the lightbox left no mounted VideoView. These controls
were exercised through their rendered handlers in the native JS inspector;
this pass does not establish physical finger hit testing or upload/publish success.

The video creation route's actual GenerationWorkspace was also checked, with
synthetic completed-status state injected through the inspector. No generation
was started and no credits were spent. Both platforms played the two-second
fixture and unmounted the player when the workspace was minimized. A fresh URL
returning HTTP 503 showed the error panel; restoring the endpoint and invoking
Retry video recovered ready playback and visible frames. This verifies the video
result caller, not the motion route, provider completion, polling, or private
rendition selection. Those cases remain open. No additional workspace lifecycle
change was necessary.

Validation: 185 mobile test files / 1,783 tests, typecheck, Android/iOS production
Hermes exports and bundled-environment checks passed. Both development apps were
reloaded to clear API/state overrides, and fixture-specific persisted composer
draft entries were removed. No production post, media object, database schema,
deployment or OTA was changed. This source-selection fix needs no migration.

Ignored evidence under `output/media-audit/`: `{android,ios}-composer-*`,
`composer-requests-{before,after}.json`, `composer-regression-before.log`,
`{android,ios}-creation-{playing,closed,error,recovered}.json`,
`{android,ios}-creation-{error,recovered}.png`, `mobile-sixth-pass-checks.log`,
`native-sixth-pass-export.log`, `native-sixth-pass-env-verification.jsonl`.

## Motion-result acceptance and reference URL renewal (local, unreleased)

The actual `/create/motion` route was exercised on Android API 36 and iOS 26.4
with completed-result state injected through the inspector. Both players played
the silent two-second fixture, unmounted when the result window closed, displayed
an error for a fresh URL returning HTTP 503, and recovered ready playback and
visible frames through Retry video after the endpoint was restored. These actions
used rendered handlers/native player methods; no motion generation or upload was
started. This verifies the result caller, not provider execution, input validation,
private rendition selection or physical-device performance.

Source tracing found that the resource-file endpoint signs links for 600 seconds,
while PostResourceReferences retained its initial resolved URLs without renewal
when opening or navigating between references. A native fixture host mounted the
actual reference component and shared lightbox. Its initial resolver supplied a
URL returning HTTP 403; later resolver calls would supply a working URL. Before
the fix, opening the video called no resolver beyond the two initial preloads and
both native players entered `error` with duration zero. This is a controlled
rejection/renewal reproduction, not an actual ten-minute Supabase JWT expiry test,
nor an end-to-end purchased-resource journey.

Explicit reference opens and lightbox navigation now resolve through the existing
resource endpoint again. Image preview caching remains; an initial preload cannot
overwrite a subsequently renewed URL. Opening audio/files also renews before the
existing external handoff. Failed renewal reports through the existing onError
callback and does not open the stale target. A request sequence prevents late
responses from selecting an older target or reopening a closed lightbox.

After the change, a clean fixture on each platform recorded two preload
resolutions, then exactly one more on opening the reference. The renewed URL
reached `readyToPlay`, two-second duration and visible moving frames. Selecting
the adjacent image renewed its link and removed the video player; navigating back
played the video again, and closing removed it. These controls used rendered
handlers through the native inspector. Development apps were reloaded afterwards
to clear all fixture overrides; no production data was changed.

Three regression cases cover renewal of a cached URL, denial without stale
fallback, and navigation/closing during a delayed resolution. The two initial
cases failed before implementation. Full mobile suite: 185 files / 1,786 tests;
typecheck, Android/iOS production Hermes exports and bundled-environment checks
passed. No migration, deployment or OTA was performed.

Remaining limits: this adds one access-check request per explicit open/navigation.
It does not renew a reference automatically while its lightbox remains open;
Retry video still retries that already-selected URL. Long-lived playback expiry,
renewal failure visibility inside an open modal, real offline/reconnect and the
full unlock-to-reference journey remain acceptance cases. Do not treat these as
covered by the successful reopen check.

Ignored evidence under `output/media-audit/`: `{android,ios}-motion-*`,
`{android,ios}-reference-*`, `reference-regression-{before,after}.log`,
`reference-requests-seventh-pass.json`, `motion-requests-seventh-pass.json`,
`mobile-seventh-pass-checks.log`, `native-seventh-pass-export.log`, and
`native-seventh-pass-env-verification.jsonl`.

## Reference retry renewal and in-lightbox feedback (local, unreleased)

Reproduced failed recovery inside an already-open reference lightbox on Android
API 36 and iOS 26.4. A controlled URL returned HTTP 403, while the resolver was
subsequently able to return a working URL. Retry video remounted the player with
the same rejected URL: the resolver count stayed at three and both players
remained in `error`, with duration zero. This tests recovery from rejected links;
it does not establish actual signature expiration during a long playback session.

RecoverableVideoPreview now accepts an optional retry URL resolver, passed through
MediaLightbox by the reference component to the existing access-checked resource
endpoint. Retry resolves first, then replaces the failed player. While pending,
the button reads “Refreshing video…” and repeated presses do not start duplicate
renewals. Rejection leaves the failed player in place and displays “Couldn’t
refresh video. Try again.” Changing the selected source or closing the lightbox
prevents a late response from loading that old source. Callers without a resolver
retain their existing remount/retry behavior.

Both native platforms showed the renewal-denied message inside the lightbox.
After allowing renewal, Retry reached `readyToPlay`, duration two seconds, and
advancing playback. The final Android retry used an ADB screen tap; iOS used the
rendered handler through the native JS inspector. Screenshots captured the
failure, pending and recovered states. Delayed renewal completed after closing
without reopening the lightbox or mounting a VideoView on either platform.

Also reproduced missing feedback when moving to an adjacent reference whose
renewal fails: the parent received an error but the modal had no visible alert.
MediaLightbox now displays the navigation failure and pending status in its header.
The current reference remains selected on failure; the arrow can be retried and
Close remains available. Duplicate requests for the same pending target are
suppressed. Both native platforms displayed the alert and pending state, and
closing during delayed navigation prevented a late reopen. The content area
reserves space for the message. The existing type/contrast/hit-target guards
passed; visual checks used the existing iPhone and Android simulator sizes.

Validation: 185 mobile test files / 1,790 tests and typecheck passed. Three new
retry regression cases failed before implementation; tests also cover navigation
denial, duplicate pending navigation and closing during resolution. Android/iOS
production Hermes exports and bundled-environment checks passed. Native fixtures
used the actual shared components in a temporary host, not the full purchased
resource journey. Apps were reloaded to clear the fixture overrides. No production
data, migration, deployment or OTA changed.

Remaining checks include actual JWT expiry during playback, real offline/reconnect,
image retry renewal, full unlock-to-reference navigation and bounded resolver
timeouts. There is no new automatic refresh loop or proactive expiry timer.

Ignored evidence in `output/media-audit/`: `{android,ios}-reference-retry-*`,
`{android,ios}-reference-renewal-denied.png`,
`{android,ios}-reference-navigation-denied-{before,after}.json`,
`{android,ios}-reference-navigation-denied-after.png`,
`{android,ios}-reference-pending*`, `{android,ios}-reference-late-*`,
`retry-renewal-before.log`, `mobile-eighth-pass-checks.log`,
`native-eighth-pass-export.log`, `native-eighth-pass-env-verification.jsonl`,
and `reference-eighth-pass-requests.json`.

## Mobile API response-body timeout (local, unreleased)

Reproduced a shared API-client timeout gap with two failing regression tests:
the timeout and caller cancellation were detached after response headers, before
the body had finished. A partial JSON response could therefore leave a media-link
renewal pending indefinitely. The request now retains both until body parsing
finishes, and cleans them up on success or failure. HTTP error and upgrade handling
continue through the existing path. This is a request-layer reproduction, not
evidence that this condition caused the reported native black media.

Validation: the mobile suite passed 185 files / 1,792 tests. After correcting a
test-only TypeScript narrowing issue, all 55 API-client tests and mobile typecheck
passed. A real local HTTP server sent headers and partial JSON then stalled; the
media-link call failed with ApiError status 0 in 181 ms with a 150 ms configured
timeout. The production default remains 30 seconds. No database or release change
is required for this fix. Evidence: `output/media-audit/api-body-timeout-before.log`,
`mobile-ninth-pass-checks.log`, and `api-body-timeout-smoke.ts`.

Limits: access-token and installation-ID acquisition precede this request timer.
The separately implemented conditional generation-catalog fetch does not use this
timeout path. Image retry renewal, actual expiry and offline/reconnect verification
remain open.

## Reference image retry renewal (local, unreleased)

Reproduced on Android API 36 and iOS 26.4 using the actual reference component
and lightbox in a temporary native fixture host. After a controlled HTTP 403,
Retry loading media reused the failed image URL even when the resource resolver
could supply a working link. Both platforms returned to Preview unavailable;
the resolver count stayed at three. This reproduces rejected-link recovery, not
actual JWT expiration or the full purchased-resource journey.

StableMediaImage now accepts the existing optional retry resolver from
MediaLightbox. An explicit retry renews the link before loading the image, shows
Refreshing image while pending, and suppresses duplicate requests. Renewal denial
keeps a visible error with another retry available. A source change or unmount
invalidates the pending image session. Existing callers without a resolver retain
their remount retry, stable cache identity and bounded automatic network retries.

Both native platforms showed denial feedback, then displayed the synthetic JPEG
after a successful renewal. Repeated pending presses made only one resolver call.
Closing during delayed renewal left zero lightbox images after the response;
it did not reopen the modal. These checks invoked rendered native handlers through
the JS inspector; screenshots verified the denied, pending and recovered states.
The fixture overrides were cleared by reloading the apps after verification.

Validation: 185 mobile test files / 1,797 tests, mobile typecheck, Android/iOS
production Hermes exports and bundled-environment checks passed. Added regression
coverage for renewal, denial/retry, duplicate pending requests, source replacement,
close during renewal, and lightbox resolver forwarding. Existing image caching,
fallback and HIG guards passed. No database migration, deployment or OTA changed.

Ignored evidence: `output/media-audit/{android,ios}-image-retry-*`,
`{android,ios}-image-renewal-*`, `reference-tenth-pass-requests.json`,
`mobile-tenth-pass-checks.log`, `native-tenth-pass-export.log`, and
`native-tenth-pass-env-verification.jsonl`.

Remaining: actual signature expiry during long sessions, real offline/reconnect,
full unlock navigation, intermediate template steps, audio ownership, remaining
web consumers and physical-device performance measurements. The resource endpoint
uses the shared API request timeout; token acquisition is still outside that timer.

## Real signed-link expiry acceptance (local, unreleased)

On Android API 36 and iOS 26.4, reference videos and images recovered after real
local Supabase Storage links expired. Synthetic files were uploaded to the private
`post_resource_files` bucket and signed for eight seconds. The native fixture
opened them after expiry. Storage returned HTTP 400 / InvalidJWT with an expiry
claim timestamp failure, and both video players entered error with zero duration.
Retry signed a fresh 120-second URL and both reached readyToPlay with advancing
playback. Expired images likewise showed the failure tile, then displayed the
synthetic JPEG after Retry. Screenshots verified image recovery on both platforms.

This exercises the actual reference components and native players with real
Storage expiration. The fixture resolver replaces the production resource route;
it does not certify purchase authorization, the full unlock journey, or expiry
during uninterrupted playback. No application code changed in this acceptance
pass. The latest application validation remains 185 files / 1,797 mobile tests,
typecheck and Android/iOS production exports passing at `1d7f964`.

Evidence: `output/media-audit/{android,ios}-real-expiry-*` and
`real-expiry-renewal-receipts.json`. The interrupted local fixture process did not
record cleanup; any retained `expiry-audit/` objects are synthetic local test data.

## Android offline/reconnect acceptance (local, unreleased)

Disabled Wi-Fi and cellular data and enabled airplane mode on the Android API 36
emulator; ConnectivityService reported no active default network. In the actual
reference lightbox, image and video renewal failed with ApiError status 0 and
visible refresh errors. The controls returned to an enabled retry state. The
fixture used the real mobile API client with a three-second timeout and a local
endpoint; failures arrived in 88 ms for image and 1,442 ms for video. These are
fixture observations, not production latency measurements.

After restoring connectivity, Retry displayed the image again and the video
reached readyToPlay with advancing playback. No app restart was needed. Renewals
completed in 128 ms and 119 ms respectively. Screenshots verified both recovery
states. This validates explicit recovery from offline renewal on Android; iOS
offline behavior, loss of connectivity during buffered playback and recovery
without pressing Retry remain unverified. No application code changed.

Evidence: `output/media-audit/android-offline-*` and `android-reconnect-*`.
Network settings were restored after the checks. The local fixture server was
used because Docker was stopped; this pass did not use Supabase or production.

## Intermediate template previews (partial native acceptance)

On iOS 26.4, a synthetic template run rendered two intermediate video outputs
through the actual RunSteps/RunStepCard path, with no final result. Both players
loaded paused. After starting both through the native inspector, navigating to
the creation screen paused both retained players; returning kept them paused.
A second synthetic run returned HTTP 503 for both video sources. Both displayed
player errors; Retry after restoring the fixture server recovered both to
readyToPlay with advancing playback. Screenshots verified the rendered previews.

Android reached the template route's sign-in screen after the dev reload, so its
intermediate-result route acceptance remains open. There is no evidence in this
pass attributing that auth state to the earlier network disconnect. This test
does not execute a provider generation, approve a step, or charge credits.

Multiple players can play concurrently within the active intermediate-results
screen, and paused players remain allocated on retained screens. Navigation
pause is verified; viewport-based ownership, audio overlap and physical-device
decoder/memory budgets still need assessment. Source review also confirms that
resource audio opens externally via Linking, while creation audio references
render a static tile; neither is an in-app audio player acceptance result.

Evidence: `output/media-audit/ios-intermediate-*`, `native-intermediate-run.js`,
and `android-intermediate-setup.png`. No application code changed in this pass.

## Preserve playback state during effective-source renewal (local, unreleased)

Reproduced on Android API 36 and iOS 26.4: a shared preview paused at one second
started playing again when useMediaSource returned a new effective URL for the
same input media URL. The native fixture changed the effective URL through a
temporary hook override while rendering the actual RecoverableVideoPreview.
This reproduces player replacement behavior; it does not exercise the actual
expiry timer, authenticated redirect, or JWT refresh in a long session.

The installed expo-video hook recreates its native player when the serialized
source changes and releases the old player after render. The shared preview now
copies position, pause/play intent, mute, volume and playback rate from that old
player during replacement setup. An explicit pause is necessary after restoring
settings: the first implementation still resumed on iOS, which native testing
caught. Different media items and explicit Retry retain their existing fresh
attempt behavior. A replacement on a hidden screen cannot resume playback.

Both platforms now remain paused at one second after replacement. With a
40-second synthetic clip, source replacement during playback preserved progress:
Android advanced from 25.528 to 34.613 seconds and iOS from 25.758 to 35.589
seconds across the check interval. Both were readyToPlay and playing. Refreshing
the source after navigating away left the retained player paused on both
platforms. Tests also verify copied audio settings and existing Retry behavior;
native audio-setting acceptance is not claimed here.

Validation: 185 mobile test files / 1,800 tests and mobile typecheck passed;
the 14 focused preview tests passed again on the final patch. Initial local
production exports failed the bundled-client-configuration gate. Re-exporting
both platforms with Expo's cache cleared passed the same gate. Android/iOS
Hermes exports therefore passed after the clean rebuild; the failed earlier
exports are not release evidence. No migration, deployment or OTA changed.

Evidence: `output/media-audit/{android,ios}-source-refresh-*`,
`mobile-source-refresh-final-checks.log`, `native-source-refresh-clean-export.log`,
and `native-source-refresh-env-verification.jsonl`. Fixture overrides were cleared
by reloading the apps after the checks. Remaining work includes actual expiry
during playback, viewport-based player ownership, iOS offline recovery, remaining
web consumers, authenticated Android template checks and physical-device budgets.

## Web video and motion result delivery (local, unreleased)

Reproduced on the actual `/create-video` and `/create-motion` routes in Chromium:
mocked completion responses supplied a video URL returning HTTP 403 while the
owner-generation response offered a playable rendition. Both pages still loaded
the failed original, reaching media error code 4 and readyState 0, with no Retry
control. This was a controlled expired-link response, not another real Storage
JWT expiry test. No provider generation or credit charge was performed.

Both result pages now use `GenerationResultVideo`. It fetches the matching owner
descriptor before mounting the video, prefers the full playback rendition, and
uses the freshly signed original if no rendition exists. The separate download
link receives that original URL, never the rendition. The preview shows loading
and recoverable error states. Retry remounts the attempt, requests a fresh
descriptor using the current auth token and reloads the video. A token update
alone does not replace the active player. Replacing or closing the result aborts
pending work, and late responses cannot restore an older result.

The initial lookup, response-body read and first-frame wait share a 30-second
deadline. A stalled owner request was held open in Chromium: the loading state
changed to Retry with no mounted video after the deadline. Denied/missing owner
responses do not fall back to the stale output URL. Once the first frame loads,
this deadline stops; detecting a later silent playback stall remains open.

Browser acceptance on both routes: a failed rendition displayed Retry; supplying
a refreshed descriptor and clicking Retry produced readyState 4, decoded width
320 and advancing playback of the synthetic rendition. The download href stayed
on the refreshed original. Screenshots were inspected for the rendered error and
playback states. Fixture MP4s have different lengths and are only selection and
recovery evidence, not a compression-quality or bandwidth comparison. The dev
resume fixture also exposed a separate aborted-poll message under Strict Mode;
that generation-status behavior was not changed in this media pass.

Focused component/client/style checks pass (3 files / 27 tests); application and
test typechecks and changed-file ESLint pass. The first full run passed 5,335 of
5,336 tests and caught the new component missing from the private stylesheet's
explicit scan list. That registration was added and the affected checks passed.
The final full rerun passed all 749 test files / 5,336 tests.

Evidence: `output/playwright/web-{video,motion}-result-*.png`,
`output/playwright/result-{setup,retry-setup}.js`, and
`output/media-audit/web-result-*.log`. The Next server used explicitly overridden
local Supabase configuration and synthetic browser API responses. This change
adds no migration and has not been deployed. The previously added private
playback migration remains local and must ship through the normal release gates.

Next: workflow node outputs retain `runState.generationId`, but node previews
and the expanded workflow player still pass direct URLs without this descriptor
resolution. Audit that handoff before extending result playback there. Web
template results, original-download renewal at click time after a long idle,
real expiry during playback, viewport ownership, iOS offline recovery and
physical-device performance remain open.

## Expanded workflow video playback (local, unreleased)

The real workflow editor was loaded with a synthetic saved canvas containing
completed video and motion nodes. Both retained a generation ID, but
`PreviewMediaLink` discarded it when opening the expanded player. With a 403
source and an available rendition, each expanded video reached readyState 0 /
media error 4 without Retry. The two node thumbnails also failed. This reproduces
the web renderer behavior, not an actual provider completion or Storage expiry.

Generated video and motion preview links now pass their generation ID into the
expanded viewer. The overlay uses `GenerationResultVideo` to resolve the current
owner descriptor, prefer the rendition and renew it on Retry. It preserves the
workflow's non-looping playback behavior. Video inputs without a generation ID
use the same player's direct-URL loading/error/retry path. Original workflow
data and downstream generation inputs are unchanged; signed rendition URLs are
not persisted into the graph.

Opening a node preview also reproduced an Escape failure: focus remained on the
node button, whose keyboard handler stops propagation. The overlay now focuses
Close on opening and restores the previous focus on closing. Chromium verified
that Escape removes the expanded player and returns focus to the node button.
This is not certification of a complete modal focus trap or all canvas shortcuts.

Archived owned generations require `includeArchived=true` on the owner lookup.
The default endpoint filter would otherwise reject an output still referenced by
a saved workflow. A browser response fixture following that filter and a failing
regression test reproduced the omission. The shared player now includes archived
rows in its targeted lookup; the existing owner authentication and linked-account
filter remain enforced by the endpoint. The fixture then decoded the rendition.
No production archive mutation or database change was performed.

Browser acceptance: video and motion expanded outputs decoded the 320-pixel
synthetic rendition at readyState 4; motion Retry recovered from a failed
rendition with advancing playback. Loop remained false. The video player and
Close control fit the inspected 390×844 viewport. Node thumbnails still request
the original video and remain a reproduced unresolved issue; no thumbnail or
bandwidth optimization is claimed by this change.
An uploaded-video input with no generation ID also recovered after a controlled
503 response: Retry reloaded the same direct URL and reached readyState 4 with
advancing playback. This did not exercise an actual upload or storage redirect.

Validation: 6 focused suites / 79 tests passed, including shared player,
workflow page/overlays/node editors, video creation and route stylesheet checks. Application/test
typechecks and changed-file ESLint passed. Evidence is under
`output/playwright/workflow-*.png`, `workflow-media*-setup.js`, and
`output/media-audit/workflow-*.log`. Tests used local configuration and synthetic
API/media responses; no paid generation ran. No migration, deploy or OTA changed.

Next: replace original-video node thumbnail loading with bounded preview delivery
without introducing a request per rendered node. Template final and intermediate
results also need review: the owner-generations endpoint deliberately excludes
hidden intermediate template outputs, so the workflow fix must not be copied
blindly into those players. Use their authorized run API when renewing media.

## Workflow poster thumbnails and template run recovery (local, unreleased)

On the real workflow editor with a saved two-node canvas fixture, generated
video/motion cards each mounted a video and requested the failed original. Both
reached media error 4 and readyState 0. The new `WorkflowOutputThumbnails` provider
resolves preview images in sequential owner-API batches of at most 50 unique
generation IDs, including archived outputs. Node position and selection changes
do not refetch. Source/generation changes, auth changes, returning to the page
and reconnect events refresh descriptors. Each batch's headers/body have a
15-second timeout, and replaced graphs ignore late results.

Those generated cards now render lazy-decoded images and an Open video control.
Missing, denied or corrupt posters use the same clickable fallback without
loading a full video. Chromium verified two decoded 320px posters from one batch
request and zero video elements in the two nodes. Holding poster responses at
503 removed the images while retaining both controls; restoring the same URL
and dispatching an online event reloaded the images without mounting videos.
This is controlled event recovery, not an actual browser network disconnect.
The same-URL case initially failed its regression check and was corrected by
tracking a new image attempt after each descriptor refresh. Tests also cover
51 unique IDs plus a duplicate, drag/selection stability, timeout and late work.

Video inputs and approval-node thumbnails still use direct video elements.
The new provider does not poll pending preview production continuously: a
poster that becomes ready while the user remains on the canvas is picked up on
the next graph/auth/focus/online refresh. Viewport-only descriptor admission and
larger-canvas performance remain open; batching alone is not a capacity claim.

The actual template run page also reproduced a failed final video with no media
recovery control. `TemplateRunMedia` now serves final results and intermediate
step outputs. Initial rendering uses the authorized run response without extra
API calls. Reload media makes a GET to the same owned run and selects the final
result or the matching public run-step ID, never a hidden generation lookup.
Missing outputs, a different run, a changed media kind and denied responses
remain errors. This action never invokes generation retry/approval endpoints.
The final download link receives the renewed original URL. Videos stay paused,
do not loop, and request metadata until the user plays them.

Each template media attempt bounds loading and renewal to 30 seconds, including
a stalled JSON response body. Video metadata readiness ends the initial timer;
this is not detection of later silent playback stalls or a first-frame deadline.
Unmount/replacement cancels pending renewal, and late responses are ignored.
The separate paid regenerate-step action and its confirmation are unchanged.

Chromium acceptance: final video Reload media changed the failed URL to a
decoded renewed video at readyState 4, paused, and updated Download video to the
same renewed original. Intermediate approval video and generated image both
recovered from controlled 403s through their public step IDs; the video was
readyState 4/paused with metadata preload, and the image decoded at width 320.
Desktop and 390×844 screenshots were inspected. No provider generation,
approval, credit charge, Storage ACL change or production request was performed.

Template `toRunDto` still signs step/result originals individually and supplies
no rendition/poster descriptor. This pass fixes client recovery, not template
encoding or byte reduction. Extending the authorized run DTO with source-matched
derivatives, batched signing and web/mobile contract verification is next.
Catalog/demo videos, signed-link refresh during uninterrupted playback,
download/share renewal after a long idle and actual reconnect remain open.

Evidence: `output/playwright/workflow-thumbnail-setup.js`,
`workflow-thumbnails.png`, `template-*-setup.js`, `template-*-renew*.js`,
`template-final-renewed.png`, `template-intermediate-{renewed,narrow}.png`, and
`output/media-audit/{thumbnail*,template-media*,thumbnails-template*}.log`.
Validation: final full web run passed 751 files / 5,350 tests. Application and
test typechecks and changed-file ESLint passed. No production build was run
alongside the active dev server; exact release Quality remains required.
No migration, deployment or OTA is included in this checkpoint.


## Template playback files and remaining canvas input/approval thumbnails

Status: implemented and verified locally; not deployed. No new migration in this
checkpoint. The existing private playback migration remains pending production
release through the exact-main Quality/production-release workflow.

The owned template-run service previously omitted the ready private playback file.
A service regression test failed before the change (see local
`output/media-audit/template-rendition-before.log`). It now selects generation
ownership and derivative metadata, checks owner/run/generation/original-source
identity, and admits only ready renditions inside that generation's private
playback directory. Final, generation-step and source-matched approval outputs
share deduplicated signing batches per bucket. Fixed template inputs retain their
existing owner resolver. Original URLs stay in `url`/`outputUrl`; optional
`renditionUrl` and `previewUrl` travel separately. Shared contract fixture:
`contracts/template-run-media-v1.json`, tested by both clients, including older
responses and mobile relative-URL normalization. Web uses the playback file and
poster; native final/intermediate video previews select the playback file. Missing
or ineligible derivatives retain original playback.

Chromium reproduced two failed embedded video requests from video-input and video
approval canvas cards (503 input, 403 approval), both with readyState 0/media error
4 before opening either preview. After the change the same four-node graph had
zero card video elements, zero original-video requests and three loaded posters
(two generated cards plus approval); the standalone upload kept an Open video
tile. Approvals and generated references can reuse an exact original-output match
within the graph, including its generation ID for expanded playback. An unrelated
upload gets no guessed poster. Missing posters never trigger a full-video fallback.
The input editor's explicit controls player is separate from the canvas thumbnail
and remains a follow-up surface.

Acceptance evidence:

- Web final template video decoded the rendition while paused, used its poster,
  and kept the download link on the original with zero original playback requests.
  A real intercepted HTTP 403 on the rendition displayed Reload media; owned-run
  GET renewal decoded the fresh rendition and renewed the download to the fresh
  original. Intermediate video approval and image output loaded successfully.
- Canvas approval opened and decoded the rendition. Standalone video input opened
  its original only on demand, displayed a visible error for 503, and decoded after
  explicit Retry when the same source recovered. These are controlled Chromium
  fixtures, not production/CDN latency measurements.
- Android emulator and iOS simulator rendered final and intermediate native
  template previews from the 150,439-byte local worker-produced rendition, with
  readyToPlay and a visible decoded test pattern. Explicit play ran successfully;
  backing out removed the active step player and retained the prior final player
  paused. The fixture server recorded rendition requests only. Its no-store,
  two-second looping fixture is not a bandwidth benchmark.
- Native responses were synthetic; Android additionally used a temporary in-memory
  auth context to reach the renderer from its signed-out development session. This
  verifies native media selection/rendering, not authentication or paid execution.
  Local screenshots: `output/media-audit/template-rendition-android.png` and
  `template-rendition-ios.png`. Runtime fixture state is cleared after acceptance.
- Read-only local Supabase smoke queried the exact new generation column list and
  used existing real Storage objects with a synthetic run association. The delivery
  projection retained the original, matched approval playback and returned HTTP
  206 with 1,024 requested bytes. No DB writes. Receipt:
  `output/media-audit/template-media-local-query.json`.
- Web: 753 files / 5,367 tests pass. Mobile: 186 files / 1,802 tests pass. Web app,
  web test, script and mobile typechecks pass; focused lint passes. Production web
  build and ffmpeg/libvips artifact verification pass. Android/iOS production
  exports and bundled client configuration checks pass. The first build caught a
  type error in the ignored local query harness; that harness was corrected before
  the successful rebuild. Regression tests cover
  ownership/run/source mismatches, pending/foreign rendition paths, batch
  deduplication, legacy API compatibility and exact-output poster reuse.

Remaining: catalog/demo media, explicit input editor players, shared workflow
consumers, true template long-session expiry/renewal, physical-device performance
and the remaining surface matrix. This checkpoint does not close the whole-app audit.


## Template demo and workflow input-editor recovery

Status: fixed locally, not deployed. No schema or migration change.

Three service regression cases failed before this change:
`output/media-audit/template-demo-before.log`. The catalog DTO used nullish
fallback after media signing; an explicit rejection (signing failure or a demo
outside the active version) therefore returned the raw stored path anyway. It
now preserves the resolver's null result. Both clients consume a shared null-media
fixture in `contracts/template-run-media-v1.json`. The template publish poster
writer still passed a Buffer to Storage; it now uses the existing Blob upload
helper, matching the repaired background poster writer. A local real-Storage
readback produced an identical 7,712-byte WebP that fully decoded at 343 × 720;
the temporary poster was removed. Receipt:
`output/media-audit/template-demo-poster-readback.json`. This does not repair
previously published corrupt posters automatically.

Chromium reproduced a demo HTTP 403 with media error 4, readyState 0 and no Retry.
The video input editor similarly showed only an empty native controls player after
HTTP 503. Both now use a shared inline video component with visible loading,
30-second timeout, explicit Reload video and cancellation on unmount/source
replacement. Initial load and web Retry remain paused; preload is metadata.
Demo Retry re-reads the template through its existing public/owner catalog route
and checks template identity before accepting a fresh URL/poster. The input editor
retries its canonical media proxy/direct input URL, without invoking generation.
The editor admits storagePath-only inputs and unmounts its player on close.

Browser acceptance:

- Failed demo renewed to a fresh URL and decoded (readyState 4, width 320), staying
  paused. At 390px viewport width there was no horizontal overflow and native
  controls remained visible. Screenshot: `output/playwright/template-demo-mobile-web.png`.
- Failed input loaded after explicit Reload video and decoded while paused/muted.
  Escape closed the editor and left zero video elements. Screenshot:
  `output/playwright/editor-recovery.png`.
- Browser verification found a cancellation race during React Strict Mode's
  discarded renewal. A regression test failed, then passed after inactive/aborted
  attempts were prevented from changing the next attempt's error state. The
  development fixture makes two GET attempts because of Strict Mode; the discarded
  request is aborted. Retry never starts a paid operation.
- Native Android and iOS template-detail fixtures began with an HTTP 403, then
  Retry fetched fresh template metadata and decoded the replacement video.
  API counter changed from one initial read to two total reads; the existing
  explicit native Retry behavior starts playback. Back removed the active demo
  player. Screenshots: `output/media-audit/template-demo-recovery-android.png` and
  `template-demo-recovery-ios.png`. Responses/media were local synthetic fixtures;
  this does not certify production signing or physical-device performance.
  Development bundles were reloaded to clear temporary API overrides.

Scope limits: template demos still use the published demo file; this change does
not transcode/backfill every existing demo or add a durable demo rendition worker.
Catalog poster failure/reconnect, null-demo refresh UI and existing corrupt-poster
repair are still open. The input editor's arbitrary external signed URLs can be
retried but cannot be renewed without an owning service; durable Storage paths use
the canonical authenticated media proxy. Full upload/publish execution, shared
workflows and physical-device budgets remain separate audit work.


Validation for this demo/editor checkpoint: web 755 files / 5,376 tests pass;
mobile 186 files / 1,803 tests pass. Web app/test/script and mobile typechecks,
focused lint, production web build, ffmpeg/libvips artifact checks, Android/iOS
production exports and bundled configuration checks pass. The first concurrent
suite runs had unrelated workflow/composer/icon test timeouts; those passed on
isolated rerun and the final complete suites passed with bounded worker counts.
The stylesheet closure test found the new component missing from the explicit
Tailwind source list; the source entry was added before final checks. No test
thresholds or timeouts were relaxed.

## Published demo size and catalog poster recovery

Status: fixed locally; not deployed. No new schema or migration.

New video-template publication now tries the existing H.264/AAC fast-start
playback encoder before storing the version's demo. This is restricted to demo
copies at most 64 MiB, with a 60-second cancellation deadline within the existing
300-second publish route budget. The encoder only retains copies at least 15%
smaller. Already-lean media, oversized inputs and encoder failures keep the
original demo copy; expected size skips do not emit backend errors. Fixed workflow
inputs and source generation files retain their original bytes. The demo poster
is derived from the file actually published. Existing version activation and
rollback still own the copied paths; the API and stored demo field are unchanged.

Two regression assertions first failed because the copy helper stored the source
unchanged and never invoked the bounded encoder. Tests now cover MP4 naming and
exact Blob bytes, cancellation signal, fallback, the size cap, fixed-input
preservation and foreign-owner rejection. Real local Storage validation used the
existing synthetic original: 1,790,943 bytes became 150,439 bytes (91.60% smaller).
Readback was byte-identical, full ffmpeg decode succeeded, the moov atom precedes
mdat, a signed range read returned 206, and source readback remained identical.
The temporary demo object was removed. Receipt:
`output/media-audit/template-demo-optimized-readback.json`. This is a controlled
fixture, not a production bandwidth/latency benchmark.

Catalog reproduction and recovery:

- Chromium's real owner catalog rendered two video elements with rejected poster
  URLs and no recovery action. Cards now use lazy still images, keep an icon
  underneath loading media, and show the fallback when an image fails. A shared
  Reload previews action renews only failed IDs, preserves other catalog entries
  and pagination, limits concurrency to four, deduplicates repeated actions, and
  cancels at 30 seconds or unmount/token replacement. The online event uses the
  same bounded path. Failed URLs can retry even when signing returns the same URL.
- In Chromium, two failed cards recovered through two template GETs, decoded at
  width 320 and left zero video players. A separate controlled online event
  recovered unchanged image URLs. At 390px width there was no horizontal overflow.
  `output/playwright/catalog-poster-recovered.png` records the result. These are
  controlled HTTP failures/reconnect events, not a physical network-outage test.
- Android Pixel_9a and iOS iPhone 17 Pro reproduced HTTP-403 posters with blank
  tiles and no image error handler. Native cards now retain an icon and provide a
  shared Reload previews control outside the card's navigation target. It refetches
  the catalog once and remounts images on fresh query data, including unchanged
  URLs. Existing cards remain visible if this refetch fails. On each platform,
  invoking the rendered Reload previews handler renewed the poster, produced an
  HTTP 200 and visibly decoded the fixture image; the control disappeared after
  success. Android's metadata counter advanced 1 → 2; iOS's 2 → 3 (Fast Refresh had
  caused its extra initial query). Screenshots: `output/media-audit/catalog-android-after.png`
  and `catalog-ios-after.png`. Synthetic API overrides were cleared by reloading
  the development bundles. This does not certify production binary performance.
- A hook regression reproduced loss of a newly failed card while an older batch
  was renewing. The completed batch now preserves newly reported failures. Other
  tests cover concurrency, deduplication, wrong-template responses, unchanged URLs,
  deadline and unmount cancellation. No automatic per-image retry loop is added.

Scope limits: this optimizes future published versions; immutable existing demos
have not been backfilled or replaced. There is no durable demo optimization queue,
and optional inline work can add up to 60 seconds to publish. Source download,
Storage upload and existing poster extraction retain their earlier bounds. Full
upload/test/publish execution, legacy corrupt-poster repair, null-media refresh UI,
long offline/background expiry, shared workflows and viewport player ownership
remain open. This checkpoint adds no migration; the earlier private-playback
migration still awaits the coordinated release.

Validation: the final complete web suite passes 757 files / 5,387 tests, and the
mobile suite passes 186 files / 1,803 tests. Web app/test/script and mobile
typechecks, focused lint, production web build and ffmpeg/libvips artifact checks
pass. Android/iOS production exports and bundled-environment checks pass. The
first web run found the new hook missing from the explicit stylesheet source
closure; that entry was added. A concurrent export/test run then hit the existing
5-second workflow/composer test limits; the final complete run without the
competing export/build passed without relaxing test limits. Logs:
`output/media-audit/catalog-{web-final,mobile-final,checks-final,build-final,export}.log`.

## Shared-workflow boundary and web inline playback ownership

Status: locally verified web fixes; not deployed. No API, schema or mobile code
change in this checkpoint.

Shared workflow links are structure imports, not shared-media viewers. The create
service uses `createWorkflowShareSnapshotGraph`; an eight-node-kind local fixture
(image/video/audio inputs, image/video/motion/voiceover outputs and approval)
retained no injected private media URLs, storage paths or generation-output
bindings. Existing create/import tests pass, and video/audio input removal now has
explicit regression coverage. Chromium's actual import preview showed the media
removal notice and zero video/audio players using that sanitized fixture.
`output/media-audit/shared-media-snapshot.json` and
`output/playwright/shared-media-preview.js` record the controlled input. No share
storage/access behavior was changed. This does not certify arbitrary historical
share rows or provider asset identifiers; a full share-create/import journey and
native handling of links remain outside this check.

Two web rendering defects reproduced before changes:

- A real template-detail demo player continued playing after its bounding box was
  entirely above the viewport. The fixture used a 390 × 700 browser and appended
  a spacer to make scrolling beyond the demo deterministic.
- Two real template approval-step players on the same run page were both playing
  after starting them sequentially. This allows overlapping playback and decoding.

`InlineMediaVideo` now supplies one playback owner among its mounted inline
previews. Starting another pauses the previous preview. IntersectionObserver
pauses a preview when it no longer intersects the viewport, and visibilitychange
pauses it when the document is hidden. Play events also check current visibility,
including the latest observer state, so delayed autoplay cannot restart a clipped
preview. Returning to view never starts playback. Unmount pauses and removes the
observer/listeners. Explicit picture-in-picture remains allowed across viewport
and visibility changes; leaving it reapplies the pause policy (unit coverage only,
not a browser PiP acceptance claim). Fullscreen/native controls stay on the video.

The shared component is used by template demos, final/intermediate results,
template input previews, workflow input-editor previews and generation-result
players (including expanded workflow video/motion outputs). Existing source
renewal, posters, rendition selection, controls and original-download selection
are preserved. Unrelated feed/fullscreen players have not been enrolled in this
inline group and retain their own playback policies.

Browser acceptance on controlled API/video fixtures:

- Demo after scrolling out: `playingInitially=true`, `offscreen=true`,
  `stillPlaying=false`. Repeated after the final observer-state adjustment.
- Two approval videos after sequential play: `[false, true]`, versus `[true, true]`
  before the change. Repeated against the final code.
- Final result: pauses completely offscreen and remains paused on return. A
  controlled `document.hidden`/visibilitychange event paused playback and left it
  paused when restored. Actual tab switching in this automation harness continued
  reporting `visible`, including after disabling CDP focus emulation. That is not
  counted as a successful real-background test; it remains open.
- Expanded generated workflow output and the input editor both played a valid
  fixture; Escape left zero players for each. The generation output still used
  its resolved playback rendition. The workflow canvas itself had no video players
  before opening a preview.

Six component regressions cover ownership, offscreen/hidden pause, no return
resume, cleanup, explicit PiP and delayed playback inside clipped scroll parents.
The last case first failed, then passed after retaining the observer's visibility
state. Runtime fixture files are in `output/playwright/*viewport*.js` and
`workflow-playback-lifecycle.js`. These are local correctness checks, not network
transfer, memory or physical-device performance measurements. Pausing can still
leave already-requested browser buffering in progress; this change does not claim
that offscreen bytes or decoded buffers drop to zero.

Remaining work: native viewport ownership and simultaneous inline players, real
background transitions, viewport budgeting for other renderer families, legacy
demo/poster backfill, long offline/expiry, and the full share/import journey. No
new migration is needed; earlier unreleased migrations still follow the planned
coordinated release.

Validation: all 758 web test files / 5,395 tests pass. App/test/script typechecks,
focused lint, production build and ffmpeg/libvips artifact checks pass. Logs:
`output/media-audit/viewport-web-final.log`, `viewport-checks.log` and
`viewport-build-final.log`. No mobile files or contracts changed, so native
builds/tests were not repeated for this web-only checkpoint. The temporary
Chromium session and Next development server were closed before the build.


## Native offscreen ownership and real transport recovery (2026-09-06)

Scope: shared `RecoverableVideoPreview`, used by template demos, `MediaPreview`
and `MediaLightbox`, plus the common `Screen` scroll container. This checkpoint
does not enroll feed/viewer/audio players or change API, storage or contracts.

Reproduction used running SDK 55 development clients on the Android Pixel 9a
emulator and iOS iPhone 17 Pro simulator. Template metadata was overridden in
memory through Metro inspector; actual native players fetched local MP4 fixtures.
The real template detail screen's description was extended to make full offscreen
scrolling deterministic. Both platforms continued playing after scrolling past
the demo. A second fixture mounted two actual recoverable previews in the detail
screen; both played simultaneously before the change.

The shared hook now measures playing previews against the `Screen` scroll viewport
and window. Scroll/layout/dimension events trigger checks, with concurrent native
measurements coalesced and no per-player polling. Fully clipped playback pauses;
scrolling back does not start it. Starting another enrolled player pauses the
previous one. App-state change pauses playback and background play requests are
rejected; Android notification blur also pauses. Native fullscreen bypasses inline
clipping until exit. A native screenshot caught an initial unguarded Android-only
blur subscription on iOS; it was corrected with a Platform guard, covered by a
regression test and the final iOS screen was reloaded and visually verified.

Final native observations:

- Both real demo players were `readyToPlay` and playing before scrolling. Once
  fully offscreen, each reported `playing=false`; returning to the top without a
  play request left it false. Screenshots confirm the player was out of view.
- The two-preview fixture changed from `[true, true]` to `[false, true]` on both
  platforms. Retained screens were separately identified and remained paused.
- Android Home and iOS switching to Settings stopped the active player. Returning
  to the app left every retained preview paused. This is actual app switching,
  not a manually dispatched AppState event. Expanding the Android notification
  drawer also paused the playing preview. Short background duration only.
- A local transport server on port 8774 accepted real connections and sent no
  headers/body. Before the timeout change, iOS stayed loading for over a minute
  (eventually reporting a native error); Android also spent tens of seconds
  retrying the transport. This reproduced a loading gap, not an infinite hang.
- Loading/idle phases now have a 30-second budget. Expiry pauses playback, clears
  the source asynchronously and shows the existing Retry UI. Retry remounts a
  fresh player and uses the existing renewal callback. Ready playback cancels the
  deadline. A failing timer regression preceded this fix.
- Final iOS cold stall displayed `Retry video` even while the native player still
  reported loading. After the server resumed and explicit Retry, the new player
  reported `readyToPlay`, duration 40 seconds and `playing=true`; a screenshot
  confirms the decoded test pattern. This is real stalled transport, not iOS
  radio-off testing or signed-credential expiry.
- Android was placed in airplane mode with Wi-Fi and mobile data disabled;
  connectivity reported no active default network. A fresh, uncached media URL
  showed Retry. Restoring the original radio settings and invoking Retry produced
  a playing 40-second video, visually confirmed. API metadata came from the local
  fixture, so this proves media recovery rather than whole-app offline navigation.

Evidence under ignored `output/media-audit/`: `native-viewport-setup.js`,
`native-viewport-state.js`, `native-viewport-play-scroll.js`,
`native-viewport-top-only.js`, `native-viewport-competitors.js`,
`native-network-server.cjs`, `native-network-setup.js`, `native-offline-schedule.js`,
`native-viewport-{ios,android}-{before,after}.png`,
`native-network-android-offline.png`, `native-network-ios-stalled.png` and
`native-network-{ios,android}-recovered.png`. Fixtures are not shipped or written
to production. Pausing does not prove zero buffered bytes or freed decoder memory.
Native fullscreen behavior has regression coverage; a real fullscreen round-trip
has not been certified in this checkpoint.

Validation: 188 mobile test files / 1,812 tests pass, as does the mobile typecheck.
Both Android and iOS production exports pass and their bundled-client environment
checks report no problems. Logs: `native-viewport-mobile-final.log` and
`native-viewport-export.log`. Web tests/build were not repeated for mobile-only
changes. No migration, remote push, OTA or deployment was performed.

Remaining audit: long-session expiry during playback/background, physical iOS
radio-off recovery, physical-device transfer/memory/battery budgets, remaining
renderer families and the full share/import journey, plus legacy demo/poster
backfill. The whole-app audit remains open.


## Fullscreen viewer expiry continuity and native player inventory (2026-09-06)

The remaining native player constructors are `FeedVideoPlayerLayer`,
`ActiveVideoAttempt` in the fullscreen viewer and the already audited shared
`RecoverableVideoPreview`. Native audio references use external opening; the
reference open handler resolves their file URL again before handing it off.
There is no native expo-audio/expo-av audio player in these app sources.

### Real signature expiry and background interval

A local-only server uploaded isolated 40-second MP4 fixtures into the private
`generated_videos` bucket of the Docker audit stack and requested real Storage
signatures lasting 75 seconds. Native metadata/session fixtures were installed in
memory through Metro. The existing `useMediaSource` hook and native video players
were real; local env origins and a fixed local-only authorization token directed
the replacement `/api/media` request to a fixture signing server. That server
accepted only its own generated paths and issued fresh 300-second Storage links.
No production auth, signing, database or Storage was changed. This fixture tests
client continuity at a real signature boundary; it does not certify the production
proxy or production account/session expiry. The documented signing API uses an
expiry duration in seconds: https://supabase.com/docs/reference/javascript/file-buckets-createsignedurl.

Before the fix, an iOS viewer paused at 23 seconds started playing from zero after
the existing 30-second-early-renewal boundary recreated its player. The viewer's
player effect requested autoplay for every replacement. Native inspection also
showed that setting playbackRate after pause can start AVPlayer, so test setup and
restoration apply the play/pause decision after other settings.

`restoreVideoPlayback` now copies the previous player's time, mute, volume and rate
before applying its play/pause decision, gated by reduced motion and app state.
The viewer no longer unconditionally autoplays every replacement. Explicit Retry
still remounts the attempt and starts a new player. Player replacement also resets
first-frame/error state, so an old frame does not suppress a new loading poster.
The background subscription pauses the current player and return does not resume.

Final continuity evidence:

- iOS stayed paused at exactly 23 seconds across the renewal boundary; its native
  player was ready and its screenshot showed a decoded frame with the play badge.
- Android samples advanced from 15.06 through 35.13 seconds, looped at the normal
  40-second end and continued through renewal. Renewal requests occurred about
  48 seconds after fixture creation; iOS renewed at about 44.6 seconds.
- Fresh sessions spent roughly 20 minutes backgrounded. Android returned paused
  at 23 seconds and iOS at 15.312 seconds. Explicit Play resumed both at those
  positions, confirmed by native state and decoded-frame screenshots.
- Android's fresh proxy request happened about 1,243.5 seconds after fixture
  creation, on return; iOS's happened at about 44.8 seconds while backgrounded.
  Multiple proxy requests included byte ranges; these are native range reads,
  not repeated app-level renewal timers. No request-storm performance claim.
- Original signatures that initially returned HTTP 206 later returned HTTP 400
  after their lifetime. The local error text did not match the word “expired”;
  the receipt's `expired:false` is that text check, not a still-valid signature.
  No multi-hour production-lifetime or physical-device certification is implied.

Evidence: ignored `output/media-audit/long-expiry-server.cjs`,
`native-long-expiry-viewer.js`, `long-expiry-receipts.json`,
`long-expiry-storage-rejections.json`, `long-expiry-android-playing.json`,
`long-expiry-ios-paused.json`, `long-expiry-ios-paused-after.png` and
`long-expiry-{android,ios}-background-after.png`. The video repeats a short visible
pattern within the 40-second file; the burned-in pattern time is not the player's
40-second media clock. Native player measurements establish position continuity.

### Remaining native loading and feed checks

On both platforms a real `FeedVideoPreview` played the server-selected stream,
and deactivation removed every native VideoView. Its existing policy retains
posters, limits activation through parent viewability, prefers eight seconds of
forward buffer and pauses before delayed player release. A stalled TCP fixture
produced native error fallback, rather than an app retry loop. These are component
fixture checks; a full feed-scroll/memory stress certificate remains open.

The fullscreen viewer's stalled TCP request on Android retried at approximately
10/21/33 seconds before eventually reporting a native error. It previously had no
loading indicator/deadline of its own. It now shares the existing recoverable
preview's 30-second deadline through `useVideoLoadDeadline`, pauses and clears the
stalled transport, and presents its existing Retry action. Loading also has an
accessible spinner. Native errors that happen sooner still show Retry immediately.
On iOS the native error arrived sooner in this run, so its retry acceptance is not
claimed as a timer-expiry measurement. Explicit retries produced ready 40-second
players on both platforms after the transport recovered.

Four playback-state regressions and three deadline regressions cover pause/position,
manual playback, blocked playback, initial autoplay, timeout, ready cancellation,
replacement budgets and unmount cleanup. Existing recoverable-preview deadline
and retry tests remain green after factoring out the shared hook.

Remaining web inventory: composer uploads/lightbox, marketplace and resource-bundle
players, showcase carousel/resource viewer, CreatorStudio/modal players and audio
controls in workflow nodes/editors/overlays, creation outputs and reference panels.
These have not been enrolled automatically in the inline-video ownership group.
Native physical-device budgets, production-duration session expiry, legacy demo/
poster backfill and full share/import/unlock journeys also remain open.


Final checks: 190 mobile test files / 1,819 tests pass, mobile typecheck passes,
and both production exports plus bundled-client environment checks pass. Logs:
`long-expiry-mobile-final.log`, `long-expiry-export.log`. The final Android
stalled-load check was repeated after force-stopping/relaunching the development
client because an earlier hot-reloaded session had a blank screenshot despite
its React/native state. The clean launch visibly showed Retry with the source
cleared (`idle`), then playback was rechecked after explicit Retry. The earlier
blank development snapshot is not counted as passing visual evidence or assigned
a production root cause. Evidence: `viewer-stall-android-loading-clean.png` and
`viewer-stall-ios-recovered.png`; the loading-clean screenshot actually captures
the timeout/Retry state.

No new migration is needed. No production deployment, OTA, remote push or release
was performed. Web tests/build were not repeated for these native-only changes.

The clean Android retry rendered the decoded 40-second fixture and reported
`readyToPlay`, `playing=true` at 17.39 seconds; screenshot:
`viewer-stall-android-recovered-clean.png`. iOS feed reactivation after its native
error rendered again (`feed-ios-reactivated.png`). Final post-indicator typecheck
and 47 focused regressions pass in `long-expiry-final-focused.log`.


## Remaining web audio and controlled video ownership (2026-09-06)

### Reproduced defects and change

Real Chromium playback of local MP4/WAV fixtures through the actual workflow,
composer and resource/detail components reproduced three ownership defects:

- Two workflow node audio controls could play together. Opening and playing an
  audio editor left both node players running (three concurrent audio streams).
- A resource video and audio could play together; opening audio details left
  the resource video running underneath the modal.
- In a 390×700 composer viewport, video continued playing with bounds top -1131
  and bottom -844.5, completely outside the scrolled editor viewport.

Factored the existing InlineMediaVideo policy into useInlineMediaPlayback with a
single HTMLMediaElement registry and added InlineMediaAudio. Starting an enrolled
player pauses the others; viewport/document departure and unmount pause playback.
Viewport/document return and closing an expanded preview never resume the previous
player automatically. Audio defaults to preload none; explicit video
picture-in-picture retains the existing offscreen/background exception.

Integrated audio controls in workflow nodes/editors/overlays, creation outputs,
video-generation references, resource panels/reel resources and media details.
Integrated controlled video in composer previews/lightbox, video-generation
references, resource panels/reel resources and media details. Existing template
and recoverable inline videos share the same registry. Public/private CSS source
lists were updated for the new shared component import closure.

### Acceptance evidence and limits

The same workflow fixture now reports only the newly played node active and,
with the editor playing, both node players paused. Closing the editor leaves both
nodes paused. Resource video pauses resource audio; opening/playing details pauses
the resource video; opening the secondary audio preview pauses the primary modal.
Closing the expanded preview leaves all remaining players paused. Composer video
now pauses at the same fully offscreen bounds and stays paused on return.

Ignored evidence under output/playwright: workflow-audio-final.log,
workflow-audio-close-final.log, composer-player-final.log,
composer-player-return-final.log, resource-player-final.log,
resource-dialog-open-final.log and resource-dialog-final.log. Fixture setup and
acceptance scripts live alongside them. API/media routes use synthetic responses
and local fixtures; resource checks do not certify a purchase/unlock journey.
The temporary component fixture route was removed; its source is preserved only
as output/media-audit/resource-player-fixture.tsx.txt.

The attempted workflow pan did not actually move audio offscreen and is not a
runtime offscreen-audio pass. Three new regressions cover cross audio/video
ownership, clipping/no-return-resume/default preload, and hidden-document/cleanup;
the existing six inline-video tests still pass. Browser tab switching kept
reporting document.visibilityState visible in this automation session, so real
background acceptance is unverified (player-hidden-final.log). Synthetic hidden
visibility events pass; they are not counted as real background evidence.

Remaining raw player inventory: CreatorStudio uploaded video and preview modal;
HoverVideo (hover/near-viewport/reduced-motion/save-data policy); and
ShowcaseMediaCarousel (feed/detail activation and source policy). These need their
own runtime audit. Raw videos in MediaDetailsPreviewModal/CreationMediaFrame are
passive metadata thumbnails; MarketplaceBootstrap's video has a poster and no
source. They were not converted into active previews. Resource Open file/Download
already obtains a fresh URL, but inline resource/audio source renewal, actual
expiry/offline recovery and loading/error UI remain open. No claim of complete
web or app-wide optimization is made by this checkpoint.

A static search also found three detached video metadata probes (composer,
workflow input editor and motion reference), with no new Audio/AudioContext player
constructors under src/app or src/lib. These probes do not play media. Composer
already has a deadline and object-URL cleanup. The workflow duration Promise has
load/error cleanup but no deadline; motion cleans up on effect teardown but has
no metadata deadline. Stalled-probe behavior remains a follow-up to reproduce,
not a runtime-confirmed defect in this checkpoint.

Final validation: 759 web test files / 5,398 tests pass with four workers; app,
script and test typechecks pass; production build and build:verify pass (FFmpeg
resolves in all 9 required routes; libvips is traced in all 38 sharp-using bundles).
The earlier default-worker repeat had one unrelated generation-services test hit
its 5-second timeout; that file then passed all 91 tests in isolation and the
complete four-worker run passed. No timeout threshold or application behavior was
changed to obtain the pass. An earlier 5,405-test run included unrelated upload
work temporarily present in this checkout and is not this checkpoint's count.

Application lint passes with `npm run lint -- --ignore-pattern "output/**"`.
The bare lint command includes git-ignored audit harnesses and reports script
style violations there; no lint rule or repository config was relaxed. Final logs
under output/media-audit: remaining-player-verification-final.log,
remaining-player-stable-build.log and remaining-player-generation-recheck.log.
The temporary dev server was stopped before building. No mobile runtime code
changed, so mobile tests/exports were not repeated. No new migration, deployment,
OTA or remote push was performed for this checkpoint.


## Studio, hover/carousel and resource recovery (2026-09-07)

### Reproduction and changes

Chromium component fixtures reproduced Studio's upload thumbnail and expanded
modal playing together, and its thumbnail playing entirely offscreen. HoverVideo
and detail-mode ShowcaseMediaCarousel also kept playing with the full video frame
above the viewport (bottom -100px). Studio now uses InlineMediaVideo; carousel and
hover use the shared hook with their existing element refs. The shared registry
coordinates their ownership with other enrolled audio/video. Existing carousel
source, feed activation, rendition and error/retry policies are preserved.

HoverVideo's 320px near-viewport activation was replaced by actual intersection
and document visibility. Hidden/offscreen decorative videos detach their source;
visible decorative autoplay may resume, subject to reduced-motion/data-saver
preferences. Controlled Studio/carousel previews stay paused on return. This is a
policy distinction, not a claim that all decorative previews remain paused.

PostResourceBundlePanel and ShowcaseReelViewer resource players retained stale
signed URLs with no inline Reload action. Controlled 403 responses reproduced
failed video/audio controls without recovery UI. New ResourceMediaPreview shares
inline ownership and presents loading, error and Reload. Each explicit attempt
uses the existing authorized signing endpoint, preserving bearer headers and
post/resource scope. Signing and active media loading have a 30-second deadline;
timeout aborts signing and removes the failed player. Late ready events cannot
clear the terminal error. Audio uses preload none and does not time out while
idle; retry remains paused. No background renewal/retry loop or authorization
change was introduced. Image previews and attachment links keep their old paths.

### Real browser and transport acceptance

- Studio modal playback pauses the upload thumbnail; close leaves it paused.
  Fully offscreen thumbnail playback pauses and stays paused after scrolling back.
- Hover stops and detaches its source with bottom -100px. Detail carousel pauses
  at the same offscreen boundary. Existing focused feed activation tests pass.
- Resource audio/video recover from rejected URLs after explicit Reload. Starting
  recovered audio pauses the recovered resource video.
- Local private generation_inputs Storage supplied three-second signatures. A
  fresh range request returned 206; after 4.5 seconds Storage returned 400
  InvalidJWT with `"exp" claim timestamp check failed`. Idle audio failed after
  elapsed expiry; video was given a genuinely expired URL after delayed signing
  response delivery. Both showed Reload and played after renewed 300-second URLs.
  The initial fixture regex searched only for “expired” and returned false for
  Storage's “exp” message; inspect-storage-expiry.log records the actual response.
  This is elapsed shortened local expiry, not production-duration session expiry.
- With browser networking offline and no signing-route override, both resource
  types showed Reload. After network restoration and a local signing response,
  explicit retry played actual private Storage audio and a 320px-wide video.
- A signing response withheld for 32 seconds showed both Reload controls at
  approximately 30,502ms. Explicit retry played audio. The narrow viewport
  screenshot shows the shared error UI; controls remain scrollable/reachable.

Ignored scripts and logs under output/playwright: lifecycle-before.log,
lifecycle-scroll-before.log, lifecycle-scroll-after.log, studio-after.log,
resource-expiry-before.log, resource-expiry-after.log,
resource-real-expiry-proof.log, resource-real-video-expiry.log,
inspect-storage-expiry.log, resource-offline-signing.log, resource-stall.log and
resource-stall-retry.png. The private Storage fixture server is
output/media-audit/web-resource-expiry-server.cjs. It only uses the local audit
Docker stack; service-role credentials never enter browser code or evidence.
Development Strict Mode starts/aborts a duplicate effect request per attempt;
fixture request counts include these, not repeated automatic recovery.

### Real background evidence and remaining boundaries

The default Playwright session reported visible even after tab switch/minimize.
A separate temporary Chrome profile launched with ordinary browser flags and
connected using connectOverCDP(noDefaults: true) removed the focus override.
Actual tab switching then emitted hidden/visible events. Studio and detail
carousel paused while hidden and stayed paused on return; resource audio did the
same. Hover detached while hidden and resumed decorative autoplay when visible.
Evidence: output/playwright/real-background.cjs, real-background-final.log and
real-background-results.json. No synthetic visibility event is counted as this
acceptance. These are Chrome checks; physical mobile Safari/Chrome background
behavior is not certified by them.

The fixture route was removed before final tests/build; its source is preserved
only as output/media-audit/lifecycle-fixture.tsx.txt. Full reel navigation/unlock
and share/import journeys, resource-image/attachment URL recovery, detached
metadata-probe deadlines, legacy backfills, and physical-device transfer/memory
budgets remain open. Reel resource wiring is covered by shared component behavior
and repository regressions, not a complete live purchase/reel walkthrough.


Audio outside resource bundles (for example creation outputs and workflow node
sources) shares playback ownership from the previous checkpoint but has not been
converted to this new signed-resource resolver. Its source-specific renewal still
needs separate coverage. The recovery component does not silently substitute a
public URL, broaden access, or start a generation.

Final validation: 760 web test files / 5,404 tests pass (four workers), all three
web typechecks pass, and application lint passes with git-ignored `output/**`
audit scripts excluded. Production build and build:verify pass: FFmpeg is traced
by 51 server bundles and resolves in all 9 required routes; libvips is present in
all 38 sharp-using bundles. Logs: output/media-audit/lifecycle-web-tests-final.log,
lifecycle-quality-final.log and lifecycle-build-final.log. Six new regressions
cover hover visibility, controlled carousel pause, resource renewal, stalled
signing/unmount cancellation, idle audio versus stalled playback, and video-ready
cancellation/signing failure. Existing recovery and resource access tests pass.

The local fixture server was stopped and removes its two uploaded objects on
shutdown. Temporary browser profiles and ignored evidence remain local. No mobile
runtime code changed, so native tests/exports were not repeated. No migration,
production deployment, OTA or remote push was performed.


## Metadata probes, images/attachments and non-resource audio (2026-09-07)

### Reproductions and resulting behavior

A Chromium fixture called the actual workflow metadata reader with an uploaded
MP4, redirecting only its detached media element's source to a withheld network
response. After six seconds the caller still displayed Reading metadata. This
controlled transport exercised real browser media loading; it did not synthesize
metadata/error events or replace the reader. Resource image failure simultaneously
showed naturalWidth 0 without Reload, and the real MediaDetails audio control
reported media error 4 with no recovery action.

WorkflowNodeEditors, CreateMotionClient and NewPostClient now use
video-metadata-probe.ts. The shared metadata-only reader settles within four
seconds, returns null for unknown/unsupported duration, removes listeners and
source, resets the element and revokes its owned object URL. An AbortSignal
cancels a replaced/unmounted motion probe. Composer retains its existing four-
second behavior and server-authoritative validation. The workflow upload can
continue with unknown duration; motion presents its existing unreadable-reference
message. A normal local MP4 still returns 40 seconds; withheld transport settled
in approximately 4,319ms. The complete motion authoring/upload journey was not
replayed; its new helper and cancellation are separately covered.

ResourceMediaPreview now supports images. PostResourceBundlePanel no longer keeps
an image-only signed-URL cache: visible images use bounded signing/loading and
explicit Reload. Reel thumbnails and expanded references use the same component,
including source-specific renewal when the expanded image fails. The image Open
button receives the currently recovered URL. Retry never changes the resource
scope or permission endpoint.

The actual previous-commit ShowcaseReelViewer, copied only for a temporary local
comparison, reproduced a stale attachment: after the signing fixture offered a
fresh URL, Open still navigated to /expired-guide and the browser received the
expired-signature response; zero renewal requests occurred. Its reference image
was also broken (naturalWidth 0). The changed reel recovered the image and opened
its expanded 320px-wide preview. Two attachment clicks then signed twice and
opened two distinct fresh URLs. ResourceFileLink reserves a blank tab within the
click gesture, clears window.opener before navigation, accepts HTTP(S) results
from the authorized signer, closes failures and obsolete tabs, and bounds signing
at 30 seconds. A blocked popup displays an actionable message without caching a
stale fallback link. Post-detail Open/Download already sign on demand; they were
not replaced with a cached link.

RecoverableMediaAudio now covers MediaDetails primary/expanded audio, creation
cards, workflow nodes/editors/overlays, and video-generation references. It uses
the existing media recovery state machine and playback ownership. Initial
user-opened autoplay is preserved; Reload does not autoplay. An expired stored
URL retries via getDisplayMediaUrl's existing authenticated /api/media route.
Already proxied audio retries the proxy. Its existing redirect may be cached for
60 seconds, versus a 600-second signature lifetime; retry is not a guarantee of
a new signing request within that cache window. Provider/external/blob URLs without a
stored identity retry unchanged, so unavailable remote originals are not claimed
repaired. Creation audio no longer downloads idle metadata or leaves an overlay
spinner over idle controls; its Restore preview action is retained on failure.

### Evidence and scope

Ignored output/playwright evidence: probes-before.log, probes-after.log,
probe-normal.log, audio-proxy-recovery.log, attachment-after.log,
reel-renewal-before.log and reel-renewal-after.log. The stored-audio failure check
observed exactly one /api/media request after explicit Play, with canonical bucket
and path, paused state after Reload and successful audio playback. It uses
controlled signed-source rejection and a media-route fixture; it is not an
additional production-auth or elapsed-signature certificate. Previous-checkpoint
real local Storage expiry evidence remains separately recorded.

The reel checks rendered both old and changed actual components with synthetic
public recipe data, not a purchase or real entitlement mutation. The temporary
comparison component and fixture route were removed before final checks. The
fixture source is preserved only as output/media-audit/probes-fixture.tsx.txt.
No production data or credentials were changed. Full purchased-bundle navigation,
share/import flows, provider-original loss recovery, long production sessions and
physical-device transfer/startup/memory measurements remain separate audit work.

Final validation: all 763 web test files / 5,414 tests pass. The workflow metadata
mock was then narrowed to TypeScript's CanPlayTypeResult literal and its 25 tests
passed again. All three web typechecks, application lint (excluding git-ignored
output/** audit fixtures), production build and build:verify pass. FFmpeg is
traced by 51 server bundles and resolves in all 9 required routes; libvips is
present in all 38 sharp-using route bundles. Logs:
output/media-audit/probes-stable-final.log (full suite) and
output/media-audit/probes-quality-stable.log (final focused test and quality gates).
No mobile runtime code changed, so native tests/exports were not repeated.
No migration, production deployment, OTA or remote push was performed.

## Complete browser journeys and first physical Android baseline (2026-09-07)

### Purchased recipes were offered for purchase again in the reel

Reproduced in Chromium with real local Supabase Auth, Postgres and private
Storage: a second account bought a local $1 recipe with 100 fixture credits on
its detail page. The detail page revealed the image, video and audio, but opening
/showcase?post=... offered Unlock for $1.00 twice and rendered zero resource
images. The reel's restore effect explicitly skipped paid bundles. This was a
client presentation/access-refresh failure; no duplicate charge was established.

The effect now rechecks the existing authorized bundle endpoint for paid as well
as free bundles. The same buyer returns to a 320px resource image, one video and
one audio control, with no Unlock button or new checkout. An unpurchased account
still receives 403 and no signed URL; the buyer receives 200 and a signed URL.
Final database readback has exactly one paid receipt. The credit purchase reduced
100 fixture credits to zero; the free-fixture setup later replenished 100 for the
remaining checks, and free unlock/reentry left that balance unchanged.

A concurrent task switched the original checkout from the media branch to an
older SEO branch during this session. Its unrelated edits were preserved; only
this audit's two-file patch was moved to /private/tmp/magicbooklet-media-journeys,
on fix/private-video-delivery at 8aae538. The paid failure and recovery were
repeated there by temporarily reversing/reapplying the source patch. Share/import,
free unlock, reel playback, downloads and access readback were repeated there.
The earlier detail-page credit action establishes a real local purchase, but its
checkout state was not pinned and is not an exact-build certificate.

### Real local journeys

- Workflow: owner opens a saved canvas containing real private uploaded image
  and audio references, clicks Share and Copy link; buyer opens the import
  preview, imports and reloads the new private draft. The instructions persist,
  both storage paths and media URLs are null, run outputs are null, and the
  imported canvas renders zero media elements. The dev-generated localhost
  origin was changed to 127.0.0.1 to reuse the local browser's cookie domain.
- Credit unlock: actual detail-page action and database receipt, followed by the
  corrected paid reel reentry. No cash/payment-provider transaction was made.
- Free unlock: actual reel Get free recipe action returns 200, reveals View
  recipe details, and survives navigation back into the reel. One free receipt
  exists; the balance is unchanged. Fixture records were seeded directly; the
  creator publishing/upload-authoring journey was not part of this check.
- Media: the unlocked reel image decodes to 320x480. Its video advances with
  readyState 4; starting its audio advances playback and pauses the video.
- Files: the reel's Open Journey guide signs on each click. Storage delivers it
  as a download, so waiting for the popup to finish navigating is the wrong
  browser assertion. Both actual download events finish without error, with
  window.opener detached and matching file bytes. Initial fixture mistakes
  (wrong workflow bucket and missing attachment kind) were corrected as setup,
  not classified as application bugs. Purchased-content immutability correctly
  rejected changing the already-purchased fixture; a separate free fixture was
  used for the guide.

Evidence (ignored local artifacts): output/playwright/journey-isolated-before.log,
journey-isolated-after.log, journey-isolated-share.log,
journey-isolated-playback.log, journey-free-unlock.log,
journey-file-download.log; output/media-audit/journey-final-readback.json and
journey-access-result.json. These use real local APIs and Storage, without
intercepted media responses or the E2E auth bypass. They do not certify Razorpay
cash checkout, production purchases, narrow mobile-web layouts, or native unlock
journeys. Rejected/expired-link fixtures and background acceptance remain in the
previous checkpoints, not implicitly repeated by these success-path journeys.

### Physical Android baseline, installed store app

Device: Samsung Galaxy S24 Ultra (SM-S928B), connected by USB, Wi-Fi active,
1440x3120 screenshots, battery approximately 41–47% and charging. Installed
com.magicbooklet.mobile version 0.1.4 / build 71 was launched successfully. The
installed OTA revision was not extracted, so these results identify the store
binary version only. No APK was installed, app data/cache cleared, production
content changed, or purchase/generation triggered on the phone.

Measurements use adb am start -W, timestamped screenshots, dumpsys meminfo TOTAL
PSS (KiB), and polled Android UID 10564 network-history byte counters. Network
deltas include the whole app, not just a single URL; they cannot distinguish API,
media, TLS or analytics traffic. UI dump/screenshot collection itself adds time.

| Scenario | Observed result |
| --- | --- |
| Existing-process launch | Android reported WARM, TotalTime 738ms; not time to first media. |
| Process-cold launches, existing disk cache | Android reported COLD, TotalTime 578ms and 525ms. On the timestamped repeat, the feed was still a skeleton around 2.0–2.4s; the feed image was visible in the screenshot captured during 3.15–3.87s. Thus first feed image was visible by 3.9s in this one sample, not a percentile. |
| Profile grid | Actual thumbnails displayed. PSS was 419,956 KiB on first profile sample and 473,628 KiB after scrolling the grid. |
| Image viewer, first observed open | PSS 698,711 KiB; app received 886,088 bytes since the preceding grid sample. |
| Five repeated image open/close cycles | Open PSS 700,717–716,217 KiB (about 684–699 MiB); last four close samples 648,971–656,721 KiB. Total app RX increased 598,977 bytes across five cycles (about 117 KiB per cycle). Small retained growth remains to investigate; these samples do not establish a leak. |
| Return Home | PSS 637,151 KiB after the image cycles. A later fresh-process Home sample was 264,330 KiB. Different cache/scene histories prevent treating these as equivalent memory states. |
| Profile video viewer | Visible moving video, no black/error state observed. First viewer interval received 3,721,543 app bytes (3.55 MiB); warm reopen/watch received another 1,939,266 bytes (1.85 MiB). The immediate reopen sample alone was misleadingly near zero before remaining bytes arrived. |

Evidence: output/media-audit/physical-samples.jsonl, physical-*-memory.txt,
physical-startup.json, physical-startup-repeat.json and timestamp-correlated PNGs;
physical-repeat.log and five UI dumps record repeated image navigation. Raw phone
screenshots/netstats may contain personal context and remain ignored locally.

The physical baseline is not a before/after certificate for the unreleased media
branch. Next measurements must attribute repeated image-viewer requests, inspect
retained memory with a comparable exact build, measure actual video first frame
and stalls, and cover cache-cold/slow-network behavior plus physical iOS. Do not
replace those requirements with emulator timing or the Android activity-start
number. No iPhone was connected during this pass.

Final validation on the isolated patch: 763 web test files / 5,415 tests pass;
all three web typechecks and lint pass. Production build and build:verify pass
with FFmpeg traced by 51 server bundles and resolvable in all 9 required routes,
and libvips in all 38 sharp-using bundles. The worktree initially lacked mobile
dependencies for cross-workspace types, and Turbopack rejected an external web
node_modules symlink; restoring dependency availability and cloning the web
dependencies locally resolved those setup failures without source/config changes.
Logs: output/media-audit/journey-final-tests.log, journey-final-quality.log
(typechecks/lint), journey-final-build.log (successful final build/verification).
The dev server was stopped before building. No mobile source changed and no
native rebuild/export, migration, deployment, OTA or remote push was performed.


## Native backdrop cache reuse (2026-09-07)

Physical Android baseline follow-up reproduced an independent cache inefficiency
in the actual native viewer on the emulator: refreshing a synthetic generation's
URL query token fetched its blurred preview again on every renewal, while the
full-size foreground stayed cached. The local server served a 57,392-byte JPEG
original and a distinct 2,454-byte WebP preview. Before the fix, tokens 1, 2 and 3
all fetched the preview; only token 1 fetched the original.

FeedMediaFrame now accepts the preview's explicit cache identity. The viewer
passes the descriptor preview key separately from its full-size source key.
When both layers use the same URL, image and video-poster frames reuse the same
asset key. Distinct backdrops without an explicit identity retain URL caching;
no signed URL is generalized into a guessed stable identity. Authorization
headers are preserved.

Android native viewer verification: renewed tokens 2 and 3 made no additional
media requests. Unmounting, clearing the Expo image memory cache and reopening
with token 4 also made no additional requests; the full-size image and backdrop
remained visible. Changing the media version/key fetched both replacement assets.
iOS simulator verification: initial original/preview requests only, no new requests
on token renewal or memory-cache eviction/reopen. These synthetic component
journeys establish cache reuse, not production expiry or physical performance.

Validation: all 190 mobile test files / 1,821 tests, mobile typecheck, Android and
iOS Hermes exports, and both exports' bundled public environment checks pass.
The shared output directory was removed externally during verification; this
worktree now owns its output directory. Final request/state evidence, screenshots,
and rerun validation logs are under output/media-audit/backdrop-*; earlier
pre-fix observations are recorded above from tool output.

The S24 Ultra reconnected during this pass, still on 0.1.4/build 71. A release-mode
side-by-side audit APK is being prepared with a separate application ID and OTA
updates disabled. Physical memory/traffic attribution and cold/slow-network
playback on that build remain pending. This change requires no new migration and
has not been deployed.

## Physical baseline correction and audit APK continuation (2026-09-07)

The earlier roughly 117 KiB/open observation does not prove a same-image cache
miss. The profile grid shifted after closing the creation feed; fixed-coordinate
taps could select different creations. Subsequent tests identified the same
creation by its unique accessibility label. The store app opened the profile
creation feed; the backdrop reproduction above used the separate immersive viewer.

Five identity-matched opens through a TLS passthrough proxy added no tracked-host
bytes. Open PSS decreased from 588,596 to 560,806 KiB; return PSS decreased from
575,928 to 551,211 KiB. A corrected direct-Wi-Fi run measured three opens with
unchanged app UID RX (31,300,663 bytes before and after). Open PSS was
469,742 / 477,882 / 470,538 KiB; return PSS was 460,868 / 459,813 / 458,204 KiB.
Initial grid PSS was 375,537 KiB, so the short run includes retained allocations
after first opening; it does not prove a leak or zero retained memory. No black
image was observed. These are historical store-build-71 observations from the
previous session's tool results, not measurements of the new audit APK.

USB-proxied traffic is not counted as normal Wi-Fi traffic in Android UID network
history. Proxy-host bytes and direct UID bytes must be reported separately.
Deleting `http_proxy` alone did not reset the resolved Android proxy; setting
`:0`, checking an empty `global_http_proxy_host` and zero port, removing the ADB
reverse, and restarting the app restored direct transport for the final run.

The temporary worktree and its ignored evidence were absent when work resumed.
Committed code was recovered into the persistent worktree
`/Users/athuls/.codex/worktrees/media-delivery-audit`. Historical raw measurements
above cannot currently be re-opened from their former output paths. New evidence
is stored in this worktree's own `output/media-audit/` directory.

The S24 Ultra (SM-S928B) has the separate audit app installed. Pulling its APK
back from the phone verified SHA-256
`e440917446949ddbbb6d499dd46dd1fb1526087ab075f6365a2f720532cb372a`, matching the
previously built artifact. Source commit: `4c8c6c440dbe137086bb163a8eca9d7711fc1509`.
It is an arm64 release build, locally signed, with test-only native changes:
application ID `com.magicbooklet.mobile.mediaaudit`, label Magic Booklet Audit,
corresponding Google Services package entry, and OTA disabled. App version is
0.1.4/build 1; it is not a store release. Prior APK signing, bundle-env and cache-fix
inclusion checks passed. Resumed cold activity launch was 817ms and reached
onboarding; this is not first-media timing. No migration, deployment, or OTA.

## Exact-build Android image reuse and throttled private playback (2026-09-07)

The verified audit APK above signed into the user-supplied test account. Only the
separate audit app was used. No account content was generated, published, changed,
or purchased during these measurements.

Three process-cold starts returned Android TotalTime 675 / 723 / 539ms. Each kept
the existing disk cache and signed-in session. Run 1 still showed a feed skeleton
in the capture started at 3.002s and showed media in the capture started at 6.003s.
Runs 2 and 3 showed feed media in captures started at 3.005s / 3.000s. Screenshot
commands themselves took roughly 0.4–1.2s: these are sampled visual observations,
not exact first-frame timings. Post-launch PSS was 299,642 / 290,292 / 288,628 KiB.
Evidence: `output/media-audit/audit-cold-start-{1,2,3}.json` and associated PNGs.

For request attribution, a local HTTPS CONNECT proxy tunneled TLS unchanged.
Only magicbooklet.com and the project's Storage host were counted; request paths,
headers, tokens and bodies were not decrypted or logged. Host-level counts include
TLS overhead and can aggregate several app requests. The profile creation feed
and immersive viewer were entered using unique accessibility labels, not a fixed
grid position. The selected image was the ceramic mug on a linen cloth with soft
window light. Its preview had already been viewed; the full-size viewer had not.
The initial immersive open added 3,083,801 Storage-host RX bytes. A screenshot
confirmed the full image and blurred backdrop.

Ten further opens of that same immersive item added **zero** Storage-host RX bytes.
API-host RX grew by 173,823 bytes, consistent with the viewer's source-data refresh
on focus; this is not per-image payload attribution. Open PSS in KiB:
617,508 / 622,463 / 633,622 / 625,008 / 636,314 / 636,154 / 640,082 /
582,793 / 644,028 / 643,464. Final return after eight seconds was 615,541 KiB.
The initial feed baseline was 426,203 KiB and the first immersive sample was
588,520 KiB. Memory remains retained after this short session, including native
caches/allocations; the run does not establish a leak, a long-session plateau,
or an improvement against another build/account. Evidence:
`audit-immersive-image-first.json`, `audit-repeat-image.json`, and screenshots.

The proxy then capped the combined counted-host downlink at 128,000 bytes/s
(approximately 1.024 Mbps). No latency or loss was added, so this is a bandwidth
test rather than a complete cellular simulation. An initial selection named
Minnal 3.0 proved to be an image; files named `audit-slow-video-feed-*` belong to
that image and must not be counted as video-playback evidence.

The actual unopened video was generation `0a58067a-f6d1-45bd-9850-c2d8c3cbff48`,
selected via the unique long script title in the profile feed and then opened
into the immersive viewer. Captures at 1s and 6s showed the poster with a loading
indicator. By the 20s capture, a changed video frame was visible with buffering;
35s and 45s still showed intermittent loading. The later observation (about 82s
after opening) showed the poster and “Video couldn’t load” / Retry video.
Storage RX increased by approximately 8.57 MB before the failure observation.
The poster/error remained visible; no bare black media was observed in these
samples. Sparse captures do not measure exact startup or total stall duration.
Evidence: `audit-slow-immersive-video.json`, corresponding PNGs,
`audit-slow-video-late.png`, `audit-video-normal-recovery.png`, `proxy-traffic.json`.

A read-only production metadata query found an 11-second private MP4 source of
13,063,623 bytes (roughly 9.5 Mbps averaged over its declared duration), with a
ready image preview. Information-schema inspection confirmed that production
does not yet have `generations.playback_rendition_path` or the other rendition
columns. Thus this run tests the new native client against the existing production
backend, not the complete private-rendition delivery change. The committed
`20260905213637_private_generation_playback_renditions.sql` migration and matching
backend release/backfill remain required, through the production-release workflow.
Do not increase loading deadlines to mask this source/network bitrate mismatch.

After restoring uncapped proxy transport, Retry video transferred additional
Storage bytes, but an unrelated phone call took the foreground during observation.
`audit-video-retry-normal-*` is therefore interrupted evidence, not a recovery or
background-playback pass. No call controls were operated. The phone proxy was
restored to `:0`, with empty global proxy host and port 0, and the ADB reverse
removed. Subsequent phone checks must resume only when the phone is available.

No application source changed in this measurement pass; no new migration,
deployment, OTA or remote push. Still open: uninterrupted retry/offline/background
checks, updated-backend cache-cold rendition playback, sustained multi-asset memory
and playback stress, physical iOS, and production release validation. Local raw
evidence remains ignored because screenshots can contain personal context.

### Continued physical background/offline checks

After the interruption ended, the audit app played the recovered video normally.
An eight-second Home/background cycle reproduced a pause-continuity failure:
the return screenshot initially showed paused, then the next screenshot showed
a later playing frame, without a playback tap. Explicitly pausing before another
five-second background cycle also returned to playing after the source refresh.
Evidence: `audit-video-background-return-{1,2}.png`,
`audit-video-background-return.json`, and `audit-user-paused-*-background.png`.

The viewer keyed `ActiveVideoAttempt` by signed URL as well as retry count. Every
renewed signature remounted the component and discarded the previous-player ref
that preserves pause and position. The pending fix keys the outer player by media
ID and remounts the attempt only on Retry. A new URL for the same media now reaches
the existing continuity helper. Physical confirmation is recorded below.

With both Wi-Fi and mobile data disabled (`wifi_on=0`, `mobile_data=0`), the already
cached video continued rendering different frames. Both settings were restored.
This confirms cached playback during a short real disconnection, not uncached
offline playback. Evidence: `audit-cached-video-offline.json` and both PNGs.

An unopened full-size image (Super women) was then opened after disabling both
transports. Its cached blurred backdrop remained visible, and the foreground
showed Preview unavailable / Tap to retry by the 20-second capture. Restoring
both transports and pressing Retry loading media displayed the full image in
the four-second capture. Evidence: `audit-uncached-image-offline.json`,
`audit-image-reconnect-retry.json`, and associated screenshots. Proxy counters in
these helper samples are historical, not live direct-network traffic measurements.

### Pause-renewal fix: installed release verification

The release rebuild succeeded (994 Gradle tasks; 5m52s), with all 190 mobile test
files / 1,821 tests, typecheck, and iOS Hermes export passing. The Android APK's
bundled environment verification passed. APK SHA-256:
`fc59b8bd209c76d9e45edc7112decd53accf1d40303d4e8330b3078adf54c759`.
The APK pulled back after installation had the same digest. Source is `4c8c6c4`
plus the viewer key-boundary change; exact patch SHA-256 is recorded in
`output/media-audit/pause-renewal-build-identity.json`. The separate audit package,
local signing certificate, disabled OTA, and signed-in test session were retained.
No store app data was changed.

The formerly failing explicit-pause case now remains paused after background and
source refresh. A further settled check captured the same paused frame before
and after ten seconds backgrounded and ten seconds back in the app, with another
three-second stationary observation. Accessibility continued to expose Play video.
Manual Play then advanced through subsequent frames normally. Evidence:
`fixed-background-checks.json`, `fixed-paused-settled.json`,
`fixed-paused-settled-*.png`, and `fixed-manual-resume-*`.

The previously-playing case still returned to playback after backgrounding.
That is not a pass for a policy of always remaining paused on return; its native
lifecycle behavior remains a separate open check. This fix is limited to preserving
the explicit pause and frame through source renewal. No continuous native trace
or physical iOS verification was taken for this change. Network cleanup confirmed
Wi-Fi/mobile data enabled, proxy `:0`, port 0, and no audit ADB reverse.

Build/setup logs: `pause-renewal-build.log`, `pause-renewal-mobile-tests.log`,
`pause-renewal-ios-export.log`, and `pause-renewal-install.log`. Initial helper
failures were local tooling assumptions (macOS Bash expansion, package detection,
and missing SDK environment for the React Native source build); direct Gradle with
the SDK path and explicit package/activity completed successfully. No new migration,
deployment, OTA, or remote push was performed.

## Viewer playback gate, quick-exit tap and replaced-player autoplay (2026-09-07)

The gate checkpoint was interrupted. The Codex session that built it stopped at
its usage limit at 11:26 IST while installing the rebuilt audit APK
(`cd6c0057f116c71e4d196f5c2eb9269b34dc9d2f4ee388a325c08e24a2bc92b9`, install
completed 11:34). That build carried two uncommitted changes: a viewer playback
gate that revokes autoplay after backgrounding until explicit Play, and a
double-tap cancellation so a Pause tap immediately followed by Home cannot fire
its delayed single-tap action after the app has left the foreground. Unit tests
and typecheck had passed (191 files / 1,825 tests). Nothing on the phone had
verified the quick-exit case, no memory soak had run, and no journal entry or
commit existed. This entry records finishing that work in a separate session.

### The first phone check measured a video that was never playing

On the installed `cd6c0057` build, the quick-exit sequence (tap Pause, inject
Home in the same device shell, wait 8 s, relaunch, wait 8 s) returned with the
label `Pause video` and byte-identical viewer frames before, on return and 3 s
later (`quick-exit-0-*.png`, crop hash `5532e877796d6703`). A Home-only control
gave the same result (`gate-settled-control.json`). Both were invalid: the frame
never changed before the tap either, so the video had not been playing.

Reproduced directly: opening the same creation fresh from the profile grid
showed that frame for 12 s with the label `Pause video`, no `Loading video`
indicator and no error panel (`fresh-open-probe.json`, `fresh-open-*.png`). One
tap on the surface started playback (crop hashes `66a3e1dcd9ffb5c3` then
`099f890e60d097fc` 2 s apart) while the label stayed `Pause video`, which is
only consistent with the tap calling `play()` on a player that had never
started. The label is the optimistic initial `isPlaying` state, and the native
player emits no `playingChange` for a `pause()` on a player that never played.

A controlled comparison then autoplayed on all four opens: cold process start,
cold start plus one background/return cycle, hot resume and a second cold start
(`autoplay-cold-vs-hot.json`, `autoplay-*.png`). So this is a race, not a rule:
two of roughly ten opens on this phone today never started (Wi-Fi enabled, LTE
active default network, 13 MB private original because production has no
private renditions). The mechanism is visible in the device log: every viewer
open logs two `ExoPlayerImpl Init` lines 0.8–1.1 s apart with the first player
released immediately after the second appears (for example 14:02:44.939 and
14:02:45.851). The viewer refetches its source query on focus, the response
carries freshly signed URLs, `useMediaSource` yields a new source and expo-video
recreates the player. `restoreVideoPlayback` then copied `previous.playing`,
which is `false` while the first player is still loading, so the replacement
was paused as if the person had paused it. Whether an open plays is decided by
whether the first player reaches playback inside that ~1 s window. This defect
predates the gate: the `previous.playing` copy landed in `53a3903` on 6
September and the optimistic label in `547aad6` on 23 August.

### Change

- `lib/video-playback-continuity.ts`: a replaced player keeps its playback
  request unless it was `readyToPlay` and not playing. A loading, idle or failed
  previous player therefore resumes on renewal when playback is still allowed;
  explicit pauses and the background gate already arrive as `allowed === false`.
  The helper now returns the decision. Tests cover the pending request, renewal
  after an error with playback allowed and revoked, and the mirrored decision.
- `lib/use-viewer-playback-gate.ts`: an optional `onRevoke` callback runs with
  each revoke, because a player that has not started emits no `playingChange`
  when paused.
- `app/viewer.tsx`: `isPlaying` now follows the replacement decision through an
  effect keyed on the player, and a gate revoke clears it. The optimistic
  initial value is unchanged for the first player.
- The gate and double-tap changes from the interrupted session are included
  unchanged; their tests already covered `change` and Android `blur`.

Validation under the shell's Node 24: 191 mobile test files / 1,828 tests and
mobile typecheck pass (`replacement-fix-tests.log`). The audit APK was rebuilt
with the same Gradle invocation (`replacement-fix-build.log`, bundle generated
after the last source edit), its bundled client configuration verified
(`replacement-fix-bundle-env.log`), and the iOS Hermes export passed
(`replacement-fix-ios-export.log`). APK SHA-256
`1fe96f5eca2d13d64bedf35355f75407171d3e332535af85c2d02fb6d249e6ab`; the APK
pulled back after installation has the same digest
(`replacement-fix-install.log`, `replacement-fix-apk-sha256.txt`).

### Installed-build acceptance (`1fe96f5e`)

`replacement-fix-verify.py` drove the installed audit APK over USB and judged
playback by crop hashes of the viewer frame, not by labels
(`replacement-fix-verify.json`, `replacement-fix-verify.log`, `verify-*.png`):

- Autoplay on open: five fresh opens of the same private video advanced between
  the 3 s and 6 s captures, three from a warm process and two after
  `am force-stop` and a cold start. The device log still shows two
  `ExoPlayerImpl Init` lines 0.9–1.4 s apart per open, so the focus refetch
  still replaces the player; the replacement now keeps the pending request.
- Quick exit: three cycles of a Pause tap followed by Home inside one device
  shell (0.18–0.23 s for both injections) came back after 8 s away with
  `Play video` and an identical frame 3 s later.
- Home while playing, no tap: `Play video` on return, identical frame.
- Home 0.21 s after the Open tap, during the initial load: `Play video` on
  return and an identical frame. This is the revoke-callback path; before the
  change the badge would have stayed in the playing state.
- Manual Play then advanced frames, and a settled Pause held its frame.

This is a development-signed release build on one Samsung S24 Ultra over the
phone's own network, with the 13 MB private original because production has no
private renditions. It does not certify iOS, the store build or the shared
preview component, and the two-player open remains a transfer cost.

### Memory soak on the installed build

The prepared `long-memory.py` ran unchanged against the installed `1fe96f5e`
build from the profile grid: 30 cycles opening two images and one video in
turn, then four 30 s idle samples, all in one process (pid 26428) over 982 s
(`long-memory.json`, `long-memory-NNN.txt` meminfo dumps,
`long-memory-viewer-*.png`, `long-memory-final-grid.png`, `long-memory.log`).
No `Retry` control appeared and every newly opened video reported the playing
label, which after the change above means it had actually started.

| Sample | PSS (MiB) |
| --- | ---: |
| Grid baseline | 556.9 |
| Viewer, per cycle | 657.4 – 727.1 |
| Grid on return, per cycle | 586.0 – 640.0 (first 594.2, last 605.0) |
| Grid idle 30 / 60 / 90 / 120 s | 556.8 / 534.4 / 552.1 / 545.1 |

Return PSS shows no upward trend across the 30 cycles, and after two minutes
idle the process sits 12 MiB below its baseline. Between the first and last
return, native heap moved 184.7 → 179.7 MiB and graphics 245.7 → 201.6 MiB;
Java heap read 93.5 MiB on the last return but 22.4 MiB at the final idle
sample, so that is collection timing rather than retention. This measures one
three-item rotation on one phone with cached media. It is not a leak
certificate for the broader library, cold caches or iOS, and it says nothing
about the two-player open cost, which needs a transfer measurement.

### Remaining after this entry

- `components/recoverable-video-preview.tsx` line 89 copies `previous.playing`
  the same way; source-only, not reproduced on a device, untouched here.
- Each viewer open still creates and loads two players because the focus
  refetch re-signs the source; the second now plays, but the first load is
  wasted transfer on a 13 MB private original until private renditions ship.
- Physical iOS, the store build, production-duration credentials and the
  broader surface matrix remain as listed in the plan.
- All of this is committed on `fix/private-video-delivery` and unreleased: no
  push, PR, deployment or OTA.

## Release of the second pass (2026-09-07)

PR #115 squash-merged the branch as `0cf34e7` at 10:04 UTC after Quality run
34108800673 passed all four jobs on the exact head. Production release
34110410692 authorized the revision, applied
`20260905213637_private_generation_playback_renditions.sql`, staged, verified
and promoted; `/api/app-version` reported `0cf34e7` at 10:18 UTC and the
migration ledger lists the private rendition migration. The watchdog health fix
was cherry-picked onto main as PR #116, merged as `f246f80`, and release
34111594369 promoted it; `/api/app-version` reported `f246f80` at 10:35 UTC.

### Over-the-air publication

Main's mobile tree fingerprints Android 71 exactly, while its iOS fingerprint
has not matched a shipped iOS binary since #112. The published iOS 47/51 and
Android 70 updates of 5 September came from per-target branches whose native
surface is the shipped binary's own commit, so the same construction was
repeated: `release/media2-ios-51` (`23347c1`) and `release/media2-ios-47`
(`4cf5907`) overlay the `85c137e..2dbf163` changes under `ugc-mobile/` and
`contracts/` onto `release/media-ios-51` and `release/media-ios-47`. One conflict
in `components/ui.tsx` was resolved by keeping the backport's React Native
`Image` for `CreatorAvatar` and taking the viewport scroll view import. Each
branch passes typecheck and its suite (189 files / 1,818 tests; 188 files /
1,809 tests) and `scripts/verify-ota-target.mjs` on a fresh `npm ci`: Android 70
`17fa2c36` and iOS 51 `e2aa6c79` on the first, Android 65 `b32edbfe` and iOS 47
`27175069` on the second, Android 71 `db146ca3` on main `0cf34e7`.

`eas.json` pins eas-cli 21.2.0; the cached 23.2.0 refused every publish with a
version-constraint error before anything was uploaded, and the global 21.2.0
published all five with `--branch production --environment production` per
platform: Android 71 group `15926309-a998-425c-b86c-bd06a50516aa`, iOS 51
`ce10f3af-0d80-48f9-ab51-c11b8a387130`, Android 70
`6b705318-d7cc-4ec0-8e95-bb027ec03463`, iOS 47
`c25f2c92-6444-424f-b683-5011948863b4`, Android 65
`cd3948f2-4e38-4e5c-a1f0-0d6956acfced`. Channel insights for the seven days
before publication: iOS 47 had 7 embedded and 5 OTA users, iOS 51 3 and 0,
Android 71 2 and 1, Android 70 1 and 0, Android 65 7 and 7; the App Store still
serves 0.1.2, so iOS 47 is the runtime that reaches App Store users.

On the Samsung S24 Ultra's store build 0.1.4 (71), the first cold start after
publication logged `UpdatesController onBackgroundUpdateFinished: Update
available` and `NEW_UPDATE_LOADED`, and the second reported `No update
available`; channel insights for `db146ca3` showed one OTA user within the
hour. A behavioural check of the store build was started and stopped because the
phone was in personal use; the identical JavaScript passed the audit-APK
acceptance earlier in this entry. Physical iOS verification remains open.

### Backfill

The private rendition producer runs inside `media-preview-repair` every ten
minutes and takes one generation per run: 10:20 UTC produced the first
(12.99 s, 1,922,882 bytes) and 10:30 UTC the second; twelve of the fourteen
stored private originals remained pending at 10:35 UTC, so the backlog drains
in roughly two hours. The slow-network playback gate should be re-measured once
the test account's videos carry renditions.

### Store-build confirmation on Android (2026-09-07, 16:25 IST)

With the phone free again, the same frame-hash check ran against the store
build 0.1.4 (71) carrying update group `15926309`, on the signed-in owner
account's own creation "The girl from @girl is crying" (generation
`d32fb47c`, a 13 MB original without a rendition yet): the video advanced
between captures 3 s apart after opening, a Pause tap followed by Home in the
same injection came back after 8 s away with `Play video` and an identical
frame 3 s later, and a manual Play advanced frames again
(`store-build-ota-check.json`, `store-open-*.png`, `store-quick-*.png`,
`store-manual-*.png`). This is the released binary plus the published update,
not the audit APK. Physical iOS remains open.

### iPhone reach (2026-09-07, 11:08 UTC)

A physical iPhone 16e on the App Store build 0.1.2 (47) was launched four times
over USB with `xcrun devicectl device process launch --terminate-existing`, the
first launch downloading the update and the later ones applying and reporting
it. Within a minute, channel insights for runtime `27175069` moved from zero to
two OTA update users, with the cumulative metric naming "Media delivery second
pass for iOS 47 (4cf5907)" installed once and zero failed installs. This is
server-side proof that the published bundle runs on a real iPhone; the viewer
behaviour on iOS was not driven from the Mac, because this Xcode's device
tooling offers no screenshots or input for physical devices, so it rests on the
owner's manual check and the simulator evidence earlier in this journal.

The owner then ran the four-step check on that iPhone (App Store 0.1.2, build
47, the runtime the update reached): quit and relaunch to apply, a video
creation autoplaying from Profile, Pause followed immediately by Home returning
paused on the same frame, and Home while playing returning paused with one tap
resuming. All four passed. This is an owner-reported manual check, not a
frame-hash measurement; the iPhone uses a different Apple ID from the Mac, so
iPhone Mirroring could not drive it.

## Slow-network gate with private renditions (2026-09-07)

The backfill reached the test account's video (`0a58067a`, 13,063,623-byte
original) at 11:10 UTC with a 1,475,359-byte rendition. The measurement reused
the local TLS proxy from the earlier exact-build entry (`phone-proxy.py`, port
8894, ADB reverse, Android global proxy, `/control/slow` capping the counted
hosts' downlink at 128,000 B/s), driven by `slow-rendition-check.py`: cold
process start, profile grid, open the video with the cap already active,
captures at 1–40 s with labels, crop hashes and Storage-host bytes, then a
warm reopen at full speed, then proxy and phone settings restored (verified
empty host, port 0, no reverse). A stale proxy from the earlier session still
held the port and was stopped first.

| Run | Build | Players per open | Storage bytes by 40 s | Playing by | Retry |
| --- | --- | ---: | ---: | --- | --- |
| 1 | `1fe96f5e` | 7 | 5,130,082 | never | 40 s |
| 2 | instrumented | 2 | 2,566,020 | 3 s, stall at 6 s, steady from 10 s | no |
| 3 | instrumented | 2 | 2,627,261 | steady from 10 s | no |
| 4 | instrumented | 2 | 2,969,245 | steady from 10 s, stall at 15 s | no |
| 5 | instrumented + stable URL | 1 | 1,484,635 (complete at 17 s) | 3 s | no |

Run 1's burst of seven `ExoPlayerImpl` creations in one open did not recur in
three instrumented repeats and stays unattributed. Runs 2–4 attribute the
second player exactly: the viewer's focus refetch returns the same rendition
path with a fresh signature about a second after opening, `useMediaSource`
yields a new source, expo-video recreates the player, and the first player's
partial download (1.08–1.48 MB) is discarded while the second restarts from
byte zero. With the rendition that still reaches steady playback by ten
seconds at the cap, where the original had reached Retry; without the rendition
the same churn under the cap would still fail.

`lib/use-stable-signed-url.ts` holds the URL a player already loads while the
parent addresses the same object and the held signature is more than a minute
from expiry; a different object (a rendition replacing an original) or a
near-expiry signature is adopted, and `useMediaSource` continues to renew the
held URL through the authenticated route. Run 5 shows one player, one
connection carrying exactly the rendition, and the first frame by three
seconds. The warm reopen still transfers the rendition again (1.48 MB) because
the signed URL, and therefore expo-video's cache key, changes on every list
fetch; a stable cache identity for private media is a separate follow-up.
Every run restored the phone's proxy settings; receipts are
`slow-rendition-run{2,3,4,5-stable}.json`, `-traffic.json`,
`-attribution.log`, and `slow-rendition-*.png`.

### Clean build with the stable URL (run 6) and acceptance

With the instrumentation removed, the same tree passed 192 mobile test files /
1,832 tests and typecheck, and the release audit APK
`a7974a7b3202e18c7a573a6ad4d172486ccf6c43e9650a282f698c2ffcdd5b4a` was
installed. Throttled run 6 on it: Storage bytes 1 s 511,223, 3 s 1,035,511 loading, 6 s 1,484,617, 10 s 1,484,617, 15 s 1,484,617, 20 s 1,484,617, 30 s 1,484,617, 40 s 1,484,617; final
1,484,617 bytes, Retry false, warm reopen
1,484,615 bytes. The full acceptance from the gate
checkpoint also passed on this build: 5 of 5 fresh opens advanced,
3 of 3 Pause-then-Home cycles returned paused, Home while playing and Home
during load returned paused, and manual Play resumed with a settled Pause
holding (`stable-url-acceptance.json`, `stable-url-final.log`). The change is
committed on `fix/viewer-stable-signed-url` for release through Quality and
the same per-target over-the-air branches as the second pass.

### Stable URL fix released (2026-09-07, 19:25–19:35 IST)

PR #118 merged as `7e54ccc` after Quality; its production release promoted
the same code to the web (`/api/app-version` reports `7e54ccc`). The Mac had
rebooted in between, clearing the temporary publishing worktrees, so they were
recreated from origin: main at `7e54ccc`, `release/media2-ios-51` at
`9fbe7db` and `release/media2-ios-47` at `dc36250`, each carrying the
cherry-picked fix, each passing typecheck and its suite, and each matching its
shipped fingerprints on a fresh `npm ci`. The pinned eas-cli 21.2.0 published
all five: Android 71 group `0d68c7e0-82f7-4040-a5bb-2a4931cb606a`, iOS 51
`a5ba8d21-b668-40e6-a68c-6f5b27551ecb`, Android 70
`bf4b65d8-5ac2-4003-b1fd-2c971bac81ac`, iOS 47
`76628936-ae51-4ca8-b9df-b45431100c39`, Android 65
`37782666-e5af-4f4a-9619-6bf60b41cc28`. The S24 Ultra's store build logged
`NEW_UPDATE_LOADED` on its first cold start after the Android 71 publish and
`No update available` on the next, and channel insights for `db146ca3` showed
the new group installed once with zero failed installs within minutes. The
iPhone had not relaunched by the time of writing, so its runtime still reports
the second-pass group.

### Released binary under the cap (2026-09-07, 20:11–20:16 IST)

With the phone free and untouched, `store-slow-check.py` (the same measurement
pointed at the store package and the owner account's creation "The girl from
@girl is crying", rendition 176,927 bytes) ran twice against store build 0.1.4
(71) carrying update group `0d68c7e0`. Run 2, clean: one `ExoPlayerImpl`
creation for the open, one Storage connection of 182,636 bytes completing in
2.3 s at the 128,000 B/s cap, `Pause video` with a changing frame at every
sample from 1 s to 40 s, no Retry, and the warm reopen transferring 182,629
bytes again. Run 1 matched on every count until 15 s, when the label flipped to
`Play video` and the frame froze; it did not recur and is recorded as a single
unexplained event, not attributed. Navigating the store build by automation
needs two allowances the audit build did not: the Home feed's rotating lane
emits `Creation, …` labels, so the profile grid must be confirmed by its own
markers, and a tile partly under the bottom tab bar must be scrolled up before
tapping or the tap lands on the Home tab. The test account's video used for
the earlier runs is 11.04 s (original 716 × 1284, rendition 714 × 1280).
Receipts: `store-slow-check-run2.json`, `store-slow-check.log`, `store-slow-*.png`.

## Backfill complete and shared preview replacement (2026-09-07, evening)

By 12:30 UTC the private rendition producer had processed every stored private
original: 14 of 14 `generated_videos` generations report `ready`, 13,718,275
rendition bytes against 187,364,783 original bytes (92.7% smaller in object
size), zero errors, one attempt each. This closes the plan's "backfill and
re-measure" step; the throttled measurements above used the first of them.

`components/recoverable-video-preview.tsx` carried the same replacement rule
the viewer had: when `useMediaSource` renews the effective URL it copied
`previous.playing`, which is `false` for a player still loading, so a renewal
before the first frame parked an autoplaying preview (lightboxes, result
previews with autoplay) on a still frame. A replaced player now keeps the
component's autoplay request unless it was ready and paused; a ready paused
player, a preview that never requested playback, and a hidden screen behave as
before. The parent-driven case differs here: `VideoPreviewSession` is keyed on
the URL prop, so a parent re-sign remounts the attempt outright and restarts
its download without continuity. That is recorded as a follow-up next to the
cache-key item and is not changed by this fix.

Evidence: a component test that fails before the change (loading player,
`autoPlay`, renewed source, `play` never called) and passes after; the
paused-renewal fixture now marks its player `readyToPlay`. Full mobile suite
and typecheck pass on the branch. Native reproduction was not repeated for
this component; the mechanism is the one measured on the viewer earlier
today, and the change is confined to the replacement decision. The Mac
restarted twice during the evening (19:20 and 20:51, plain restarts), which
cleared the temporary worktrees each time; branches and evidence live on
origin and under the home directory, so nothing was lost.

PR #121 merged as `6532971` and the fix was published over the air from the
same per-target branches as the two earlier updates (`release/media2-ios-51`
at `8b11b39`, `release/media2-ios-47` at `2f12ca1`, main at `6532971`; each
typechecked, tested and fingerprint-matched after the cherry-pick): Android 71
group `e7de37e8-bd78-46fc-9187-2544d69901d5`, iOS 51
`d803fdc6-882b-458c-8cc6-40feacf0dc3f`, Android 70
`8a2ea441-dc7c-4722-86bb-894e632bc9ef`, iOS 47
`00cf784f-2ba7-47cc-8b4e-eb737f85cb8f`, Android 65
`ab95a86c-8072-4ebe-aaa2-04e7495bc0d9`. Devices pick these up on their next two
cold starts, as with the earlier groups.

### A probe false alarm and two republishes (2026-09-07, 21:20–21:45 IST)

After the preview-fix publish the S24 Ultra's store build reported the update
as available but logged `Failed to download asset 1ba3bb61…` (the launch
bundle) on two consecutive cold starts. A curl of that bundle's CDN URL from
the Mac returned 403, and so did every other launch bundle, which read as a
CDN-side problem. It was not: `assets.eascdn.net` answers "Unauthorized asset
request" to any request without the per-asset `authorization` header that the
manifest's multipart `extensions` part supplies, so a bare probe cannot tell a
missing bundle from a healthy one. On that misreading, Android 71 was rolled
back by republishing the stable-URL group (`b6c737ec-8209-415d-a155-ea0ba8bc5d33`);
a probe with the manifest's headers then returned 206 for that bundle and for
all four preview-fix bundles still current on iOS 51, Android 70, iOS 47 and
Android 65, so Android 71 was republished onto the preview-fix bundle as group
`4546e404-022b-4599-bd68-fc4b8dc9e185`. Devices that fetched the rollback
in between saw only the previous good update. The phone's own two download
failures remain unexplained; it had lost its USB-debugging authorization to a
Mac restart, so the pickup was re-verified once the phone re-authorized the Mac (Samsung
needed "Revoke USB debugging authorizations" before it would prompt again).
At 21:49–21:50 IST the store build's first cold start reported
`isUpdateAvailable=true, isUpdatePending=true` for group `4546e404` and the
second launched it and found "No update available"; the earlier download
failure did not recur, so it is recorded as transient on the phone's side.
All five shipped runtimes now carry the shared preview fix.

### Stable playback addresses through the media route (2026-09-08, 00:30–02:20 IST)

Item 1 of the remaining list. The owner generations API now hands out the
private playback rendition as `/api/media?bucket=generated_videos&path=…`
(PR #124, `49c8953`, live before the 00:55 IST measurement) instead of a signed
Storage URL. The route authorizes every request (bearer or cookies), rate-limits
signing, and answers a 302 to a fresh 600-second signed URL with
`Cache-Control: private, max-age=60`. The native player caches by request URL,
so the address no longer changes on each refetch and a reopen can hit the
cache. Mobile already resolved route URLs (`use-stable-signed-url` holds the
address while the object is unchanged; `buildMediaSource` attaches the bearer),
so no over-the-air update was needed; the mobile contract fixture and the
stable-URL tests pin the new shape.

Measurements on the S24 Ultra through the byte-counting proxy with the Storage
downlink capped at 128 kB/s:

- Audit build, the test account's 11-second, 1,475,359-byte rendition, first
  open through the route (00:55 IST): first changed frame at 3 s; Storage bytes
  312,938 at 1 s, 1,378,843 at 10 s and 2,928,144 by 40 s. Two Storage
  connections carried it, one from 1.4 s (1,484,649 bytes, closed at 30.3 s) and
  one from 16.0 s (1,443,283 bytes, until 44.1 s) preceded by a 212-byte Storage
  response at 16.0 s. The API host saw 6,558 bytes for the whole open, a single
  route redirect. Warm reopen: 0 Storage bytes and 0 API bytes.
- Same clip after a cold start of the app (01:01 IST): 0 bytes from either host
  across 90 seconds of looping playback (twelve samples) and 0 on reopen. The
  cache entry survives the restart and a fresh access token.
- Store build (Android 0.1.4, build 71, current update), the owner's 4-second,
  176,927-byte rendition, cold for the route key (01:28 IST): first changed
  frame at 3 s, one Storage connection of 182,637 bytes from 0.8 s lasting
  2.0 s, no further traffic through 40 s of looping (about nine loops), warm
  reopen 0 bytes, one ExoPlayer instance per open.

The open question is the second download in the first run. It began at
16.0 s, about one clip length after playback started, fetched the file from
roughly byte 41,000 (the offset of the first sample after the header) and did
not ask the route again; the 212-byte Storage response before it suggests the
player reopened the remembered redirect target, got a short answer and
re-fetched. That points at the loop restart landing while the first download
was still open: a 1.5 MB file needs about twelve seconds at this cap, whereas
the 4-second clip finished in two seconds and looped without traffic. The cost
is one extra rendition download on a slow link, on the first open only, for
clips whose download outlasts their duration; the reopen is clean either way.
Reproducing it with a colder long clip failed for tooling reasons: Samsung's
`pm clear --cache-only` hangs, the test account owns one video, and the owner's
longer clips sit past the first page of the Creations grid, which the
automation cannot scroll into. It stays open with the recipe recorded: a cold
rendition of ten seconds or more at 48 kB/s (`AUDIT_SLOW_RATE` on the proxy)
on either build.

Item 2 followed in the same pass: template-run renditions moved to the route
form in `template-run-media-delivery.ts`, and the rendition path is no longer
signed at all. Mobile's template screens render through `MediaPreview`, whose
`useMediaSource` resolves a relative route URL against the API base and
attaches the bearer, so shipped clients need nothing; web `TemplateRunMedia`
plays it same-origin with cookies. Workflow persisted outputs stay on the
explicit signed read-URL endpoint: they have no rendition, and the canvas
depends on that endpoint's `signedUrl`/`expiresInSeconds` contract, so the
conversion is a contract change for another day. The watchdog's degraded
threshold for an unreclaimed upload row moved from 48 to 96 hours (the 24-hour
warning stays), so a row that outlives one daily sweep no longer turns the ops
endpoint into a 503. Three legacy creations still point at dead provider URLs
and need a product decision: hide them, show an explicit unavailable state, or
delete them.

### Release of #125, the deep-link measurement, and an explicit unavailable state (2026-09-08, 10:20–12:30 IST)

PR #125 merged as `e394694`; Quality on main and the production release both
passed first time and `/api/app-version` confirmed the build at 10:33 IST. The
owner API still hands out the route form, the route still answers a 302 into
Storage byte ranges, the watchdog's three latest scheduled runs are green, and
the store build's cached clip played through a 40-second throttled open with
zero bytes from either host (warm reopen 0, one ExoPlayer instance per open).

The open question from the night before, the second download of the
11-second clip, now has a clean negative. The Creations grid could not be
driven to older tiles: its recycled cells report one creation's label while
holding another's content, so every tap on "the sports clip" opened a
different creation. The viewer route accepts a deep link instead
(`magicbooklet://viewer?source=profile-creations&initialId=<generation id>`,
via `am start -a android.intent.action.VIEW`, quoted for the device shell),
which bypasses the grid entirely. Opening the owner's 16-second,
1,590,876-byte motion clip that way on the store build, cold for the route
key, with Storage capped at 48 kB/s: first changed frame at 3 s; one Storage
connection of 1,600,450 bytes from 0.6 s to 34.7 s; playback looped through
the whole download (ten distinct frames across 60 s) with no second
connection; the API host saw 6,579 bytes; warm reopen 0 bytes; one ExoPlayer
instance per open. The download outlasted the clip by more than two loops,
which is a harsher ratio than the audit build's run, and the loop restart
never reopened the source. The 11-second double download stays a single,
unreproduced observation on the audit build; nothing in the shipped players
needs changing for it.

Workflow persisted outputs were not moved to the route form, and the reason
is recorded rather than deferred: the run state's resolved step `output_url`
is the same address the runner hands to the next node's provider call (the
`startImageUrl` of a downstream video step), and a provider cannot present
the owner's session to the media route. Converting it would need a separate
display address; the canvas is web-only and same-origin, so the caching gain
is small. The signed form stays.

The three records with dead provider sources now have an explicit state
instead of a retry that can never succeed, following the September 5
audit's own guidance (represent unavailable media explicitly; do not delete).
Migration `20260908061500` adds `source_unavailable_at` to `generations` and
`post_media` and marks generation `058a82f8` (motion clip, expired
`tempfile.aiquickdraw.com` copy), generation `a2b54deb` (recorded succeeded
with no output URL) and post media `a54b4ead` (image, same expired host, no
stored object). The owner API withholds `output_url`, `output_urls` and
`preview_url` for a marked generation and returns `media: null` alongside
the marker; post media summaries carry `sourceUnavailableAt` with a failed
preview status. The preview repair job now writes the marker itself when an
external source answers 404 or 410 on a second, separate run, so future
expiries stop looping. Web: the creations page, the profile hub cards and the
showcase carousel render "This file is no longer available" in place of a
loader, and the note has no retry control. Mobile: the profile grid keeps the
tile with the label "File no longer available" (hiding it would read as
deletion), never hands the dead address to an image or player, and the viewer
slide renders the same plate. The mobile change is JavaScript only and goes
out over the air; the three records belong to other accounts, so the state is
verified by tests rather than on the audit phone. The two per-target OTA
worktrees were rebuilt (`/private/tmp/magicbooklet-media2-ios-51` and
`-ios-47`, dependencies installed from cache in about 14 s each).

### Physical iOS baseline (2026-09-08, 13:30–14:10 IST)

The iPhone 16e (iOS 26.6.1, App Store 0.1.2 build 47, carrying the #126
update) runs the test account, not the owner's, so its library is the
11-second clip (`0a58067a`, 1,475,359-byte rendition) that last night's manual
check had already cached. Three tools replaced the proxy and the taps used on
Android: Apple's device tooling launches the app straight into the viewer
(`xcrun devicectl device process launch --terminate-existing --payload-url
'magicbooklet://viewer?source=profile-creations&initialId=<id>'`), QuickTime's
USB screen capture supplies a mirror sampled once a second, and the Supabase
edge logs (`request.path`, `response.headers.content_range`, the user agent)
count every Storage transfer. A fresh 6-second `grok-imagine-video` clip
(`ac95ad04`, 15 credits, 465,804-byte rendition ready 4 min 46 s after the
request through the ten-minute repair cron) supplied the cold case.

- **Warm, 11-second clip.** The owner's manual open at 13:40 and a deep-link
  relaunch at 13:58 fetched no video bytes at all; playback was under way two
  seconds after the launch, ran the clip through and stopped on its last frame
  behind a play control. The iOS viewer does not loop, where Android's does.
- **Cold, 6-second clip (launch 14:01:03).** The poster came up behind "Video
  couldn't load / Retry video" for about four seconds, then playback recovered
  by itself. Storage served the rendition three times inside those seconds: a
  full-body 200 at 14:01:07.98, a 206 for bytes 0–465803 at 14:01:08.82 and a
  206 for bytes 78156–465803 at 14:01:09.33, about 1.32 MB for a 466 KB file,
  every request on a fresh signature (Cloudflare MISS) and every one from the
  app's own loader (`MagicBooklet/47 CFNetwork`), not AppleCoreMedia.
- **Reopen after termination (14:01:40).** The same pattern again: a full 200
  and two full-range 206s (the second pair were Cloudflare HITs on one signed
  URL), about 1.4 MB, so the iOS cache held nothing from the cold open.
  Android's reopen of a route-form rendition was 0 bytes.
- **Third open (14:04:19).** No video request, but the viewer stayed on its
  poster behind a play control instead of autoplaying. A tap on that control
  at 14:06 started playback at once with no Storage request between 14:05 and
  14:11, so the cache had committed the clip after the reopen's clean
  playback. The iOS cache holds once a playback completes; the cold open's
  failed first attempt and the reopen that followed it are the anomaly.
- Every launch also fetches two 720px preview images, and the Creation details
  page appeared twice during the cold run with no launch from the Mac.

Follow-ups this opens: the iOS cold-open error and triple transfer of a
route-form rendition (the caching loader's handling of the route's 302 is the
first suspect; the 11-second clip cached from a run where the address was new
shows the cache can commit), the loop difference between the platforms, and
the autoplay difference between the first two launches and the third.

### iOS fetches a cold rendition three times (2026-09-08, 14:45–15:10 IST)

The iPhone run left two open questions: why a cold route-form rendition was
transferred three times, and why the viewer showed "Video couldn't load /
Retry video" for about four seconds first. A release build of current main
(0.1.4, embedded bundle, production environment) on the iPhone 17 Pro
simulator answers the first and separates the second.

The simulator is signed in as the test account and its video cache is a
directory (`Library/Caches/expo-video-cache`, one file per URL hash), so a
cold open is `rm -rf` plus a relaunch rather than a reinstall. Two runs of the
same 6-second clip (`ac95ad04`, 465,804-byte rendition), cache cleared before
each, differing only in when the deep link fired:

| Run | Deep link | Requests from the app | Server-committed bytes |
| --- | --- | --- | --- |
| A | at cold launch | 200 unranged; 206 `0-465803`; 206 `59912-465803` | 1,337,500 (2.87x) |
| B | 25 s after launch, session hydrated | 200 unranged; 206 `0-465803`; 206 `163424-465803` | 1,233,988 (2.65x) |

Both runs also show three `node` signing calls, one per app request: every
loader request goes through `/api/media` and mints a *new* signed URL, so the
stable address the route provides is stable only across opens, not within one.

The cause is expo-video's iOS cache, and the code states it plainly.
`ResourceLoaderDelegate` answers `AVAssetResourceLoader` with its own
`URLSession` (hence the `MagicBooklet/… CFNetwork` user agent rather than
AppleCoreMedia). Its first request is the content-information request, and
`addRangeHeaderFields` returns early whenever `contentInformationRequest` is
set, so that request carries no `Range` and the server answers 200 with the
whole file; the delegate reads the headers, fills in the content information
and only then cancels the task, so an unknown part of that body is already on
the wire. The second request is the real data request, and the third is
`attemptToRespondFromCache`'s partial path: the player asks again while the
second is still running, the delegate serves the prefix it has and requests
the remainder. Server-committed bytes are therefore an upper bound and the
true cost is between about 1.7x and 2.9x; the request count and the ranges are
exact. Android, measured through a byte-counting proxy, fetched each cold
rendition once (1.006x on the 16-second clip, 1.03x on the 4-second one).

The error plate did not reproduce on the simulator in either run, so it is not
caused by the deep link outrunning session hydration, which was the leading
hypothesis: run A opens the viewer before the session exists and still shows
only a spinner. The plate remains specific to the iPhone's App Store binary
(iOS build 47), whose native expo-video predates this build; the 30-second
`useVideoLoadDeadline` is far too long to explain a four-second plate, so it
was a genuine player error status there. It stays open, now scoped to that
binary rather than to the route.

A note on the earlier comparison: the Android deep-link script waits for the
Home screen before firing its link, while the iPhone run fired the link as the
launch itself. The two "cold deep-link" runs were therefore not equivalent.
Run B above is the like-for-like case, and it transfers the same three times.

Fix directions, none applied: patch `ResourceLoaderDelegate` so the
content-information request carries a small `Range` (this alone removes a
full-file response from every cold open, and `patch-package` is already in the
mobile toolchain, though a native patch needs a new binary rather than an
update); or reconsider `useCaching` per surface, trading one 2.9x cold open
for a 1x transfer on every open. Evidence and repro scripts:
`output/media-audit/sim-cold-open-ab.sh` and the `sim-A-*.png` / `sim-B-*.png`
frames.

### The content-information request now asks for two bytes (2026-09-08, 15:20–15:30 IST)

`patches/expo-video+55.0.21.patch` applies the first fix direction from the
entry above. The content-information request now carries `Range: bytes=0-1`,
which forces three related changes: a ranged response reports only its slice
in `Content-Length`, so the player's content length and the cached media info
both read the total from `Content-Range`; the cache accepts a 206 as a valid
description of a resource rather than only a 200; and the headers it replays
to the player as a synthetic 200 have the slice's `Content-Range` stripped and
`Content-Length` set to the total. A 206 is also taken as proof that the
server serves ranges. A server that ignores the range answers exactly as it
did before, so the change degrades to today's behaviour rather than failing.

Measured on the same simulator, release build, cache cleared, production data:

| Clip | Unpatched cold open | Patched cold open |
| --- | --- | --- |
| 465,804 B (6 s) | 1,337,500 B (2.87x) | 873,564 B (1.88x) |
| 1,475,359 B (11 s) | not measured unpatched | 1,475,361 B (1.00x) |

The first request drops from the whole file to two bytes in both. Whether the
remainder request also appears is timing-dependent: the 11-second clip's cold
open needed one transfer and nothing else, which is the Android figure.

The cache still works, which the metadata changes put at risk. After a cold
open the cached media info reads `expectedContentLength` 1,475,359 (the total,
not the two-byte slice), `loadedDataRangesArr` `[[0, 465804]]` for the smaller
clip, `Content-Range` absent from the stored headers, and the data file is the
full size. The third launch of a clip fetched nothing at all and played from
disk. The second launch still re-downloads, which is what the unpatched iPhone
did too (its second launch re-fetched and its third was clean), so that is
expo-video's own finalisation timing rather than anything this patch changed.

One "Video couldn't load" plate appeared on a second launch during this pass,
after the app had been terminated mid-download; it did not reproduce on a
clean cold-play-terminate-reopen cycle with the other clip. It is recorded but
not attributed to the patch.

Because `patches/` is a fingerprint input, this changes the runtime version on
both platforms: existing binaries can no longer take an update built from
main, and the saving only reaches users in the next store build. The
per-target release branches are unaffected.
