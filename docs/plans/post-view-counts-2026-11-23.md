# Post view counts: counted where a post is shown large, shown to everyone

Status: step 1 (counting, server only) built on 2026-11-23 on the branch
`feat/post-view-counts`; steps 2 (web display) and 3 (app display) are open.
The owner made the decisions in the first section in the planning session on
2026-11-23. The defaults after them were chosen in planning and are open to
change. Paths are relative to `ugc-app/`; app paths are under `ugc-mobile/`.

## The owner's decisions (2026-11-23)

- **Who sees it:** everyone, on every public post ("Everyone").
- **What counts as a view:** "Seen 1 s, shown large". That means half the post
  on screen for one second on Home, in the reel or on the post page. Grid
  thumbnails don't count. One view per person per post per day. Guests count;
  the creator's own views don't.
- **Where it shows:** the post page and the reel, next to saves and comments;
  profile grid tiles; creator stats (a Views total in the creator page header,
  and views per post on your own profile); Home feed cards, in the card's
  action row as X shows views. The admin console and the agents' `get_post`
  get it too.

## Defaults chosen in planning

1. **Hidden at 0.** A post with no views shows nothing, not "0 views".
2. **Public posts only.** Private posts are never counted and show no number,
   even to their creator. A post taken down keeps its total, in case it comes
   back.
3. **A day is the UTC day** for the one-a-day rule, by the server's clock.
4. **Older posts start from the 30 days we still hold.** Feed events are kept
   30 days, so views before 2026-10-24 are gone, and older posts under-count
   their first weeks.
5. **A daily total per post is kept** (`post_view_days`), for "views this
   week" and charts later. It cannot be rebuilt once the per-view rows are
   pruned.
6. **Text posts count the same way:** their card or page on screen for a
   second.
7. **Format:** 1–999 as is, then 1.2K, 12K and 1.2M, the rule
   `formatCompactCount` already uses for saves. Screen readers get the full
   number ("1,234 views").
8. **A guest is held to its network** (added while building step 1, below):
   at most 20 guests of one network count for one post in one day.

## What existed before step 1

- **Views were logged only as ranking telemetry.** They are `feed_events` rows
  of type `impression`, `open` and `dwell`, accepted from three surfaces:
  `showcase` (Explore), `showcase-reel` and `feed` (Home)
  (`src/lib/showcase-feed-events-service.ts:29`).
- **Only feed posts were logged.** The reel logs an impression only for a post
  the feed delivered (web `src/app/showcase/ShowcaseReelViewer.tsx:654`, app
  `ugc-mobile/app/viewer.tsx:901`). The post page, and a reel opened from a
  profile, search or a link, log nothing.
- **Totals were short-lived and ranking-only.** Per-post totals exist only for
  the last 24 hours, 7 days and 30 days (`post_feed_stats`), and only the
  ranker reads them. Events are deleted after 30 days
  (`src/lib/feed-retention-policy.ts:27`).
- **The "seen" rule already existed.** The decision's rule is the feed's
  qualified impression on both clients: half the card on screen for 1 s. On
  the web that is `ShowcaseFeedInteraction.tsx`, an IntersectionObserver at
  0.5 plus a 1 s timer. In the app it is
  `SHOWCASE_QUALIFIED_IMPRESSION_VIEWABILITY` (50% for 1,000 ms) in
  `ugc-mobile/lib/showcase-feed-events.ts:34`.
- **Saves are the pattern to copy for reading.** `posts.save_count` is a
  lifetime counter on the post row, and every place that will show views
  already reads it.

## Design (step 1 as built)

Migrations `supabase/migrations/20261123070740_post_view_counts.sql`
(records views: the marks, the days, the trigger, the route's function, the
backfill) and `20261123070741_post_view_count_totals.sql` (the post's total,
the rollup, the creator total). Two files, so the first holds only
non-exclusive locks while it backfills and the second holds `posts` exclusively
for a few milliseconds; each file's header says what each part does and why.

### Counting: one function, two ways in

`record_post_view(post_id, viewer_user_id, anonymous_key_hash,
network_key_hash, surface, viewed_at)` decides whether a view counts. It is a
security-definer function nothing outside the database can call. A view
counts when four things hold:

- the post is public and visible (not private, archived, tombstoned or
  moderated);
