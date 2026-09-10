# Media delivery / CDN audit — 8 September 2026 (final)

This is the single media delivery audit for 8 September 2026, and the file to
work from. It merges two independent passes made that day: a 17:05 IST pass
(authenticated probes of every rendition, a full preview decoder scan, focused
regression tests) and an 18:45 IST pass (live headers, three days of Supabase
edge logs with client attribution, database aggregates, source review of the
publish, feed and viewer paths). Their separate drafts have been deleted;
everything either pass found is carried here, and the 17:05 pass's evidence
files were re-read for the merge and match its stated results.

Both passes audited the same live build,
`7be2430ba46df249e7d2804d2a85b8ad75809912` (`/api/app-version` at 17:0x and
18:25 IST; production release run `34214216304`). Nothing has been committed on
any branch since #129 merged at 15:36 IST, no checkout holds uncommitted
delivery code, and no store build workflow has run since. Both passes were
read-only: no data, deployment or over-the-air update changed. The earlier
journals `media-delivery-audit-2026-09-05.md` and
`media-delivery-audit-2026-09-06.md` remain the evidence archive for everything
before this build and are cited below where their measurements are used.

**Verdict.** The private-rendition rollout, preview integrity and the web and
Android playback paths pass on this build: every stored video has a fast-start
rendition that answers byte ranges, private playback is 92.5 % smaller and
served through a stable route address, and public objects come from Cloudflare
with ranges served from cache. Whole-app delivery is not signed off. Two P1
items remain: no binary carries the iOS two-byte patch, and posts published
from a generation get no public derivatives, which is where the daily signing
churn and the one un-renditioned public video come from. Image opens on mobile
download the original and were 48 % of today's storage bytes, more than every
video kind together. Two backend defects (attempt accounting, the integrity
script) and two smaller delivery costs (route signing, raw avatars) complete
the list.

## Reconciling the two passes

| Area | 17:05 pass | 18:45 pass | Final |
| --- | --- | --- | --- |
| Method | Signed every rendition and probed it; decoded every preview; authenticated route checks with the test account; 59 web + 46 mobile focused tests; static inventory of 144 renderer call sites | Anonymous header probes; three 24 h windows of edge logs with client attribution; storage metadata and row aggregates; source reading of the publish, feed and viewer paths | Both retained; each verified things the other did not |
| Route signing per request | P2: fragments the private CDN cache; reproduced MISS/MISS/HIT | P3: one viewer per private object, native disk cache covers repeats; the bound is the 300 per 10 min sign limit | **P3** with the rate-limit close condition (F5) |
| Attempt budget on hard termination | P2 | P3 | **P2**: the failure mode is an egress loop (a source re-read every sweep), not a CPU cost (F4) |
| Repair job health | 7 succeeded, 137 skipped, 0 failed (24 h to 17:00) | 1 succeeded, 143 skipped, 0 failed (24 h to 18:30) | Same health; the earlier window still held the 7 September backfill successes |
| `playback_rendition_status = 'pending'` rows | not discussed | 60, all image generations (the column defaults to `pending`) | Not a backlog; 15 of 15 stored videos are ready |
| Not covered by the other pass | Cross-owner 404, fast start, decoder scan, tests | Egress attribution, signing volume, publish-path root cause, image and avatar delivery, web playback source, edge retention (`age` beyond `max-age`) | All carried below |
| Recommended order | native → signing → attempts → script → acceptance matrix | publish path → images → native | Merged at the end |

No contradiction was found between the two passes; every overlapping number
(15/15 renditions, 14,184,079 B against 190,163,251 B, 6/6 post renditions,
401/302 route behaviour, the three unavailable records) agrees.

## Verified on the live build

