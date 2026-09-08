# Whole-app media delivery plan

Created: 2026-09-05. Scope: web, Android, iOS, and their shared backend.
Evidence and repairs from the first pass:
[media delivery audit](media-delivery-audit-2026-09-05.md).
Second-pass findings and video integrity results:
[6 September audit](media-delivery-audit-2026-09-06.md).
The current finding set, its egress attribution and the remaining priority
order: [8 September audit](media-delivery-audit-2026-09-08-final.md).

## September 6 checkpoint and release status

The completed reliability, layout-metadata and teaser-repair changes form an
independent release checkpoint. Further private-video optimization and broad
surface verification remain separate work; this checkpoint does not certify the
entire app. Earlier audit entries describe the working-tree state at that time.

The reliability checkpoint was merged as `85c137e` (PR #114). Production release
[33991876534](https://github.com/112kratoss/ugc-copy/actions/runs/33991876534)
completed successfully, applying migrations
`20260905192259_admit_legacy_stored_visual_previews.sql` and
`20260905201219_repair_ready_video_teasers.sql`. The live app-version endpoint was
rechecked during the second audit pass and still reports the full `85c137e` SHA.
Compatible production OTA updates were published for Android 70/71 and iOS 47/51.

The second pass on `fix/private-video-delivery` contains mobile viewer fixes
committed locally as `043f699`, followed by a locally validated private-video
producer, owner API signing and web viewer integration. These changes are not
included in the released checkpoint. The backend work adds migration
`20260905213637_private_generation_playback_renditions.sql`; it has passed clean
local replay and has not been applied to production.

Objective: reliable first display and playback with bounded transfer, decoding,
and memory costs across every media surface. Preserve original download quality
and private-media access controls. This is a defined work sequence; evidence can
change fix priority, but cannot silently remove surfaces from coverage.

## Work sequence and completion criteria

| Step | Work | Completion evidence | Current status |
| --- | --- | --- | --- |
| 1. Inventory and baseline | Map every renderer and caller to its source, preview, rendition, signing, cache, and repair path. Include images, video, audio, avatars, covers, uploaded references, and purchased files. Record current build and device versions. | Complete surface/component map, ownership rules, and comparable cold/warm load measurements. | Partial: 179 static media/player call sites across 65 files inventoried; dynamic paths and runtime baselines pending. |
| 2. Stored-media integrity | Find missing, corrupt, expired-provider, misclassified, or permanently skipped records. Verify original durability, upload handling, preview writers, and repair eligibility. | Full-decode audit with all rows accounted for; recoverable data repaired; unrecoverable rows explicitly tracked; regression tests for verified writer/repair defects. | Partial: 7 production repairs; 95 previews decode; 66 missing dimension pairs backfilled; 3 unavailable-source records remain. Shared generation/post readback hardening and legacy repair eligibility are released in `85c137e`. |
| 3. URL and cache lifetime | Trace private signed URLs, refresh/renewal, query cache age, stable object identities, CDN cache behavior, and native disk cache. Verify mobile authentication on fallback paths. | Expired URL, old query cache, failed signing, offline/reconnect, and background/foreground tests recover without request storms or access changes. | Private proxy fallback released: browser plus Android/iOS images. A genuinely expired storage URL recovered on iOS; offline/background and remaining renderers pending. |
| 4. Image delivery | Measure preview bytes and decode size against actual rendered size and device pixel ratio. Check thumbnails, original fallback, loading placeholders, prefetch, and duplicate backdrop loads. | Before/after transferred bytes, first-image time, and memory; readable images with no unbounded original downloads in grids. | 720px preview baseline measured; 66 missing dimensions backfilled. iOS grid fixture eliminated 48 separate measurement calls using rendered image metadata; Android cache alias reproduced and viewer source-key fix verified locally. Byte/time baselines and smaller variants pending. |
| 5. Video and audio delivery | Cover published posts and private creations. Check poster continuity, first frame, range requests, codecs, faststart, renditions/teasers, buffering, simultaneous players, release, seeking, and audio source recovery. | Playback and lifecycle tests across slow network, fast scrolling, backgrounding, and failed sources; measured startup, stalls, bytes, and memory. | Ready-video teaser repaired live and played on iOS; automatic repair released. Second pass: all 27 selected stored video objects fully decode and pass range checks; 3 originals lack fast-start. Private original baseline: 14 videos / 187 MB; largest local rendition 93.69% smaller. Private pipeline locally verified with a 91.60% smaller synthetic video, unchanged original and private range reads. Released: private renditions live and backfilled (14/14, 92.7% smaller); the 128 kB/s gate passes with one player per open on the audit and store builds. Audio and device stress checks pending. |
| 6. Surface integration | Apply verified shared fixes and inspect every applicable surface in the matrix below. Exercise production-like native binaries and web browsers. | Every surface has recorded normal/loading/error/retry and navigation outcomes. Native rendering defects require native reproduction and verification. | Android profile first pass, controlled Android viewer recovery and Android/iOS private-image fallback verified. Native viewer HTTP-503 failure reproduced on Android; visible retry and resumed playback verified locally on Android/iOS. Broad surface pass pending. |
| 7. Release and regression control | Run affected tests and required release checks; deploy through existing release workflows. Verify exact live web SHA and actual mobile runtime/build targets. Define delivery measurements and bounded integrity checks. | Exact-release evidence, post-release checks, rollback details, and actionable regression signals. | Both passes released: exact live `f246f80` confirmed after `0cf34e7` (#115) and the watchdog fix (#116); second-pass OTAs published to Android 65/70/71 and iOS 47/51 at their shipped fingerprints and confirmed landing on an Android store build. iPhone confirmed by telemetry and the owner's check; the rendition backfill is complete and re-measured; the stable-URL fix (#118) and the shared preview fix are released the same way. Broad device checks remain; no automation created. |

Steps 3–5 may produce independent fixes while the legacy-source recovery in step
2 is unresolved. A missing original must not block other optimization work or be
silently treated as repaired. Establish measurements in step 1 before choosing
numeric performance budgets or declaring an optimization successful.

## Surface coverage matrix

“Pending” means runtime behavior has not been audited, even if shared source code
was read. A shared component pass does not automatically complete its callers.
Map additional media callers discovered in step 1 into this table.

| Surface family | Web | Android | iOS |
| --- | --- | --- | --- |
| Home and feed media, including promotional previews | Pending | Initial observation only | Initial observation only |
| Showcase/Explore grids, carousels, and saved media | Pending | Pending | Pending |
| Own profile: Creations, Posts, Saved, archives | Partial: synthetic creation detail rendition playback | Partial: Creations/Posts; one real 404 and controlled corruption reproduction | Pending |
| Creator profiles, avatars, and covers | Pending | Pending | Pending |
| Post details, overlays, full viewers, and lightboxes | Pending | Partial: creation viewer rendition playback and failed-request retry | Partial: creation viewer rendition playback and failed-request retry via rendered handler |
| Creation inputs, uploads, results, and library/Studio | Partial: Studio and video result rendition playback/original download verified; result failed-link renewal and initial timeout checked in Chromium fixtures | Partial: video result playback/retry/close verified with injected completed state | Partial: video result playback/retry/close verified with injected completed state |
| Motion references and outputs | Partial: result rendition playback, original download and failed-link renewal checked in Chromium fixtures | Partial: result playback/retry/close verified with injected completed state | Partial: result playback/retry/close verified with injected completed state |
| Workflow node previews, results, and shared workflows | Partial: expanded video/motion rendition playback and renewal verified; generated video/motion cards use batched posters with no video players, including controlled poster failure/reconnect recovery. Input/approval cards now reuse matching posters or an Open video tile; controlled failures and expanded input Retry passed | Map supported consumers | Map supported consumers |
| Template catalog, details, demos, and run results | Partial: demo/run recovery and optimized run playback verified; new published demo optimization passed local Storage readback/decode/range checks; catalog poster reload and online-event recovery verified | Partial: detail/final/intermediate playback and recovery verified with synthetic API/auth; catalog poster failure and reload verified in emulator | Partial: detail/final/intermediate playback and recovery verified with synthetic API; catalog poster failure and reload verified in simulator |
| Marketplace, resource bundles, unlocks, and downloads | Partial: resource audio/video and detail/expanded playback handoff verified in Chromium fixtures; source expiry and purchase/unlock journey pending | Partial: reference image/video renewal and failure recovery in native fixture host; full purchase/unlock journey pending | Partial: reference image/video renewal and failure recovery in native fixture host; full purchase/unlock journey pending |
| Post composer, drafts, media reorder, and publish results | Partial: fully offscreen video pauses and stays paused on return in narrow Chromium composer; lightbox enrolled in shared policy, full authoring flow pending | Partial: edit-post lightbox poster-as-video bug reproduced/fixed; item switch and close verified | Partial: edit-post lightbox poster-as-video bug reproduced/fixed; item switch and close verified |
| Remaining image/audio/video/file renderers, including operator surfaces | Inventory pending | Inventory pending | Inventory pending |

## Common test cases

- Cold cache and warm cache, small and large media, legacy and newly created
  content, public and private content, and actual media with/without derivatives.
- Slow connection, request failure, source 404, expired signature, decode error,
  and recovery after reconnect. Keep these failure classes distinguishable.
- Fast scroll away/back, list recycling, carousel change, viewer open/close,
  navigation return, app background/foreground, and long sessions.
- Loading placeholder to first image/frame, poster retention until a frame
  exists, meaningful error state, and working retry/renewal.
- Bytes per grid/page/watch, time to image/first frame, playback stalls,
  concurrent players, decoded image dimensions, and memory before/after repeated
  navigation. Use physical Android and iOS devices for native performance claims.

## Working rules

1. Reproduce each proposed bug fix at its actual layer before changing behavior.
   Source-only findings stay identified as such until verified.
2. Prefer shared delivery fixes, then verify every affected caller. Maintain API
   contracts and the private/public storage boundary.
3. Record each finding as reproduced, source-only, fixed locally, verified in
   production, or blocked on specific evidence. Store repair receipts and avoid
   overwriting originals.
4. Update this plan and the audit evidence after each completed part. Do not
   call the whole app optimized while required surfaces or release checks remain.

## Immediate next action

Next, attribute repeated image-viewer traffic and retained memory on a physical
Android device using a comparable exact build; cover cache-cold/slow-network video
startup and physical iOS. Real local workflow share/import, credit/free unlock,
reel reentry and file downloads now have journey evidence. The paid-recipe reel
restore bug is fixed locally. The S24 Ultra store-build baseline is recorded below. Metadata probes now terminate
within four seconds; resource images and stored reel attachments renew explicitly;
non-resource audio now has a visible Reload path, using the authenticated media
route for stored sources. Browser component acceptance is recorded below. These
checks do not establish production-duration credentials or physical-device budgets.
The full app audit remains open. Native viewer
renewal now preserves playback state; real short-lived Storage signatures and a
20-minute background interval have local acceptance evidence (checkpoint below). Shared native
preview ownership/offscreen pause, actual Android/iOS background transitions,
Android radio-off retry/reconnect and iOS stalled-transport recovery now have
local acceptance evidence (see the native lifecycle checkpoint below).
Shared-workflow snapshot/import-preview media removal has local evidence; web
inline demos and run previews now pause offscreen and hand playback to the next
preview. The full share/import journey and other renderer families remain open.
New published video demo copies now use bounded optimization, and catalog poster failure/reload
has local web/Android/iOS acceptance evidence. Existing demo backfill, corrupt
poster repair and real long offline/background expiry remain open. Template demo
failed-link renewal and workflow input-editor failure/retry/close now have local
acceptance evidence.
The template-run rendition and canvas input/approval thumbnail checkpoint is
locally verified; its evidence and release boundaries are recorded below.

The private-video producer, durable metadata, batched owner signing, and
retention-aware deletion are committed locally in `14eedb0` and have passed local
database/Storage validation. The native viewer recovery fix in `330dfd6` and subsequent shared preview/lightbox
recovery have passed HTTP-503/retry verification on Android and iOS; both remain
unreleased. Chromium
Studio verifies rendition playback and original download selection. Finish native
playback/lifecycle checks and exact-release Quality before deploying the migration
and code through the existing release workflow. Worker upload/DB cancellation,
crash-orphan reclamation, and source-change requeue remain explicit limitations
in the September 6 audit.

Continue signed-URL/background recovery and device verification across the
surface matrix. Web creation/profile viewers and video/motion result pages now
select private playback. Result pages also renew failed links on Retry, verified
in Chromium fixtures. Expanded workflow video/motion previews also resolve the
generation descriptor. Generated video/motion node thumbnails now use batched
posters; template final and intermediate media renew on explicit Reload media.
Template final/intermediate rendition delivery and input/approval canvas cards now have local acceptance evidence. New demo encoding and catalog poster recovery now have local acceptance evidence; existing demo backfill and shared-workflow consumers remain open before claiming optimized delivery reaches every consumer. Keep all
source-only concerns distinct from reproduced defects and measured improvements.


Shared native `MediaPreview` and `MediaLightbox` now have locally verified
loading/error/retry behavior on Android and iOS. Template detail and the final
template-run result route were navigated with synthetic API responses; lightbox
used a native fixture host. A reproduced retained-screen playback leak is fixed
locally: detail and final-result players pause on navigation and stay paused on
return. Short background/return checks passed for detail previews; long expiry,
offline and physical-device performance checks remain open. Next surface
priority: intermediate template steps, actual expiry during playback,
real offline/reconnect, full unlock navigation, and remaining audio ownership.
Reference video Retry now renews via the resource endpoint; renewal denial and
pending navigation are visible inside the lightbox. Delayed responses cannot
reopen a closed preview. These passed controlled native failure/recovery checks
and remain unreleased. Reference open/navigation also renews through the resource endpoint
after controlled stale-link failures on both platforms; this used a component
fixture host and does not certify the purchased-resource journey. Motion result
playback/retry/close passed with injected completed state. Composer edit
lightbox source selection is now fixed locally after native reproduction: videos
use their media URI instead of their image poster. Video creation workspace
playback/retry/close also passed with synthetic completed state on both platforms.
Upload, publish, real provider completion and motion inputs still need their own checks.
Web video/motion results and expanded workflow output previews now resolve
renditions and offer Retry. Generated video/motion node thumbnails now use poster
images and remain clickable if the poster is unavailable. Video input and approval
cards now avoid loading video for thumbnails, reusing exact-output posters where available. Template run results and intermediate
steps can reload signed URLs through their owned-run API without regenerating.
Template run rendition delivery is locally verified for web, Android and iOS; catalog/demo playback remains open. Keep these findings distinct from the
verified full-screen viewer fix.

The shared mobile API request now keeps its timeout and caller cancellation active
until the response body finishes. Partial-body timeout and cancellation reproduced
in regression tests; a real local HTTP stall also timed out correctly. This is
locally verified request behavior, not a native black-media reproduction. Token
acquisition and the separate conditional catalog fetch remain outside this timer.

Reference image Retry now also renews rejected links. Denial feedback, pending
request deduplication, successful image display and close during delayed renewal
passed on both native platforms using the shared-component fixture host. Mobile
tests/typecheck and Android/iOS production exports passed. This remains local and
unreleased; it does not certify actual long-session expiry or the purchase journey.

Latest acceptance: real local Storage signed-link expiration followed by explicit
Retry recovered reference images and videos on Android and iOS. Actual Android
airplane-mode/network loss produced visible renewal errors; explicit Retry after
reconnect recovered both media kinds without restarting the app. iOS intermediate
template video steps passed controlled failure/retry and navigation pause/return.
Android intermediate steps currently need an authenticated route session. These
are partial surface checks; iOS offline, uninterrupted-playback expiry, viewport
player ownership and physical-device measurements remain open. See the detailed
September 6 evidence for fixture boundaries and current release status.

Shared preview source replacement now preserves playback position and paused or
playing state for the same media item. Android/iOS reproduction showed paused
videos unexpectedly restarting before the fix; native checks now preserve pause,
continue a 40-second clip from its position and keep hidden players paused.
Different media items and explicit Retry retain their existing behavior. Mobile
tests/typecheck and clean production exports passed. Actual expiry-timer and
authenticated-redirect integration during playback remain separate open checks.


Latest checkpoint (template playback and workflow input/approval cards): owned
run responses now batch-sign source-matched ready playback renditions separately
from original URLs. Web and mobile consume the optional playback fields; web also
uses posters. A shared wire fixture covers old responses and mobile relative URLs.
Chromium final/intermediate playback, failed-link renewal, original download
selection, and canvas poster/open/retry behavior passed. Android/iOS final and
intermediate playback passed controlled runtime checks; Android used an in-memory
synthetic auth context because its development session was signed out. This does
not certify the real sign-in or paid template execution journey. No deployment or
new migration was performed for this checkpoint.

Next work: optimized published demo files and catalog poster recovery; then
shared-workflow media, viewport player ownership and iOS offline recovery. Actual long-session expiry during playback and physical-device transfer,
startup and memory measurements remain required before closing the whole-app audit.


Latest demo/editor checkpoint: explicit demo Retry renews through the existing
catalog endpoint on web, Android and iOS; workflow input-editor Retry recovers a
failed request and closing the editor removes its player. Catalog signing failure
now remains null, and the publishing poster writer uses a byte-preserving Blob
upload with real local Storage readback. These changes are local and need no new
migration. Existing demo transcoding/backfill and catalog poster recovery remain
open; this is a reliability checkpoint, not complete demo optimization.


Latest template checkpoint: new video demo copies use the existing fast-start
encoder with a 64 MiB input gate and 60-second deadline, retaining the original
copy when encoding is unavailable or not smaller. A local Storage fixture saved
91.60%, fully decoded, passed range reads and left its source unchanged. Catalog
posters recovered after controlled failures in Chromium, Android and iOS; web
reconnect-event recovery also passed. These changes remain local, require no new
migration, and do not backfill existing published versions. See the September 6
audit's “Published demo size and catalog poster recovery” section for evidence
and remaining limits.


Web inline playback checkpoint: template demos and final/intermediate results
now pause completely offscreen, stay paused on return and allow only one enrolled
inline preview to play at a time. Chromium reproduced both offscreen continuation
and simultaneous approval playback before the fix. Workflow output/input-editor
play and close remain verified. Shared-workflow import previews have zero media
players and use sanitized structure snapshots. Actual background-tab transitions,
native offscreen behavior, physical-device budgets and the full share/import
journey remain open. See the September 6 audit for exact scope and evidence.


## Native preview lifecycle and transport recovery checkpoint (2026-09-06)

Fixed locally after Android/iOS reproduction: shared recoverable previews now
pause completely offscreen within `Screen`, hand playback to the next enrolled
preview, and stay paused on viewport or app return. The scroll container supplies
viewport measurements through scroll/layout events, without per-player timers or
React scroll-state updates. Feed/viewer players keep their separate policies.

A cold request accepted by a local server but receiving no response kept iOS
loading for over a minute before its eventual native error. A 30-second loading
budget now shows the existing Retry control and clears the stalled native source.
Retry creates a fresh player and retains the existing URL-renewal path. Ready
playback cancels the budget. Native fullscreen bypasses inline clipping only.

Actual simulator/emulator checks: offscreen pause/no return resume and competing
players on both platforms; background/return on both; Android with airplane mode,
Wi-Fi and mobile data disabled showed Retry, then rendered video after connection
restoration and explicit Retry. iOS stalled TCP transport showed Retry and rendered
a 40-second fixture after server recovery. iOS radio-off, long credential expiry,
physical-device memory/transfer budgets and other renderer families remain open.
These are development-client correctness checks, not store-binary performance
certification. All 1,812 mobile tests, mobile typecheck and both production exports
with bundled-client environment verification pass. No new migration or deployment.
Details and evidence: `docs/media-delivery-audit-2026-09-06.md`.


## Viewer expiry continuity and remaining native players (2026-09-06)

Fixed a native fullscreen viewer renewal defect reproduced on iOS: a video paused
at 23 seconds restarted when its source changed to the authenticated renewal path.
Renewal now preserves position, pause/play, volume and rate. The viewer has explicit
background pause and shares the preview's 30-second stalled-load deadline; loading
has a spinner and failed/timed-out playback uses its existing Retry control.

Real local Storage signatures with a 75-second lifetime exercised the existing
30-second early-renewal boundary. Android continued playing across renewal; iOS
remained paused at 23 seconds. Fresh sessions remained backgrounded about 20 minutes
and returned paused at their previous positions (Android 23s, iOS 15.31s). Explicit
Play worked on both. This is a real elapsed expiry boundary using shortened local
lifetimes, not a production-duration token/session or physical-device certificate.

The remaining native player inventory is complete: shared recoverable previews,
feed player and fullscreen viewer. Feed activation/deactivation was exercised on
both platforms, with zero native video views after deactivation. Native reference
audio opens externally after resolving a fresh URL; there is no separate native
audio player. Feed buffering still follows its existing 8-second preference and
one-active-preview policy; this is source evidence, not measured memory/bytes.
Web composer, marketplace/resource players, carousel/studio and audio players
remain explicit follow-up surfaces. Evidence: `docs/media-delivery-audit-2026-09-06.md`.


## Web audio and controlled video ownership (2026-09-06)

Workflow node/editor/expanded audio, creation audio, video-generation reference
media, composer previews/lightbox and resource/detail audio/video now use shared
playback ownership. Starting an enrolled player pauses its predecessor. Leaving
the viewport or hiding the document pauses playback; returning does not resume.
Audio previews default to preload none. Explicit video picture-in-picture keeps
its existing background exception. Passive poster/metadata thumbnails are unchanged.

Chromium reproduced simultaneous workflow node/editor audio, resource audio/video
and resource/detail playback before the change; the same paths now hand off to
one player. Closing the expanded preview leaves the underlying player paused.
The narrow composer reproduced continued video playback fully offscreen; the fix
pauses it and keeps it paused when scrolled back. Hidden-document event tests
pass, but this automation session continued reporting visible after switching
tabs, so a real browser-background transition is still unverified.

CreatorStudio upload/modal, HoverVideo and ShowcaseMediaCarousel remain separate
playback policies requiring runtime checks. Resource/audio expired-source and
reconnect recovery, full unlock/share/import journeys, and physical-device
performance are still open. This checkpoint requires no new migration and is not
deployed. Details and validation: docs/media-delivery-audit-2026-09-06.md.


## Studio, hover/carousel and resource recovery (2026-09-07)

Studio upload previews/modal and showcase carousel videos now share inline media
ownership, offscreen pause and hidden-document pause. Opening Studio's expanded
preview pauses its thumbnail; closing leaves it paused. Hover previews now load
only within the actual viewport and visible document, retaining reduced-motion
and data-saver gates. They detach while hidden/offscreen; decorative autoplay may
resume when eligible again. Controlled Studio/carousel/resource playback remains
paused on document return.

Resource audio/video previews in post details and reel resources now provide
loading/error/Reload states. Signing and loading have a 30-second budget. Explicit
Reload obtains a fresh URL through the same authorized endpoint, aborts obsolete
requests, and does not autoplay. Audio keeps preload none and has no idle timeout.
Source failure removes the player until retry. Images and attachment links retain
their existing paths and remain separate renewal work.

Chromium fixtures reproduced and verified offscreen/handoff failures, rejected
URLs, actual short-lived private Storage signatures, offline signing/reconnect and
30.5-second stalled-signing recovery. A separate Chrome process connected without
Playwright focus overrides recorded real hidden/visible events: Studio, carousel
and resource audio pause and remain paused on return; hover detaches while hidden.
These are local component/browser checks, not full purchase/reel journeys, physical
mobile browser certification, or production-duration session measurements.
No new migration or deployment. Evidence: docs/media-delivery-audit-2026-09-06.md,
“Studio, hover/carousel and resource recovery (2026-09-07)”.


## Metadata, resource images/attachments and other audio (2026-09-07)

The workflow metadata probe remained pending beyond six seconds under a stalled
transport. Workflow, motion and composer now share a four-second metadata helper
with listener/source/object-URL cleanup and abort support. Unknown metadata
returns null; the server remains authoritative. Motion cancels replaced probes
and reports unreadable metadata through its existing error UI. Chromium verified
normal 40-second duration and stalled completion at roughly 4.3 seconds.

Resource images use the existing bounded loading/Reload component in post details,
reel reference thumbnails and the expanded reel image. Reload signs again through
the same authorized endpoint. Reel stored attachments now sign on every Open,
reserve a tab during the click, sever its opener, and close it on failure/unmount.
A 30-second deadline and visible error permit retry; popup blocking is explicit.
Post-detail Open/Download already obtained fresh URLs and retain those paths.

All remaining web audio controls now share recovery in MediaDetails, creation
cards, workflow nodes/editors/overlays and video-generation references. Stored
sources retry through /api/media; external/provider/blob URLs can only retry their
existing source. Initial user-opened autoplay is retained, while Reload stays
paused. Creation cards avoid idle metadata downloads/spinners and retain Restore.

Browser checks verified broken-image recovery, failed audio retry, canonical
stored-audio proxy routing, normal/stalled metadata, and actual reel thumbnail /
expanded image recovery plus distinct freshly signed attachment opens. This is
local fixture evidence, not production purchase/share/import or every caller’s
full journey. No new migration or deployment. Evidence: the September 6 audit
journal’s “Metadata probes, images/attachments and non-resource audio” entry.


## Browser journeys and physical Android baseline (2026-09-07)

Real local accounts completed workflow Share/Copy/import/reload with private media
stripped and instructions preserved. Credit unlock and free reel unlock produced
one receipt each. Unpurchased file access returned 403; purchased access returned
200. Actual unlocked image/video/audio playback and two guide downloads passed.
Paid purchases made outside the reel were incorrectly shown as locked on reel
entry; the reel now refreshes paid access using the existing authorized endpoint.

The physical Samsung S24 Ultra (installed 0.1.4/build 71; OTA id unverified) showed
profile media and video playback. Process-cold activity start was 525–578ms with
existing disk cache; one repeat's feed image was visible by a 3.9-second screenshot.
The initial repeated-open measurement was invalidated: fixed-coordinate taps
selected different creations after the grid moved. Use the identity-matched
measurements below instead. These store-build observations are not an exact-build
optimization result or a proven memory leak. Physical iOS remains open.

This pass originally used /private/tmp/magicbooklet-media-journeys on
fix/private-video-delivery; the persistent recovery location is recorded below.
Evidence and measurement limits: September 6 audit journal, “Complete browser
journeys and first physical Android baseline”. No migration or deployment.


## Native backdrop cache follow-up (2026-09-07)

The native viewer re-downloaded blurred previews when signed URLs renewed because
its backdrop lacked a stable cache identity. It now uses the descriptor's preview
key, separate from the full-size image key. Android and iOS simulator checks reuse
both layers after renewal and memory-cache eviction/reopen; changed media versions
still fetch replacement assets. All 1,821 mobile tests, typecheck, both native
exports and bundled environment checks pass. No new migration or deployment.

The physical S24 Ultra has reconnected. Next remains exact-build image-viewer
traffic/memory measurement, followed by cache-cold and slow-network video startup.
The simulator cache finding does not account for all of the prior phone traffic
or establish a memory leak. The release audit APK is now installed on the S24
Ultra and its pulled SHA-256 matches the artifact built from `4c8c6c4`.
The earlier fixed-coordinate 117 KiB/open baseline was not a valid same-image
comparison: grid movement could select different creations. Identity-matched
store-build checks added zero RX bytes over three direct-Wi-Fi opens. See the
journal's physical baseline correction for memory figures and evidence limits.
Work now resides at `/Users/athuls/.codex/worktrees/media-delivery-audit` after
the temporary worktree disappeared.

## Exact Android build: image reuse and throttled private video (2026-09-07)

The separate release audit APK at `4c8c6c4` signed into the supplied test account.
Three process-cold launches took 539–723ms at the activity level. Two had feed
media in the three-second capture; the third still showed a skeleton there and
had media in the six-second capture. These launches retained disk cache.

Ten identity-matched immersive image reopens added zero Storage-host RX bytes
after the first 3,083,801-byte transfer. API refreshes added 173,823 bytes in total.
Open PSS ranged 569–629 MiB and final return PSS was 601 MiB, above the initial
416 MiB feed baseline. Retention and broader multi-asset stress remain open;
this short run proves neither a leak nor a before/after memory improvement.

At a shared 128,000-byte/second downlink cap, an unopened private video retained
its poster, began rendering frames, buffered repeatedly, and eventually exposed
Retry video. Production metadata identifies a 13,063,623-byte, 11-second source
and confirms the private playback-rendition columns are not deployed. Smaller
private playback files must be deployed/backfilled and remeasured before closing
the slow-network gate. The retry measurement was interrupted by a phone call and
is not a completed recovery check. Normal phone proxy settings were restored.

Follow-up physical checks reproduced lost explicit pause after background/source
refresh. The signed-URL React key remounted the player and discarded continuity
state. The viewer now retains that state for the same media and remounts only on
Retry or different media. A rebuilt, installed release preserves a settled paused
frame through background/return; manual Play resumes normally. All 1,821 mobile
tests, typecheck, iOS export and Android release/bundle-env checks pass.

Cached video played with both Wi-Fi and mobile data disabled. An unopened full-size
image showed a visible retry fallback offline and loaded after reconnection/retry.
Normal network settings were restored. The previously-playing background case
now stays paused on return, and a 30-cycle image/video soak showed no retained
growth; see the playback gate section below. Updated-backend cache-cold
rendition playback, physical iOS and the full release/production audit remain
open. Detailed limits
and local evidence are in the September 6 journal's exact-build Android entries.


## Viewer playback gate, quick-exit tap and autoplay race (2026-09-07)

The gate checkpoint's phone verification is complete on a rebuilt audit APK,
after fixing a race it exposed. The viewer refetches its source on every open,
the freshly signed URL replaces the native player about a second later, and the
replacement copied "not playing yet" as a pause: two of roughly ten opens on the
S24 Ultra never started while showing the playing label over a still frame. A
replaced player now keeps its playback request unless it was ready and paused,
the viewer's badge follows that decision, and a gate revoke clears it. On the
installed build, five fresh opens (two cold) autoplay; three Pause-then-Home
cycles, Home while playing and Home during the initial load all return paused;
manual Play resumes and Pause holds. A 30-cycle two-image/one-video soak in one
process showed no upward trend on return and settled 12 MiB below its grid
baseline after two minutes idle. Mobile tests (191 files / 1,828 tests),
typecheck, the Android release build with bundled-environment verification and
the iOS Hermes export pass. Remaining: the same `previous.playing` pattern in
the shared preview component (source-only, not reproduced), the two player
creations per open, physical iOS, and the production-duration checks above.
Evidence and limits: the September 6 journal's "Viewer playback gate, quick-exit
tap and replaced-player autoplay" entry.


## Second pass released (2026-09-07)

PR #115 is live as `0cf34e7` with the private rendition migration applied, and
the watchdog fix followed as `f246f80` (#116). Five over-the-air updates went out
from per-target release branches at the shipped fingerprints; an Android store
build picked one up on its next cold start. The rendition backfill drains one
generation per ten-minute repair run. Next: confirm the update on a physical
iPhone (App Store 0.1.2 or TestFlight 0.1.4), re-measure slow-network private
playback once the backfill completes, then the shared preview replacement
pattern and the remaining surface matrix. Evidence: the September 6 journal's
"Release of the second pass" entry.

## Route-form playback addresses (2026-09-08)

Owner-generation renditions (#124, `49c8953`) and template-run renditions
(#125, `e394694`) are addressed through `/api/media` instead of signed Storage
URLs, so the native cache key no longer changes with each signature: the audit
build measured a warm reopen and an after-restart reopen at 0 bytes, and the
store build's cold open is one download with free looping. A deep-link open
of a 16-second clip at 48 kB/s (download 2.2× the clip length) also produced
one connection and looped without re-fetching, so the 11-second double
download from the audit build is recorded as unreproduced. Workflow persisted
outputs keep the signed form because the same address feeds downstream
provider inputs. The watchdog degraded threshold is 96 hours.

## Unavailable sources made explicit (2026-09-08)

`source_unavailable_at` on `generations` and `post_media` (migration
`20260908061500`) is the durable statement that a record's only source is
gone. The owner API withholds every address for a marked generation, post
media summaries carry the marker with a failed preview status, the preview
repair job sets it after a second 404/410 from an external source, and web
and mobile render "This file is no longer available" with no retry. The three
audit records are marked; nothing was deleted. Remaining backlog: the surface
matrix, physical iOS baseline, thumbnails, sampler, fast-start audit and
worker attempt count. Evidence: the September 6 journal's 2026-09-08 entries.

## Physical iOS baseline (2026-09-08)

Measured on the iPhone 16e (App Store build 47 with the #126 update) with
deep-link launches, QuickTime's USB mirror and the Supabase edge logs. Warm
opens of a cached route-form rendition transfer nothing and play within two
seconds; the iOS viewer does not loop. A cold route-form rendition shows
"Video couldn't load / Retry video" for about four seconds before recovering
and is transferred three times (about 1.32 MB for a 466 KB clip), and a
reopen after termination repeats the three transfers, where Android's reopen
was 0 bytes; the cache commits only after a clean playback (the third open
and a tapped play fetched nothing). Open: the iOS cold-open
error and triple transfer (the caching loader and the route's 302), the
loop and autoplay differences, and the rest of the backlog (surface matrix,
thumbnails, sampler, fast-start audit, worker attempt count). Evidence: the
September 6 journal's "Physical iOS baseline" entry.

## iOS cold opens cost three transfers (2026-09-08)

Reproduced on the iPhone 17 Pro simulator with a release build of main: one
cold open of a route-form rendition makes three requests (an unranged
content-information request the server answers in full, the data request, and
a remainder request) and mints three signed URLs, for 2.65-2.87x the file in
server-committed bytes against 1.0x on Android. The cause is expo-video's iOS
`ResourceLoaderDelegate`, whose content-information request carries no
`Range`. Fix directions are recorded in the journal; none applied. The
iPhone-only "Video couldn't load" plate did not reproduce on the simulator and
is now scoped to the shipped iOS binary, not to the route. Evidence: the
September 6 journal's "iOS fetches a cold rendition three times" entry.

## iOS content-information request bounded (2026-09-08)

`patches/expo-video+55.0.21.patch` gives expo-video's iOS content-information
request a two-byte range, and reads the resource length from `Content-Range`
so a ranged response still describes the whole file to both the player and the
cache. A cold open drops from 2.87x the file to 1.88x on a 466 KB clip and to
1.00x on a 1.4 MB one; the cache still commits and a later launch fetches
nothing. `patches/` is a fingerprint input, so this needs a new binary on both
platforms and does not reach existing installs over the air. Evidence: the
September 6 journal's "The content-information request now asks for two bytes"
entry.

## Generation publishes carry their public media row (2026-09-08)

Publishing a generation copied its output into the public bucket and recorded
the path on `posts.showcase_asset_path`, but wrote no `post_media` row. Every
public derivative pipeline — preview, feed rendition, teaser and their repair
sweeps — reads `post_media`, so those posts never received a public preview or
a smaller playback file, and the feed served them through the legacy cover
instead: a fresh signature of the owner's *private* preview on every read,
which the CDN can never reuse, plus the full-size copy where a rendition could
exist. Measured on 8 September: 6,169 preview signatures in 24 hours across 23
paths, 92% of signed-preview reads a Cloudflare miss, and one public video
(`40cac994`) streaming 1.56 MB where a 177 KB rendition already existed.

Four changes close it. `ensureGenerationPostCoverMedia` writes the cover row at
publish, with its derivatives pending so the ten-minute sweeps build them —
nothing regresses while they wait, because a cover with no poster still gets
the generation's preview grafted on and a pending rendition keeps the feed
poster-only. It is called from both routes that expose a post: the publish
route and the post editor, which creates its own derivative and whose private
flip deletes the row.

The repair sweeps had to be taught to accept these rows. Since `e8e30a7`
(2026-08-20) `getCanonicalPostMediaPath` required media to sit under
`posts/<post id>/`, but a generation-backed post's public copy lives under
`showcase/<generation id>/`; the sweep claimed such a row, threw, and spent all
three attempts. It now also accepts the generation prefix, with the generation
id read from the owning post row rather than the path, so the scope stays
server-derived. The existing `showcase/` rows were built on 2026-06-19, before
that guard, which is why nothing looked broken: they were already `ready` and
never re-claimed.

Migration `20260908180000` backfills the five exposed posts that predate this.
`loadGenerationPreviewInfoMap` now signs a preview only for the covers that
will actually be grafted onto, which is what stops the signing for good once a
post has a public poster of its own; the showcase feed and both owner surfaces
pass that set, as a promise so the generation read still runs in parallel.

The row is idempotent across republishes: one already serving the current
derivative is left untouched, so an edit never discards a preview or rendition
already built, and one pointing at a superseded derivative is repointed with
its derivative columns cleared. Teardown was already in place —
`removeGenerationShowcaseDerivative` retires these rows and their objects when
a post goes private. A failure to write the row never fails the publish: the
post is committed by then, and it serves the legacy way until a later publish
writes the row.

Two gaps stay open, neither a regression. `claim_post_media_teaser_repair`
still requires a `posts/<post id>/` rendition path, so a generation-published
video over 30 seconds gets a rendition but never a teaser (no such video exists
today). And a repointed row strands the superseded object and its derivatives
in the public bucket: nothing collects them, because
`removeGenerationShowcaseDerivative` only sees the path the post currently
points at.

Close by confirming the anonymous home payload carries no `/object/sign/` URL
and every public video has a `.feed.` rendition. Evidence and the surrounding
finding set: [8 September audit](media-delivery-audit-2026-09-08-final.md).