- the viewer is not its creator;
- this viewer has no view of this post yet on this UTC day;
- for a guest, fewer than 20 guests of its network have viewed the post that
  day.

A counted view is a row in `post_view_marks`. A repeat the same day does
nothing. The function never raises for a view that does not count, since it
runs inside every feed event's insert, and an account's view never waits: it
reads whether the view is marked, then takes a try-lock on the view and skips
it when another transaction holds it (that one is marking it). So two feed
event batches of one viewer cannot deadlock. A guest's view, which only the
route sends, waits its turn for a lock on the post's network for the day, and
the cap is counted and written under it; the route takes a batch's posts in id
order, so two requests never wait on each other in a cycle.

- **Way in 1, no client change.** An after-insert trigger on `feed_events`
  calls the function for each `impression` from `feed` or `showcase-reel` by a
  viewer with an account. App guests have anonymous accounts, so Home cards
  and feed-opened reels count from the first release on every installed app,
  with no OTA, and so do signed-in web viewers. Explore's `showcase`
  impressions come from grid tiles (a masonry on both clients), so they are
  left out.
- **Way in 2, a new beacon.** `POST /api/showcase/views` takes a batch of up
  to 25 `{ postId, surface }`, where `surface` is `feed` (a Home card),
  `post-page` or `reel`, and answers 204 whatever was counted. The post page,
  a reel opened outside the feed and every web guest's Home card send it after
  the same second on screen (steps 2 and 3). Both ways meet in the same
  per-day mark, so a view reported twice counts once and the clients don't
  need to coordinate.