| Check | Result | Pass |
| --- | --- | --- |
| Private playback backfill | 15 of 15 stored video generations ready and every rendition object present (six older rows have a null category); 92.54 % fewer bytes than the sources | 17:05 |
| Post video renditions | 6 of 6 `post_media` videos ready (7,960,183 B) | both |
| Fast start | 21 of 21 renditions carry `moov` before `mdat` (first 64 KiB parsed) | 17:05 |
| Byte ranges | 21 of 21 answer 206 for a bounded prefix; a private rendition returns exactly 2 bytes for `Range: bytes=0-1` | 17:05 |
| Preview integrity | all 96 existing previews decode, none oversized or above 720 px (2,864,534 B read, 99 rows); the three missing previews are exactly the `source_unavailable_at` records | 17:05 |
| Route authorisation | owner 302 (`Cache-Control: private, max-age=60`, 600 s signature); unauthenticated 401; another owner's private rendition 404 with no redirect | both |
| Web playback source | `ShowcaseMediaCarousel` resolves the rendition in feed, detail and reel; the anonymous home payload carries `.feed.` renditions for the three post videos that have one | 18:45 |
| Public object caching | `cache-control: public, max-age=86400`, `cf-cache-status: HIT`; `bytes=0-1` and a mid-file range both 206 from cache; `age` 674,551 s on one rendition, so the edge retains beyond `max-age` and takedowns depend on the purge, as `showcase-media-cache.ts` states | 18:45 |
| Signed object caching | no `Cache-Control`; `Expires` equals the token expiry; Cloudflare caches per token (MISS then HIT); two fresh route resolutions give two different targets | both |
| Private rendition objects | every one carries `max-age=31536000` | 18:45 |
| Unavailable markers | 3 (generations `058a82f8`, `a2b54deb`; post media `a54b4ead`) | both |
| Repair job | no failed runs in 24 h; backlog empty for stored sources | both |
| Focused regression tests | 59 web and 46 mobile tests passed across 12 files (delivery, renewal, playback, repair); no full-suite run | 17:05 |
| Mobile | `patches/expo-video+55.0.21.patch` present; `ota-targets.json` still Android 71 / iOS 51; no store build since #129 | 18:45 |

## Where the storage bytes go

Supabase edge logs, GET requests under `/storage/v1/object/`, summing
`response.headers.content_length`. These are server-committed bytes — a
download the client cancels counts in full — so every figure is an upper
bound. HEADs are excluded.

| 24 h window (UTC) | Total | Video sources | Playback renditions (private) | Feed renditions (public) | Previews | Images and other |
| --- | --- | --- | --- | --- | --- | --- |
| 5 Sep 13:00 → 6 Sep 13:00 | 560 MB | 469 MB (97 req) | — | 36 MB | 21 MB | 34 MB |
| 6 Sep 13:00 → 7 Sep 13:00 | 1,624 MB | 1,427 MB (123 req, none from an app) | 68 MB | — | 9 MB | 121 MB |
| 7 Sep 13:00 → 8 Sep 13:00 | 136 MB | 23 MB | 32 MB | 6 MB | 10 MB | 66 MB |

The 1.4 GB of sources on 6–7 September is the integrity audit and the
rendition backfill reading every original, not viewers. Today's 136 MB by
client: the audit iPhones and simulator 70 MB, the S24 Ultra 28 MB, one
Android 11 phone that is not an audit device 5.5 MB, Vercel's image optimizer
12 MB, crawlers 11 MB (Googlebot-Image pulled a 7.9 MB PNG; Googlebot-Video and
GPTBot each pulled a 1.56 MB clip), server jobs and the 17:05 probes 9 MB.
There is no organic viewer traffic to measure a before/after against; the
egress reduction rests on object sizes, which is sound, but it should be
re-read once real traffic exists.

Signing: 7,145 `POST /storage/v1/object/sign/…` calls in 24 h — 6,169 for
previews on 23 distinct paths, 906 for sources on 5, 59 for playback
renditions — between 18 and 1,264 an hour on 18–39 paths, including three
hours with zero storage GETs.

