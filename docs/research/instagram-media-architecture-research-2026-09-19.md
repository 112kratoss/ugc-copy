# Instagram media delivery and native architecture: audit and implementation plan

Research date: 2026-09-19. Scope: public engineering research, existing physical-device evidence, and inspection of Magicbooklet's current working tree. This document proposes future work; it does not change the release currently being prepared.

## 1. Decision

Build a small native media subsystem with shared ownership, bounded preloading, first-frame readiness, and platform-specific playback. Keep product state and ordinary screens in React Native. Consider a native viewer/pager only after isolating its mounting cost. A store build is an opportunity to ship a coherent media foundation, but is not a reason to rewrite unrelated controls.

The most consequential new evidence is Google's March 2026 Instagram case study: Android Reels uses Media3 preloading, separating prepared media from multiple warmed player instances. On iOS, Meta explicitly describes a lower-level playback stack for HDR. Those are different platform implementations under similar product behavior.

This is a bounded reconstruction, not a complete inventory of Instagram's private implementation. Exact cache sizes, preload counts, experiment variants, CDN routing, and implementation of every screen remain unknown. No new Instagram network or device experiments were performed for this document; device findings below come from the earlier local audit.

## 2. Evidence rules and corrections

- **Published:** explicit first-party engineering documentation; scope and publication date matter.
- **Observed:** the earlier device audit, specific app versions and scenarios. A view dump or library name supports a narrow observation, not proof of all execution paths.
- **Proposed:** our architecture or starting tuning values, to be validated.
- **Unknown:** unavailable implementation details. Do not replace them with system-design interview diagrams or guessed constants.

Correct the earlier statement “Instagram is native throughout.” We observed native media surfaces on Android, and public documentation confirms specific native frameworks. Instagram has also historically integrated React Native. Absence of React Native in a sampled tree cannot establish absence across the app. Similarly, a native library name does not prove that it handled a particular video.

Do not interpret a preload window, list window, or feed response count as the number of fully downloaded videos. They measure different resources.

## 3. What Instagram publicly establishes

### Android preload architecture

Google's 2026 case study reports that Facebook and Instagram integrated `DefaultPreloadManager`, sharing resources with ExoPlayer. Instagram Reels uses adjacent, bidirectional media preparation. CPU and I/O stress can suspend preloading. It does not publish a fixed neighbor count, exact buffered duration, or disk budget. The example of preloading only the current video belongs to Facebook News Feed, not a confirmed Instagram Home policy. [Google case study, March 2026](https://android-developers.googleblog.com/2026/03/instagram-and-facebook-deliver-instant.html).

This matters to us because warming more complete players increases decoder and memory pressure. A candidate can have bytes or compressed samples ready without owning a visible view or a separate active decoder.

### iOS rendering and codecs

Meta's November 2025 article explicitly describes Instagram iOS HDR rendering through `AVSampleBufferDisplayLayer`, within a decoupled lower-level pipeline rather than a typical high-level AVPlayer setup. It also describes preserving Dolby Vision metadata through encoding and playback. This proves the HDR path, not every SDR, Stories, camera, or Live path. [Meta iOS HDR architecture](https://engineering.fb.com/2025/11/17/ios/enhancing-hdr-on-instagram-for-ios-with-dolby-vision/).