**Why a web guest's feed impression doesn't count:** a web guest is known only
by the feed cookie, which a script can mint afresh for every request, and a
feed event keeps no network to hold it to. A guest's view through the route
carries the hashed network it came from (the feed's own hash), which caps
it. Accounts cost a sign-in each, which Supabase Auth rate-limits.

**Why the new views aren't sent as feed events:** the ranker's per-post stats
count every impression in `feed_events`, so post-page and profile-reel
impressions would change v4's ranking inputs. Views stay out of ranking
telemetry.

**The route** (`src/lib/post-views-route-adapter-service.ts`,
`src/lib/post-views-service.ts`) follows the feed events route:

- It is listed in `PUBLIC_ROUTES` in `src/lib/route-identity-policy.ts`, so a
  guest's view counts; a token, when sent, is verified and counts the view
  under its account.
- A guest is its app's installation id or its browser's feed cookie, as the
  feed knows it. A request with neither counts by its network hash, never by
  an id minted for it (one minted per request would make every cookie-less
  request a new viewer), and the route sets no cookie.
- It reads only `Content-Type: application/json`, so another site's page
  cannot send views from its visitors' browsers without a preflight this API
  never answers.
- Rate limits: 3,000 requests per network per 10 minutes before parsing
  (`post-views:network-admission`), and 300 per account per 10 minutes
  (`post-views:record`).
- A malformed entry (no uuid, a surface this server does not know) is dropped,
  not refused, so a newer client's surface costs that view and not the batch.

### Storage

- **`post_view_marks`:** one row per post, viewer and UTC day, keyed like
  `feed_events` (a user id, or a guest hash with its network hash). RLS on, no
  client grants, and the user id cascades on account deletion. A mark is
  pruned two days after its day, once counted.
- **`posts.view_count bigint not null default 0`:** the lifetime total, beside
  `save_count`. Every read path that already selects the counters gets it with
  one more column and no join.
- **`post_view_days (post_id, view_date, views)`:** the daily totals, kept
  400 days like `feed_delivery_fact_daily`.
- **Written in batches, never per view.** The `post-view-counts` job
  (`src/lib/post-view-counts.ts`, every 10 minutes on the shared scheduler)
  calls `rollup_post_views`, which adds up to 5,000 uncounted marks to
  `view_count` and `post_view_days` in one statement and stamps them counted,
  again while a batch comes back full, within 30 s. A post's row is written at
  most once a call, however many people saw it.
- **The rollup never waits.** It locks a batch's posts, then their marks, with
  `SKIP LOCKED`: a post an edit, a save or a delete holds is counted on a later
  run, and the rollup cannot deadlock with a post's or an account's deletion.
- **A view is not an edit.** `posts_set_updated_at` skips an update that moves
  `view_count`, so the owner's dates, the sitemap and the feed-embeddings job
  never see a counted view.
- **A refused post holds back only itself.** An update on `posts` runs its
  deferred NSFW media check and the account-deletion freeze; the rollup runs
  the check at once, counts a refused batch again post by post, and sits the
  refused post's marks out for an hour (`retry_after`), so they never head
  every batch. They are pruned two days after their day if still refused.
- **Counts can lag, and that's expected.** A count can be up to 10 minutes
  behind, plus the pages' cache: post and creator pages revalidate every 5
  minutes, and the signed-out `/` every 15. Never revalidate a page because of
  a view; the `/` ISR loop spent Vercel credit on 2026-11-04.
- **The backfill is part of the first migration.** The `feed` and
  `showcase-reel` impressions the feed still holds become marks (one per post,
  viewer and UTC day, the creator's own left out), all uncounted, for the
  first rollups to count. Guests are included, since nobody had a reason to
  forge views before counts were public, but held to 20 per post per day, as
  one network's would be: the events keep no network, and a client that sent
  no cookie had an id minted per request. It reads `feed_events`
  after the trigger exists, under the trigger's lock, so no impression is
  missed and a day both see is still one mark. There's no script to run by
  hand.

### What step 1 reads out

- The feed (`src/lib/showcase-feed.ts`), the post page
  (`src/lib/public-posts.ts`), the creator page (`src/lib/creator-profile.ts`,
  its posts and `totalViews` from `get_creator_profile_stats`) and the owner's
  post list (`src/lib/owner-posts.ts`) carry `viewCount`, so steps 2 and 3 are
  display work only. A legacy fallback read leaves it out.
- The admin console's content table has a Views column
  (`src/lib/admin-content-service.ts`).
- The agents' `get_post` counts carry `views` (`src/lib/agent-post-read.ts`).

### Showing it (steps 2 and 3)

A shared module, `ugc-mobile/lib/view-count/`, holds the rule both clients
draw. Like the other shared policy modules, it is free of React Native, Expo
and Node imports, and the web imports it by relative path. For a post it
answers:

- nothing (null) for 0 and for a post that isn't public;
- the compact figure ("1.2K");
- the visible label ("1.2K views");
- the spoken label ("1,234 views").

It also fixes an edge case today's `formatCompactCount` has: 999,950 reads
"1000K". The fix is to round before picking the unit.

| Place | Web | App | Reads `viewCount` through |
|---|---|---|---|
| Post page, next to saves and comments | `src/app/showcase/[id]/ShowcaseDetailEngagementRow.tsx` | `ugc-mobile/app/post/[id].tsx` | `src/lib/public-posts.ts`; `getShowcasePost` |
| Reel, beside saves and comments | `src/app/showcase/ShowcaseReelViewer.tsx` | `ugc-mobile/components/reel-chrome.tsx` | the list the reel opened from |
| Home feed cards, the action row | `src/app/feed/FeedClient.tsx` | `ugc-mobile/components/home-dashboard.tsx` | `src/lib/showcase-feed.ts`; `getShowcaseFeed` |
| Profile grid tiles | `src/app/creators/[username]/CreatorContentTabs.tsx`, `src/app/profile/OwnerProfileMediaHub.tsx` | `ugc-mobile/components/creator-profile-screen.tsx`, `ugc-mobile/components/profile-dashboard.tsx` | `src/lib/creator-profile.ts`; `/api/creators/[username]`, `listOwnerPosts` |
| Creator header total | `src/app/creators/[username]/page.tsx` | `ugc-mobile/components/creator-profile-screen.tsx` | `get_creator_profile_stats` (`totalViews`) |
| Admin content | `src/app/admin/(console)/content/page.tsx` (step 1) | — | `src/lib/admin-content-service.ts` |
| Agents | `get_post`'s `counts.views` (step 1) | — | `src/lib/agent-post-read.ts` |

- **The beacons.** The web sends a view for a Home card (`feed`), the post page
  and the reel, for every viewer (a signed-in viewer's Home card is already
  counted by its impression; the mark dedupes it). The app sends one for the
  post page and a reel opened outside the feed; its Home cards and feed reels
  are counted by their impressions.
- **A view count is information, not an action.** It is never a button: no
  press, no hover state. It's Lucide's `Eye` with the figure. On a tile it
  sits bottom left, over the tile's scrim.
- **Not shown** on Explore, search, the marketplace, or the saved and remix
  lists (not chosen). The number comes with the post reads, so adding a place
  later is display work only.
- **Design docs:** `docs/design/design-web.md` and `design-mobile.md` get the
  rule in the step that draws it.

### Contracts

Step 1 added the endpoint `recordPostViews` to `contracts/mobile-api-v1.json`
and the operation to `mobile-api-operations-v1.json` (`src/proxy.ts` builds
the app's CORS allowlist from it), with the app client's `api.recordPostViews`
held to them by both suites. Step 3 pins the response fields it reads
(`viewCount` on the post shapes of `getShowcaseFeed`, `getShowcasePost` and
`listOwnerPosts`; a fixture for the creator page, which has none yet, with
`viewCount` and `totalViews`). Installed apps ignore the new fields and still
send views through way in 1.

### Privacy

The Usage Information section of the privacy page (`src/app/privacy/page.tsx`,
step 1) says that public posts viewed count once a day toward the post's
total, which everyone can see; that a view is recorded under the account or,
without one, under hashes of the browser's or installation's identifier and
of the network; and that the per-view record is deleted within three days of
the view.

## Steps

Each step is one PR: the local gate
(`.agents/skills/local-checks/scripts/run.sh`), then the fresh-context review
at the level AGENTS.md sets.

1. **Counting, server only (size M), built 2026-11-23.**
   - **Built:** the migration (marks, `posts.view_count`, days,
     `record_post_view`, `record_post_views`, the `feed_events` trigger, the
     rollup, the backfill, `totalViews`, the growth accounting); the
     `post-view-counts` job; the route with its adapter, admission and
     contracts; `viewCount` on the post reads; the admin column; `get_post`'s
     views; the privacy text; the runbook's "Post View Counts".
   - **Tests:** pgTAP (`post_view_counts.test.sql`, and the creator stats and
     growth tests updated); the migration test; the rollup loop, the service
     and the route adapter; the contract fixtures in both suites.
   - **Review:** `max` (a migration and route admission).
   - **After the release:** a day of watching the numbers in /admin before
     anything is public.
2. **Web display (size M).**
   - **Build:** the shared module, the web places in the table, the beacons
     (Home cards, the post page, the reel), and `design-web.md`.
   - **Tests:** the module; the components (nothing at 0, compact and spoken
     figures); an E2E spec (the post page sends one view after a second on
     screen, none before).
   - **Review:** `high`, or `max` past 300 lines.
3. **App display (size M).**
   - **Build:** the app places and beacons, the contract fields it reads, and
     `design-mobile.md`.
   - **Tests:** view-model tests.
   - **Check:** on the S24 or the emulator first, then one iPhone pass.
   - **Ship:** as an OTA (`ship-ota`, published on the owner's word in chat)
     once step 1's release is live, since the app's beacon calls the new
     route.

Steps 2 and 3 each need step 1 live and can run side by side.

## Risks

- **Small numbers at launch.** Counts start from 30 days of feed views, so few
  posts will show nothing, but early totals will be modest. After a week, the
  daily totals show whether public counts help more than they hurt.
- **Web guests count only once step 2 ships.** Between step 1's release and
  step 2's, a web guest's Home card adds nothing (its impression is not
  counted, and the beacon is not sent yet).
- **Gaming.** A person can add at most one view per post per day. A script
  that mints a fresh guest cookie per request is held to 20 views per post per
  network per day, however many requests it sends at once. Fresh anonymous app accounts are the open hole, bounded by
  Supabase Auth's sign-in rate limit. If a post's daily total jumps, its last
  two days of marks show where the views came from.
- **Shared addresses.** The guest cap is per network, and Indian mobile
  carriers put many people behind one address (CGNAT), so a post that many
  guests on one carrier open in a day counts at most 20 of them from that
  address. That is the price of not trusting a cookie; accounts are never
  capped. Revisit if guest views grow.
- **Explore undercounts.** A post found mostly through the Explore grid gains
  views only when someone opens it. That is the decision ("grid thumbnails
  don't count"); it's written here so a later "why so few views?" has its
  answer.