## Findings, in priority order

### F1 — P1: no binary carries the iOS two-byte patch

`ugc-mobile/patches/expo-video+55.0.21.patch` bounds expo-video's iOS
content-information request to two bytes and reads the total from
`Content-Range`. Measured on the simulator release build it cut a cold open
from 2.87× to 1.88× the file for a 466 KB clip and to 1.00× for a 1.48 MB clip
(`media-delivery-audit-2026-09-06.md`, 15:20 entry). The improvement cannot
reach any phone: `patches/` is a fingerprint input, the OTA targets still name
Android 71 and iOS 51, and no store build has run since #129. The physical
iPhone baseline (App Store build 47) also recorded a transient "Video couldn't
load" plate on a cold open and no loop, which the simulator did not reproduce.
Server-committed bytes are not bytes received before cancellation, so the
remaining duplicate-range cost is distinct from the fixed full-body request.

Close when a release candidate carrying the patch passes repeated cold opens,
clean and interrupted playback and reopen, foreground/background, manual pause
and resume, and the intended loop policy on a physical iPhone; then ship the
binary, verify its installed identity and move the OTA target.

### F2 — P1: posts published from a generation get no public derivatives

`showcase-publish-service.ts` writes `posts.showcase_asset_path` (a copy of the
source) and `generation_id`, and no `post_media` rows. Every public derivative
pipeline — preview, feed rendition, teaser, the repair sweeps and their readback
checks — keys on `post_media`. Consequences, all measured on 8 September:

- The public feed resolves these items through the legacy generation path
  (`showcase-feed.ts`, `resolveLegacyGenerationPreviewUrl` →
  `resolveOwnedStoredMediaUrl`), which signs the generation's private preview
  for 3,600 s on every fetch. That is the 6,169 preview signatures a day on the
  18 showcased generations (13 images, 5 videos), and why the anonymous home
  page carries four `generated_images` / `generated_videos` signed URLs that
  differ on every render (`src/app/page.tsx` revalidates every 60 s). Because
  the token is part of the cache key, 194 of 211 signed-preview GETs today were
  Cloudflare MISSes (92 %); public showcase previews ran 38 HIT to 13 MISS.
- Post `40cac994` (published 2026-09-07 from generation `d32fb47c`) is the first
  video through this path: `/showcase/40cac994…` plays the 1,562,305 B copy
  although a 176,927 B rendition exists privately — 8.8× the bytes, and the only
  public video on the site without a `.feed.` file.
- Eight public posts have no media rows: four images (30 Jul–23 Aug), the
  video above, three without a cover. Posts from March to July have rows and
  public previews, so this is the current publish path, not a legacy remnant.

Fix: at publish, create `post_media` rows for the copied file so the existing
sweeps materialise preview, rendition and teaser in `showcase_media`; backfill
the 18 showcased generations; then stop signing generation previews for public
items and serve the public preview path. Close when the anonymous home payload
contains no `/object/sign/` URL and every public video has a `.feed.` rendition.

### F3 — P2: an image open on mobile downloads the original

`ugc-mobile/app/viewer.tsx` renders image slides with `FeedMediaFrame
kind="image" url={mediaItem.url}` and the 720 px preview only as the blurred
backdrop (`feed-media-frame.tsx:72`); tiles use the preview
(`showcase-media-preview.tsx:316`). Each open therefore downloads the source:
`generated_images` originals average 1.19 MB (79 objects, 94 MB), showcase
image copies 2.17 MB (24 objects, 52 MB, largest 7.9 MB), against 25 KB
previews. Today the iPhone fetched 14 originals (22 MB) and the simulator four
more (4 MB); the S24 fetched 11 (14 MB); every preview the two audit phones
loaded came to 5 MB. Web is not affected: detail renders the source through
Vercel's optimizer (`OptimizedPreviewImage previewSrc={url}`), which fetched
12 MB from Storage for six sources and served resized WebP from its own cache.