Meta documented integrating dav1d for AV1 decoding on both platforms in 2023 and delivering mixed-codec adaptive manifests. That historical implementation should not be treated as a current universal software-decoding requirement. For our app, compatible system decoding and measured power use should determine codec choice. [Meta AV1 engineering](https://engineering.fb.com/2023/02/21/video-engineering/av1-codec-facebook-instagram-reels/).

### Lists and composition

Instagram maintains IGListKit and states that its main branch is used in the app. It is a reusable, diff-driven framework built on UICollectionView. The repository does not enumerate which current screens use it. [Instagram IGListKit](https://github.com/Instagram/IGListKit).

The earlier Android hierarchy audit observed Litho ComponentHost instances in Instagram's reel. Meta's historical Facebook article explains view preallocation and background preparation with Litho; it is useful design precedent, not a current Instagram-wide component specification. [Facebook Litho video engineering, 2018](https://engineering.fb.com/2018/01/31/android/improving-android-video-on-news-feed-with-litho/).

### Encoding and delivery

Instagram documented compatibility encodings and higher-efficiency advanced encodings, with adaptive bitrate playback and progressive fallbacks for older clients. Our inference is to keep a compatible baseline rendition and add more renditions only where network/quality measurements justify their cost. [Instagram encoding system, 2022](https://engineering.fb.com/2022/11/04/web/instagram-video-processing-encoding-reduction/).

Meta confirmed QUIC deployment on Instagram iOS and Android in 2020. It also reported that changing transport required retuning request concurrency and bandwidth estimation in Facebook. HTTP/3 support alone does not establish which protocol a given installed player negotiated. [Meta QUIC deployment](https://engineering.fb.com/2020/10/21/networking-traffic/how-facebook-is-bringing-quic-to-billions/).

Facebook's documented 2024 delivery system separates recommendation fetching, a memory pool of stories, and media prefetch. Its “three or fewer” threshold triggers a feed request; it is neither an Instagram constant nor three fully downloaded videos. [Facebook delivery architecture](https://engineering.fb.com/2024/12/10/video-engineering/inside-facebooks-video-delivery-system/).

## 4. CDN and media delivery audit

The useful end-to-end model is:

`feed metadata → rendition selection → prioritized request → CDN bytes → disk cache → compressed sample preparation → decoder → displayed frame`

Each stage can stall independently. Fast CDN responses do not fix a 50 ms view mount; smooth animation does not prevent rebuffering on a slow link.

| Layer | Instagram evidence | Magicbooklet action |
| --- | --- | --- |
| Metadata | Related Meta delivery architecture separates feed selection from media preparation | Keep cached selected post immediately usable; background refresh must not replace it during a transition |
| Renditions | Instagram publishes adaptive and advanced encoding pipelines | Verify display-size images reach released clients; compare MP4 against adaptive streaming for longer clips |
| Transport | Instagram QUIC deployment is published | Record protocol, DNS/connect/TLS, TTFB, throughput, range support, cancellation; avoid CDN migration without attribution |
| CDN policy | Exact Instagram cache keys, TTLs, regional routing and origin shields not established | Measure our own public asset cache hits and misses, immutable versioned identities, content type, byte ranges and expiry behavior |
| Local cache | Public Android preload architecture distinguishes prepared media from warm players | Use a shared bounded cache, deduplicate requests, distinguish cache reuse from player reuse |
| Decode/display | Native platform-specific media paths confirmed | Track decode readiness separately from first displayed frame and UI animation |

Our earlier audit found a missing display-image field in API projection: sampled display versions totaled 0.72 MB versus 6.25 MB of originals. The fix is now in the working tree, but this document does not assert deployment success. The prior same-network Mac samples showed CDN HIT TTFB of 300–490 ms initially and 100–250 ms on repeats. These are not iPhone protocol measurements and cannot establish CDN causality for the current complaint.

Future delivery tests must use the released app on the phone. Compare cold process, cold asset, warm disk, warm memory, slow cellular, and Wi-Fi separately. Test 200/206 behavior, seeking, expired URLs, deletions, failed renditions and cancellation. Verify that signed/authenticated media never shares an unsafe public cache key. Stable content identity must include media version and rendition while retaining access boundaries.

Do not add AV1, HDR or a new CDN just to match Instagram's technology list. Measure startup, quality, battery, decode availability and encoding expense first. HDR in a mixed grid also has brightness/composition consequences; Meta documents tone mapping for Explore-style mixed surfaces. [Meta HDR Reels](https://engineering.fb.com/2023/07/17/video-engineering/hdr-video-reels-meta/).

## 5. How much to preload

Instagram's exact count is **unknown**. The strongest current evidence is a bidirectional adjacent strategy on Android Reels with stress-sensitive suspension. iOS counts and byte budgets are not established.

Our current source, `ugc-mobile/lib/media-performance.ts`, configures one active feed preview and two prepared previews, with requested forward buffers of eight and three seconds respectively. These are policy targets; native buffering may differ. Viewer lists start with one item, batch two, and use a window of three viewports. A list window is not a decoder budget. Current viewer ownership is in `video-player-loans.ts`; do not replace newer hand-back work with the superseded timestamp-only approach.

Proposed initial experiment, not Instagram constants:

| Context | Active media | Ready next | Further ahead | Backward |
| --- | --- | --- | --- | --- |
| Home/Explore grid | One playing preview | One likely candidate with 1–3 s prepared | Posters for roughly one viewport; no blanket video download | Retain previous prepared candidate only within budget |
| Vertical viewer | One playing video | Next video with 2–3 s compressed samples | Next two may cache a small startup range on good Wi-Fi | Previous item retains bytes and position; decoder optional |
| Image viewer/carousel | Current display rendition decoded | Next image decoded if memory allows | Compressed images in disk cache | Previous image retained within decoded-image budget |
| Data saver/thermal pressure | Active request wins | Poster or metadata only | Cancel speculative work | Release inactive decoding resources |

Start experiments with at most two live decoders, allowing a separately tracked short transition overlap only if required. Compare against the current three-player feed policy; revert if reversal or first-frame latency regresses. Trial speculative encoded-media budgets of 8–16 MB on lower-memory devices and 16–32 MB on capable devices, with a separate decoded-image budget and bounded disk cache. These are hypotheses to tune, not release defaults.

At 1 Mbps, three seconds is roughly 0.375 MB of encoded video before overhead. A 720×1280 RGBA image is about 3.5 MiB decoded. Decoder surfaces, sample queues and duplicated images therefore matter more than a count of downloaded files.

Priority: active starvation recovery → user-selected content → gesture destination → adjacent candidate → speculative disk fill. Direction reversal reorders work; backgrounding, memory pressure and logout cancel or release appropriately. Record unused prefetched bytes per watched minute alongside startup improvements.

## 6. Open, close and navigation behavior

The following is our proposed lifecycle, informed by device observations; Instagram's exact internal transition state machine is unknown.

1. **Press:** resolve stable media identity and source rectangle from cached data. Retain the visible image/frame. Start destination preparation without waiting on feed refresh.
2. **Open movement:** animate a lightweight presentation on the UI/native side. Do not build the whole viewer or allocate static chrome textures on the first moving frame.
3. **Handoff:** destination reports its first displayed frame. Transfer presentation authority only when ready. A timeout is recovery, not the normal animation clock.
4. **Settled viewer:** enable actions, then prepare neighbors under a frame and resource budget. React receives semantic state changes rather than every playback frame.
5. **Swipe:** native gesture and snapping remain responsive. Reprioritize the next candidate; stale callbacks cannot activate a superseded item.
6. **Close:** resolve matching origin, retain the current frame, restore source visibility, and transfer the player or presentation to a ready destination. Maintain one audio owner even if two surfaces briefly display the same content.
7. **Missing target:** short fade with preserved feed scroll position. Do not scroll a hidden feed to fabricate a target.
8. **Cancellation:** revert ownership and geometry atomically; no double pop, hidden tile, orphan decoder or duplicated audio.

Existing tests must cover quick close while opening, changed carousel page, stacked creator/viewer routes, tab switches, interruptions, recycled tile and a retry replacing the player. iOS interactive-pop completion needs an actual completed physical gesture; a synthetic drag that stays put does not establish cancellation support.

## 7. Platform and surface inventory

| Instagram area | What is established | What remains unknown | Our recommendation |
| --- | --- | --- | --- |
| iOS HDR video | Custom lower-level rendering using AVSampleBufferDisplayLayer | Universal SDR path, player pool sizes, looping implementation | Begin with AVFoundation; custom decoder stack only with demonstrated need |
| Android Reels | Media3 preload integration published; native pager/Litho observed previously | Exact deployment variants, neighbor count, universal rendering surface | Native media scheduler plus reusable video host |
| iOS lists | IGListKit used in Instagram; UICollectionView foundation | Which exact current tabs use it | Native pager/list prototype if mount profiling still warrants it |
| Explore/Home media | Native behavior observed in sampled Android trees | Complete current platform implementation and cache policy | Keep feed product logic; optimize cell mounting and media host |
| Stories | Public HDR/audio material covers some media capabilities | Exact viewer, preload window, retention and gesture ownership | Separate research experiment if we add a Stories product |
| Camera/editor/upload | Native processing and codec work is published for HDR upload | Exact camera/editor framework and background-upload scheduler | Consider a native upload queue when reliability evidence warrants it |
| Comments, messages, settings, commerce | Historical mixed technology; no full current inventory | SwiftUI/UIKit/Litho/RN assignment per screen | No conversion based solely on this research |
| Navigation, sheets, keyboard | Native platform behavior can be observed | Private transition classes/gesture arbitration | Reuse current native-backed libraries; replace only traced bottlenecks |

React Native already renders native views. Expo Video, image components, gesture handling and native-stack navigation already wrap native capabilities. The decision is which resource ownership, scheduling and render loop should move out of React-driven lifecycle work.

## 8. Native build package and priorities

| Candidate | Expected value | Cost/risk | Decision |
| --- | --- | --- | --- |
| iOS loop engine | Addresses measured 50–70 ms repeat boundary freeze | Queue replicas, source replacement, observers, cache and audio lifecycle | First native prototype |
| Shared native media coordinator | Prevents duplicate players and manages preload pressure | Ownership races, resource leaks, platform API differences | Core foundation |
| Android Media3 preloader | Prepares media without one warmed player per candidate | Expo's pinned Media3 compatibility, shared cache/looper requirements | Prototype after dependency audit |
| Lightweight video host | Reduces mount cost; consistent first-frame events | Surface reuse and platform rendering differences | Include if measured benefit |
| Native viewer pager | Avoids expensive full React tree mount at landing | Accessibility, dynamic captions, nested navigation, large maintenance surface | Conditional next phase |
| Native chrome | Potentially lowers offscreen passes and draw work | Texture memory, stale state, accessibility hit testing | Optimize existing chrome first; cache outside transitions |
| Whole native Home/Profile/settings rewrite | No demonstrated broad benefit | Duplicated product implementation | Exclude from initial build |

For iOS loops, test AVQueuePlayer/AVPlayerLooper against current behavior. Apple's looper manages replicas of a template item; this affects observers and memory, so it is not a one-line replacement. Validate seeks, mute, playback rate, source replacement, failed loads and returned-player ownership. Do not promise that seek-while-playing alone provides gapless output. [Apple AVPlayerLooper](https://developer.apple.com/documentation/avfoundation/avplayerlooper).

On Android, verify the installed Expo dependency graph before selecting Media3 APIs. Shared preload/playback components and a compatible playback looper are required; a second unrelated cache/player stack would defeat reuse. [Media3 preload documentation](https://developer.android.com/media/media3/exoplayer/preloading-media/preloadmanager), [shared components and threading](https://developer.android.com/blog/posts/elevating-media-playback-a-deep-dive-into-media3-s-preload-manager-part-2).

## 9. Proposed module boundary

Create an Expo native module with a stable interface and platform implementations. React supplies media descriptors, source surface, selection, policy and action intent. Native code owns preparation cancellation, buffer budget, presentation attachment, playback and resource release.

Commands: prepare(candidate, priority, budget), activate(media, owner), attach(owner, surface), transfer(from, to, transitionId), cancel(transitionId), release(owner), setPolicy(network, memory, thermal, foreground).

Events: prepared, firstFrameDisplayed, bufferingStarted/Ended, transferCompleted/Cancelled, ended, error, resourceSnapshot. Every asynchronous completion carries media version and generation/transition ID. First decoded frame and first displayed frame are separate signals.

Use leases rather than ownership inferred from React mount/unmount. Keep user actions, comments, saved state, analytics intent and API data in the existing app. Frame animation and media clocks must not require synchronous JavaScript work. Retain an old-engine fallback behind a capability check and feature flag.

## 10. Physical reverse-engineering experiment plan

To estimate behavior we cannot read from public sources:

1. Record exact Instagram version, device, refresh rate, data-saver state, network, thermal state and content cadence. Repeat on both platforms.
2. Observe cold entry, warm entry, slow dwell, fast swipes, direction reversal, tab switching, profile open, carousel paging, Stories, comments, keyboard and background return separately.
3. Capture presentation timing and app-attributable CPU/render work. Correlate encrypted traffic burst timing/size where available; packet totals alone cannot identify media items or decode readiness.
4. After a controlled dwell, disconnect network and count independently unseen items that can start, and how long they continue. Repeat dwell durations and directions. This gives a lower bound on playable cached content, not proof of full downloads or a fixed preload count.
5. Vary network rate and device load. If the inferred window contracts, model an adaptive policy. Repeat at least ten sessions per condition before treating a count as stable.
6. For our own app, instrument exact media identities and bytes so we can measure actual speculative waste, duplicate fetches, live decoders and ownership handoffs. Do not infer these from Instagram packet counts.

Deliver a per-surface evidence ledger. Mark any unavailable instrumentation as unknown; do not bypass protected traffic or claim knowledge of hidden server configuration. Use ordinary owner-authorized browsing/navigation; no posting or messages are required.

## 11. Implementation sequence and acceptance gates

**Phase 0 — released baseline.** Once the user's current release finishes, record actual installed binary/runtime/OTA identity. Reproduce remaining iPhone issues with the released bytes. The working tree inspected here is not proof of what shipped. Preserve existing audit evidence but do not use it as an after-release baseline.

**Phase 1 — observability and cheap fixes.** Separate input, flight, viewer mount, destination first frame, handoff, loop and decoder release markers. Verify display renditions, remove repeated mount work, reduce shadow/clip passes, and defer neighbor setup without making the first swipe cold. Profile before and after.

**Phase 2 — iOS native playback prototype.** Build a local test module around loop continuity and leases. Compare repeated short clips and long clips on the iPhone 16e plus a 120 Hz iPhone. Promote only if loop gaps improve without memory, audio or startup regressions.

**Phase 3 — bounded preparation.** Add Android Media3 preloading and equivalent iOS preparation policy behind the same interface. Measure both immediate-next and reversal behavior. Native capability must be present before remote policy can enable it.

**Phase 4 — presentation boundary.** If landing still incurs expensive React mounts, prototype a native active-media pager with retained source frame. Compare it with the lighter existing viewer on the same content. Preserve captions, controls, accessibility, gestures and return geometry.

**Phase 5 — one coordinated store release.** Ship independently switchable proven modules in the next binary. Native changes alter runtime compatibility; follow the repository's store and OTA targeting rules. Keep the old path selectable for rollback. Do not bundle unverified native rewrites merely to avoid a later build.

Acceptance proposals: warm input-to-first-motion p95 ≤50 ms; ≥99% on-time animation frames over at least 30 opens/closes per primary surface; zero repeatable black/rewind/crop flashes; no attributable loop gap beyond one source-frame interval above normal cadence over 20 loops; warm next-video first display p95 ≤100 ms. Report cold startup separately by network. These are targets, not current achieved results.

Run 100 navigation cycles with live player/view counts returning to their expected bounds and no monotonic retained-memory growth after warmup. Test at 60/120 Hz, low power, memory pressure, slow/offline delivery, expired URLs, image/video mixtures, all entry points, rapid cancellation and real native edge completion. Track startup, hitch duration, rebuffer ratio, wasted bytes, crashes, thermal behavior and battery together. A faster median that worsens p95 or decoder stability fails.

## 12. Deliverables and remaining uncertainty

This research establishes a defensible platform split and a staged build plan. It does not establish Instagram's exact predownload count, complete native screen inventory, CDN cache internals, iOS pool/loop implementation, or the effect of the release currently in progress.

Next concrete output should be an exact-release iPhone baseline plus a small iOS loop/native-owner prototype, followed by the preload module. The broader Instagram experiments above can refine policy without blocking the already evidenced loop and mount investigations.

Local evidence: `docs/audits/media-smoothness-checkup-2026-09-18.md`; archived summaries and traces under `/Users/athuls/UGC copy/archive/ugc-app-audits/media-smoothness-checkup-2026-09-18/`. Earlier results describe sampled builds and content, not universal comparative performance. In particular, the previous conclusion that Instagram is never smoother should not be generalized from those runs.
