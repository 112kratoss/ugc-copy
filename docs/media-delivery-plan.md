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
| Creation inputs, uploads, results, and library/Studio | Partial: Studio rendition playback and original download verified | Pending | Pending |
| Motion references and outputs | Pending | Pending | Pending |
| Workflow node previews, results, and shared workflows | Pending | Map supported consumers | Map supported consumers |
| Template catalog, details, demos, and run results | Pending | Partial: detail and final-run video failure/retry/navigation verified with synthetic responses | Partial: detail and final-run video failure/retry/navigation verified with synthetic responses |
| Marketplace, resource bundles, unlocks, and downloads | Pending | Pending | Pending |
| Post composer, drafts, media reorder, and publish results | Pending | Pending | Pending |
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
surface matrix. Web creation/profile viewers now select private playback; generation result
pages, workflow previews and template results still need integration review
before claiming private renditions reach every consumer. Keep all
source-only concerns distinct from reproduced defects and measured improvements.


Shared native `MediaPreview` and `MediaLightbox` now have locally verified
loading/error/retry behavior on Android and iOS. Template detail and the final
template-run result route were navigated with synthetic API responses; lightbox
used a native fixture host. A reproduced retained-screen playback leak is fixed
locally: detail and final-result players pause on navigation and stay paused on
return. Short background/return checks passed for detail previews; long expiry,
offline and physical-device performance checks remain open. Next surface
priority: creation/motion results, intermediate template steps and composer/reference
lightbox navigation, then private URL expiry and remaining audio ownership. Source review found direct result URL consumers in web video/motion
results and workflow previews; their rendition and expiry integration remains
pending. Keep these findings distinct from the verified full-screen viewer fix.
