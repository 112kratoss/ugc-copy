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
| Private generation encoding and owner API | Measured 14 originals / 187 MB; no durable private rendition metadata or owner descriptor rendition. Largest local encode was 93.69% smaller in the first pass. | Add bounded producer, signing, retention-aware cleanup and original-preserving publication; measure playback on devices. |
| Web profile/Creations viewers | Source review: generation previews and detail modals receive `output_url`; published posts already use playback resolvers. | Integrate generation playback descriptors and test the browser's selected requests. |
| Creation/motion results, workflows, templates | Source review: direct video elements consume result URLs. No common renewal/rendition integration is established across these callers. | Check expiry, poster continuity, background return and the original/download distinction on each supported surface. |
| Full-rendition worker interruption | Source review: `claim_media_rendition_repairs` leases without incrementing attempts; the worker increments at terminal updates. A process killed before that update may retain its attempt count. | Reproduce lease-expiry/crash exhaustion locally before changing claim semantics; account for claimed rows deferred by the time budget. |
| Generation deletion | Source review: single deletion selects original/showcase paths, not preview metadata. Linked posts retain outputs. | Reproduce orphan behavior and audit all references before adding derivative cleanup; no orphan purge has been performed. |
| Remaining device coverage | Offline/reconnect, background expiry, rapid navigation, audio/resources, avatars/covers and physical-device performance remain incomplete. | Continue the whole-app matrix; do not infer caller coverage from shared unit tests. |

## Validation and evidence

- Mobile: 183 test files / 1,774 tests passed under Node 24; typecheck passed.
- Android and iOS production-configured Hermes exports passed. Existing bundle
  configuration verification found no missing required client values.
- Android native cache reproduction and helper verification passed as described.
- Production: all 27 selected video objects decoded and passed range checks.
- No web/backend code or schema changed, so this pass did not repeat their full
  suites or database replay. Native exports are not store builds or OTA releases.

Ignored local evidence in `output/media-audit/`: `private-descriptor-before.log`,
`private-descriptor-after.log`, `viewer-cache-before.log`,
`mobile-tests-second-pass-final.log`, `android-cache-collision-before.json`,
`android-cache-isolation-control.json`, `android-cache-verification-after.json`,
`video-integrity-second-pass.json`, `video-integrity-legacy-second-pass.json`,
and `native-exports-second-pass-verification.jsonl`. Bounded read-only audit and
synthetic native fixture scripts are kept alongside those receipts.