Fix: produce a display rendition beside the preview (about 1440 px WebP,
150–300 KB) in the same writer and repair sweep; use it in the mobile viewer
and keep the original for download and zoom. Close when an image open on a
phone transfers under 400 KB.

### F4 — P2: hard worker termination bypasses the repair attempt budget

`claim_generation_preview_repairs`, `claim_post_media_preview_repairs` and
`claim_media_rendition_repairs` (migrations `20260905192259` and
`20260810108000`) filter on the attempt counter, set `processing` and the
lease, and leave the counter to the worker's completion write
(`media-preview-repair.ts`). A caught download or encode error increments; a
process killed or expired before that write does not, and the row is
re-admitted when the lease lapses. The cost profile is egress: if a source
download can outlive the function, the same 10–30 MB original is re-read every
ten-minute sweep until someone notices. Today's empty backlog and clean run
history are not evidence it has happened; no crash was injected. The newer
private-generation rendition claim consumes its attempt before I/O and is not
affected.

Close when an attempt is reserved atomically for each row admitted to work,
worker writes are aligned to avoid double counting, lease-expiry recovery is
verified under a locally terminated worker, and rows left unstarted by the
wall-clock budget are accounted for.

### F5 — P3: per-request signing on the route

`media-read-service.ts` signs on every authorised route invocation, and the
native loaders reach the route once per request: two fresh resolutions give two
signed targets (302 → 206, MISS, MISS; the first target repeated is a HIT), and
the iOS loaders made 35 requests for two private renditions with 11 HITs
today. The edge cache matters little here — a private creation has one viewer,
and the native disk cache already covers repeats — so the cost is the signing
round trip and the `media-read:sign` limit (300 per 10 min per user,
`backend-rate-limit.ts:418`): at two to three route calls per iOS cold open,
about a hundred cold opens in ten minutes would start answering 429, shown as
"Video couldn't load".

Fix: reuse a still-valid signature within an authorised window (sign to the
next 10-minute boundary and memoise per user and path); ownership checks,
expiry margins and download-option separation must survive, and private
buckets stay private. Close by re-measuring cold and warm request counts.

### F6 — P3: avatars and covers are served raw on mobile

The `profiles` bucket holds avatars from 9.5 KB to 1.63 MB and covers to
1.77 MB (PNG originals; `profile-media-upload-sign.ts` only caps size at 5 MB).
Mobile renders `avatar_url` directly (`creator-profile-screen.tsx:697`); web
goes through `next/image`. The Android 11 phone fetched one 400 KB avatar ten
times today, all cache HITs, still egress. Fix: resize before upload on the
client (avatar ≤ 512 px, cover ≤ 1600 px) and reject larger dimensions
server-side.

### F7 — P3: the integrity script reports known-unavailable rows and has no schedule

`scripts/audit-media-previews.ts` does not select `source_unavailable_at` and
reports the three marked records as `missing_preview` /
`missing_source_and_preview`, so it exits nonzero and cannot give a clean
health signal. It is also not wired into any workflow or job; upload readback
protects new previews, but normal repair selection skips rows already marked
ready, so a later missing or corrupt ready object is only found by hand.

Close when known unavailable records are reported separately, failure status
is preserved for newly broken ready media, and a bounded periodic sampler runs
on a schedule.

## What one open costs now

| Open | Before | Now | Ratio |
| --- | --- | --- | --- |
| Public post video with media rows | source, avg 13.9 MB | feed rendition, avg 1.33 MB | ~10× |
| Private creation video | source, avg 12.7 MB | playback rendition, avg 0.95 MB | ~13× |
| Generation-published post video (F2) | 1.56 MB copy | unchanged | 1× — a 0.18 MB rendition exists |
| Image in the mobile viewer (F3) | source, 1.2–2.2 MB avg, up to 7.9 MB | unchanged | 1× — 25 KB preview; 150–300 KB display rendition possible |
| Image on web detail | source | optimizer output from Vercel's cache | Storage pays once per source and width |
| Avatar or cover on mobile (F6) | raw, up to 1.6 / 1.8 MB | unchanged | 1× |

