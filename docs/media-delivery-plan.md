# Whole-app media delivery plan

Created: 2026-09-05. Scope: web, Android, iOS, and their shared backend.
Evidence and repairs from the first pass:
[media delivery audit](media-delivery-audit-2026-09-05.md).
Second-pass findings and video integrity results:
[6 September audit](media-delivery-audit-2026-09-06.md).

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
| 5. Video and audio delivery | Cover published posts and private creations. Check poster continuity, first frame, range requests, codecs, faststart, renditions/teasers, buffering, simultaneous players, release, seeking, and audio source recovery. | Playback and lifecycle tests across slow network, fast scrolling, backgrounding, and failed sources; measured startup, stalls, bytes, and memory. | Ready-video teaser repaired live and played on iOS; automatic repair released. Second pass: all 27 selected stored video objects fully decode and pass range checks; 3 originals lack fast-start. Private original baseline: 14 videos / 187 MB; largest local rendition 93.69% smaller. Private pipeline locally verified with a 91.60% smaller synthetic video, unchanged original and private range reads. Release, audio and device stress checks pending. |
| 6. Surface integration | Apply verified shared fixes and inspect every applicable surface in the matrix below. Exercise production-like native binaries and web browsers. | Every surface has recorded normal/loading/error/retry and navigation outcomes. Native rendering defects require native reproduction and verification. | Android profile first pass, controlled Android viewer recovery and Android/iOS private-image fallback verified. Native viewer HTTP-503 failure reproduced on Android; visible retry and resumed playback verified locally on Android/iOS. Broad surface pass pending. |
| 7. Release and regression control | Run affected tests and required release checks; deploy through existing release workflows. Verify exact live web SHA and actual mobile runtime/build targets. Define delivery measurements and bounded integrity checks. | Exact-release evidence, post-release checks, rollback details, and actionable regression signals. | Reliability checkpoint released: exact live `85c137e` confirmed; Android 70/71 and iOS 47/51 production OTAs published. Second-pass client and private playback backend changes remain local. Broad device checks remain; no automation created. |

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
| Marketplace, resource bundles, unlocks, and downloads | Pending | Partial: reference image/video renewal and failure recovery in native fixture host; full purchase/unlock journey pending | Partial: reference image/video renewal and failure recovery in native fixture host; full purchase/unlock journey pending |
| Post composer, drafts, media reorder, and publish results | Pending | Partial: edit-post lightbox poster-as-video bug reproduced/fixed; item switch and close verified | Partial: edit-post lightbox poster-as-video bug reproduced/fixed; item switch and close verified |
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

Continue long-session signed-URL expiry during playback and background recovery,
then viewport budgeting for the remaining renderer families. Shared native
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
