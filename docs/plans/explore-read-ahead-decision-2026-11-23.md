# Explore read-ahead: keep or drop, from a week of counts

Status: open. The counting ships with PR #907 (migration
`20261123151805_showcase_feed_read_ahead_counters.sql`). Read the counts a week
after that release, decide, and remove the counter whichever way it goes (last
section), so its extra RPC does not outlive the decision. Paths are relative to
`ugc-app/`; app paths are under `ugc-mobile/`.

## What is being decided

Each launch of the app asks the server to rank Explore's first page ahead and
hold it (`readAhead=1`; app `lib/explore-read-ahead.ts`, server
`src/lib/showcase-feed-read-ahead.ts`). Every hold costs a whole For you
ranking and a 100–300 KB data-cache write. It pays off only when Explore's
first read hands the token back and is served the held ranking: that read
then skips the ranking, which drew a skeleton for about 2 s on a first visit
(device sweep, 2026-11-03). The perf loop of 2026-11-19 left it as "measure
first" (`archive/perf-loop-2026-11-19/mobile-static/summary.md`, item 6).

## The counts

`public.showcase_feed_read_ahead_counters`: one row per event per UTC hour,
written by the feed route after its answer
(`src/lib/showcase-feed-read-ahead-counts.ts`):

- `hold`: a ranking was held and its token handed to the app.
- `claim`: a signed-in read (guests included) handed the token back and was
  served the held ranking.
- `claim_miss`: such a read handed a token back and ranked its own page. The
  token was unknown to the server (evicted, another region, a new
  deployment), spent or expired. Or the held ranking was set aside: a session
  read within the reuse window, or a changed algorithm or experiment arm.

A hold that is neither claimed nor missed never came back at all. Either
Explore did not open, or the app dropped the token before using it: it forgets
the token on a sign-out or a change of identity, and it stops offering one
100 s after the hold (`EXPLORE_READ_AHEAD_MAX_AGE_MS`). That is why the rule
below divides claims by holds, not by claims plus misses.

**2026-11-24: claims before the wait fix undercount.** Until the app update
that carries branch `perf/explore-read-ahead-wait`, Explore waited at most 4 s
for a read-ahead still under way, then dropped its token and ranked the page
again. On a cold server the read-ahead takes longer than that, so a person who
opened Explore during it threw the held ranking away: counted as a hold, never
as a claim or a miss (the owner's two launches that day: 2 holds, 0 claims).
The app now waits for the read-ahead until it settles, capped by the API
client's own request timeout. On 2026-12-01, read the claim rate from that
update's publish time (its OTA record, `releases/ota/<sha>/` in the folder
above `ugc-app/`), or report the
two windows apart; a low rate from before it is not evidence against the
read-ahead.

## When to read

Seven full days after the production release that applies
`20261123151805` goes live (the Production release workflow run that deploys
it gives the time). If #907 releases on 2026-11-24, read on 2026-12-01. Put
that release time in `released_at` in the queries below.

## The query (read-only, service role)

```sql
with params as (
  -- The release time, from the workflow run.
  select date_trunc('hour', timestamptz '2026-11-24 00:00:00+00') as released_at
)
select
  coalesce(sum(event_count) filter (where event = 'hold'), 0)       as holds,
  coalesce(sum(event_count) filter (where event = 'claim'), 0)      as claims,
  coalesce(sum(event_count) filter (where event = 'claim_miss'), 0) as claim_misses,
  round(
    coalesce(sum(event_count) filter (where event = 'claim'), 0)::numeric
      / nullif(sum(event_count) filter (where event = 'hold'), 0),
    3
  ) as claim_rate
from public.showcase_feed_read_ahead_counters, params
where bucket_start >= params.released_at
  and bucket_start <  params.released_at + interval '7 days';
```

Per day, to see whether the week was even:

```sql
with params as (
  select date_trunc('hour', timestamptz '2026-11-24 00:00:00+00') as released_at
)
select date_trunc('day', bucket_start) as day, event, sum(event_count) as count
from public.showcase_feed_read_ahead_counters, params
where bucket_start >= params.released_at
  and bucket_start <  params.released_at + interval '7 days'
group by 1, 2
order by 1, 2;
```

## The rule

The metric is `claim_rate` = claims ÷ holds. Each hold that is not claimed
costs a whole extra ranking and a cache write (the Explore read that opens
later ranks again), and each claim saves one reader about 2 s of skeleton.
The thresholds below were chosen with this record; the owner can move them.

- **Keep** at a claim rate of 0.25 or more: at most three wasted rankings for
  each first visit made instant.
- **Drop** below 0.10: more than nine wasted rankings for each.
- **In between**, the owner weighs the 2 s against the rankings.
- **First check the misses:** if `claim_misses` exceeds a fifth of
  `claims + claim_misses`, the server is losing held rankings, not the app's
  readers. Fix the store (`showcase-feed-read-ahead.ts`) and count another
  week before judging.

## Removing the counter (either way)

One PR, after the decision. The release applies the migration before the new
deployment is promoted, so the old deployment's counts fail for those
minutes. Each failure is logged and lost; no read fails.

1. **Migration:** a new one, stamped with `date -u +%Y%m%d%H%M%S`. Never
   edit `20261123151805`:
   `DROP FUNCTION IF EXISTS public.record_showcase_feed_read_ahead_event(text);`
   then `DROP TABLE IF EXISTS public.showcase_feed_read_ahead_counters;`, with
   a `*-migration.test.ts` that asserts both drops.
2. **Recorder:** delete `src/lib/showcase-feed-read-ahead-counts.ts` and its
   test.
3. **Feed route:** in `src/lib/showcase-feed-route-adapter-service.ts`,
   remove `countReadAhead`, the `recordShowcaseFeedReadAheadEvent` and
   `runAfterResponse` dependencies, and the `onReadAheadClaim` passed to
   `getShowcaseFeedPage`.
4. **Feed service:** remove `onReadAheadClaim` and the `readAhead` flags from
   `src/lib/showcase-feed.ts`, and `onPreparedServed` from it and from
   `src/lib/showcase-feed-personalization.ts`. Update their tests.
5. **Registries and tests:** delete
   `supabase/tests/database/showcase_feed_read_ahead_counters.test.sql`, and
   remove the table from `src/lib/storage-orphans.ts`: its test drops a table
   that a later migration drops. Keep the creating migration and its
   migration test.

## If the decision is drop

1. **Server first:** stop setting `readAheadSupported` on For you pages
   (`src/lib/showcase-feed-route-adapter-service.ts`).
   - The app asks only a server that sets it, and a page without it turns
     the read-ahead off (`noteShowcaseFeedReadAheadSupport`), so every
     installed binary stops asking with no OTA.
   - Keep answering a stray `readAhead=1` with `{ "readAhead": null }`
     without ranking. A client mid-launch then falls back to its ordinary
     read.
2. **Then the app** (a later OTA): remove `lib/explore-read-ahead.ts` and its
   use in `components/home-dashboard.tsx` and the Explore lane.
3. **Then the server's mode:** remove the read-ahead store and `readAheadToken`
   handling, and update `prepareShowcaseFeedReadAhead` in
   `contracts/mobile-api-v1.json` and both suites.