If video was about 85 % of August's egress (the August audit's reading), the
rendition work alone moves the model from about 0.7 GB to about 0.17 GB per
active user a month, roughly 1,500 MAU on the included 250 GB; F2 and F3
together would take it to about 0.07 GB, roughly 3,500 MAU. Both are a model,
not a measurement.

## Coverage and limits

Static inventory: 1,090 source files, 144 renderer and player call sites across
68 media files — an inventory, not 144 executed journeys. Source review covered
the authenticated route, rendition delivery, preview workers, mobile profile
thumbnails, template media recovery, the native patch, the publish service, the
feed resolvers and the mobile viewer. The production snapshot has two
templates, zero template-version rows and four template runs, so broad
published-template demo coverage cannot be established. Not rerun on this
build: template and workflow input and approval journeys, resource audio,
long-lived browser sessions, native offline and background behaviour, and any
physical-device playback; the Android phone was detected but not operated, and
the iOS numbers are the earlier simulator and iPhone measurements. Log bytes
are committed, not delivered; the edge-log API caps a query at 24 h; Supabase's
billed egress counter is only visible in the dashboard and was not read.

## Recommended order

1. **F1** — build the iOS release candidate from main, run the physical-iPhone
   matrix, ship, move the OTA target. Needs no code; runs on the mobile train
   independently of the rest.
2. **F2** — create `post_media` rows at publish, backfill the 18 showcased
   generations, stop signing generation previews for public items. Small
   change; ends the daily signing churn and the un-renditioned public video.
3. **F3** — display rendition for images in the writer and repair sweep; mobile
   viewer uses it. Largest remaining per-open cost.
4. **F4** — reserve attempts atomically in the three claim functions.
5. **F5** and **F6** — bucketed route signatures; client-side avatar and cover
   resize with a server cap.
6. **F7** — fix the script's reporting and schedule a bounded sampler.
7. One bounded surface-acceptance matrix on the intended release builds. The
   migration, backfill, preview and fast-start work verified above does not
   need to be restarted.

## Evidence

Local, ignored files under `output/media-audit/`:

- `cdn-fresh-audit.mjs`, `cdn-fresh-audit-20260908.json` — 21 rendition prefix
  probes, fast-start parse, authorisation and cache results (no signatures or
  credentials saved; the test account, previously authorised, signs in at run
  time).
- `cdn-preview-audit-20260908.json` — the complete decoder scan, 96 decoded,
  three findings (the unavailable records).
- `cdn-renderer-inventory-20260908.json` — static surface inventory.
- `cdn-web-tests-20260908.log`, `cdn-mobile-tests-20260908.log` — focused
  regression results.
- `cdn-headers-evening-20260908.sh`, `cdn-headers-evening-20260908-video.sh` —
  anonymous header probes (home page, signed and public previews, avatar,
  rendition and source video ranges, the unauthenticated route).
- Edge logs: Supabase `query_logs` on `edge_logs`, kind from `request.path`
  (`.preview.`, `/playback/`, `.feed.`/`.teaser.`, `.mp4`), client from
  `request.headers.user_agent` (`MagicBooklet/<build> CFNetwork` = iOS video
  loader, `MagicBooklet/0.1.x (iPhone…)` = iOS image loader, `Dalvik/…` =
  Android image loader, `Magic Booklet/0.1.4 (Linux;Android 16) AndroidXMedia3`
  = ExoPlayer, `vercel-image-optimization/1.0` = the Next image optimizer).
- Database: `storage.buckets`, `storage.objects` metadata, `generations`,
  `post_media`, `posts`, `backend_job_runs`, and the live claim-function
  definitions.
