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
