# Profile counts: one rule, one source, carried across launches

Status: steps 1–3 implemented on 2026-09-28 in the PR stacked on #234 (branch
`mobile/profile-counts`): the migration and its pgTAP test, `/api/profile`
carrying `stats` and `sales`, and the mobile header, Wallet, side menu and
count deltas. Left: step 4 (OTA after the web deploy), step 5 (web hub,
optional) and step 6 (delete the `+` fallback, then archive this plan). Two
rules moved while writing the SQL: the database allows no `text` category
(`generations_category_check`: image, video, audio), so the app's text-kind
branch has no row to count, and a legacy `completed` status is not counted
because the app draws only `succeeded` as finished. Paths are relative to
`ugc-app/`; mobile paths are under `ugc-mobile/`.

Scope: the three numbers in the profile header (Creations, Posts, Saved), the
Wallet card, the side menu's Total sales, `/api/profile`, one SQL function with
its pgTAP test, and the account snapshot from #234. The web profile hub is an
optional last step.

## Why

- **The header counts are not counts.** `getProfileStats` in
  `lib/profile-view-model.ts` reports how many cards the tab has paged in so
  far, with a `+` when more pages wait (`profileStatValue`), so a person with
  200 creations reads `24+`. Until the first page lands the row says
  `0 · 0 · 0`, which to a returning person reads as "everything is gone". The
  three libraries load one after another (`backgroundMediaReady` in
  `components/profile-dashboard.tsx`), so the row fills in one number at a time.
- **The Wallet card is a by-product of paging.** It reads the `summary` that
  the Posts library's first page carries (`includeSummary: true` in
  `lib/profile-media-query.ts`), so it says `$0` until that page lands, and
  `$0` is also a real value.
- **Total sales is a fourth request for the same number.** The side menu
  fetches `listOwnerPosts({ limit: 1, includeSummary: true })` when it opens
  (`['owner-posts-sales-summary', userId]` in `components/home-dashboard.tsx`
  and `components/workspace-side-menu-gesture-layer.tsx`), which is why the
  menu says "Loading…" on every cold start until #234's snapshot covered it.
- **The web already draws the honest placeholder.** `OwnerProfileMediaHub.tsx`
  shows a loaded length or `—`, never a 0, and the public creator page already
  asks the server for a true count (`getCreatorPublicPostCount` in
  `lib/creator-profile.ts`, a `head` count). The owner's own profile is the
  only place still guessing.

The fix is to make the server say the totals once, in the profile response,
so every screen reads one number, the snapshot carries it across launches for
free, and no screen has to page a library to learn its size.

## What each number means

The count and the list must agree, or a header that says 19 above a grid of
18 tiles is worse than `18+`. Each rule below is the list's own filter, written
once in SQL and pinned by a pgTAP fixture set that mirrors the mobile
`creation-library.test.ts` fixtures.

| Number | Lists as | Rule |
|---|---|---|
| Creations | Profile ▸ Creations (`isCreationLibraryMember` in `lib/creation-library.ts`) | `generations` owned by the person **and their merged guest ids** (the list resolves `ownerUserIds` through `profiles.merged_into_user_id`, `lib/owner-generations-route-service.ts`), `archived_at IS NULL`, `status = 'succeeded'`, the studio rule `(template_run_id IS NULL AND template_run_step_id IS NULL) OR studio_visible`, and one of: `source_unavailable_at IS NOT NULL`, `output_url IS NOT NULL`. A succeeded run with no output stays out, as it does in the grid. (The app's text-kind branch has no row in the database, see Status.) |
| Posts | Profile ▸ Posts, active scope | `posts` with `user_id = me`, `archived_at IS NULL`, any visibility, any `review_status` (the owner list in `lib/owner-posts.ts` filters neither). |
| Archived posts | Profile ▸ Posts, archived scope | same, `archived_at IS NOT NULL`. Free once the function exists; the scope switch can show it. |
| Saved | Profile ▸ Saved | `post_saves` for me joined to `posts` with `visibility IN ('public','unlisted')`, `review_status = 'visible'`, `archived_at IS NULL`, minus posts whose creator is blocked in either direction (`loadBlockedCreatorIds` in `lib/moderation-service.ts` checks both). When the person has no `post_saves` rows at all, count `showcase_saves` joined on `posts.generation_id` under the same post filters, which is the legacy branch in `lib/showcase-saved-media-service.ts`. |
| Wallet / Total sales | Wallet card, side menu | `get_owner_post_sales_summary(uuid)`, already an RPC (`20260715090000_backend_read_path_performance.sql`). |

## Design

1. **One SQL function.** `public.owner_profile_counts(p_user_id uuid)` returns
   `jsonb` `{ creations, posts, archivedPosts, saved }`, `LANGUAGE sql STABLE
   SECURITY DEFINER SET search_path = ''`, `REVOKE ALL … FROM PUBLIC, anon,
   authenticated; GRANT EXECUTE … TO service_role`, exactly the shape of
   `get_owner_post_sales_summary`. It resolves the owner-id set itself
   (`p_user_id` plus `profiles.id WHERE merged_into_user_id = p_user_id`) so
   the guest-merge rule lives in one place.
   Indexes, checked on production `pg_indexes` on 2026-09-28: the owner scans
   are served by `generations_owner_archived_created_idx` and
   `posts_owner_archived_created_idx` (both `(user_id, archived_at, created_at
   DESC, id DESC)`), `post_saves_user_id_post_id_key` and
   `showcase_saves_user_generation_idx` for the saves, `user_blocks_pkey` plus
   `user_blocks_blocked_user_idx` for both block directions, and the partial
   `profiles_merged_into_user_id_idx` for the merged-guest lookup. The
   migration adds no index; confirm with `EXPLAIN (ANALYZE, BUFFERS)` against
   the largest owner on a branch and add one only if a sequential scan shows up.
2. **`/api/profile` says the totals.** `getProfileForRoute` in
   `lib/profile-route-service.ts` runs the profile select, `owner_profile_counts`
   and `get_owner_post_sales_summary` in parallel through the service client the
   adapter already passes, and the response gains
   `stats: { creations, posts, archivedPosts, saved }` and
   `sales: { earningsUsdCents, salesCount, listingCount }` (both optional in the
   type). A failing count is logged and left out; the profile never fails over
   a number. Cost per profile GET: two more index-only calls run alongside the
   select, about 120 bytes of egress; profile GET happens per launch, per token
   refresh and after a purchase, so this is small next to a library page.
3. **Mobile reads one number.**
   - `ProfileResponse` in `lib/types.ts` gains the two optional fields.
   - `getProfileStats` prefers server totals, then the paged count with `+`
     (only while a server without the field can still be live), then `–`
     when the library has not loaded. Never a 0 that was not sent.
   - The Wallet card and the side menu's Total sales read `profile.sales`. The
     `['owner-posts-sales-summary']` queries and `includeSummary` on the Posts
     library request go; `__tests__/startup-performance.test.ts` changes from
     "not until the menu opens" to "no seller request at all".
   - `lib/persisted-account-state.ts` drops its `salesSummary` entry: the
     profile entry now carries `sales` and `stats`, so the snapshot restores
     the header numbers and the Wallet with no new code.
   - Numbers move with the person's own actions before the next profile
     refresh: a small `adjustProfileStats(queryClient, userId, delta)` writes
     into the `['profile', userId]` cache at publish (`app/post/new.tsx`),
     archive/restore/delete (`lib/use-viewer-action-handlers.ts`,
     `lib/post-lifecycle.ts`), a creation finishing or being archived
     (`lib/active-generations.ts`, the viewer), save/unsave
     (`lib/use-showcase-save-mutation.ts`, `app/viewer.tsx`). Each site already
     invalidates the matching library; it also invalidates `['profile']`, and
     the 5-minute staleTime plus focus refetch reconciles the rest. A sale
     lands with the next profile fetch.
4. **Web (optional).** `OwnerProfileMediaHub.tsx` reads `stats` from
   `/api/profile` instead of loaded lengths, and the `—` stays for the moment
   before the profile answers.
5. **Cleanup** once the OTA carrying step 3 is live on both stores: delete the
   `+` path in `profileStatValue`, and archive this plan.

## Steps and completion evidence

| Step | Work | Completion evidence |
|---|---|---|
| 0 | Dash for an unknown count, and the Wallet card falling back to the seller summary #234 already saves. About 30 lines; can ride #234 or a PR of its own. | `profile-dashboard.test.tsx`: no libraries loaded → `– · – · –`, Wallet `–`; with the snapshot's summary → the last known total. |
| 1 | Migration with `owner_profile_counts` and the grant block; `supabase/tests/database/owner_profile_counts.test.sql` with the fixture set below. | Isolated replay plus pgTAP green (the recipe in memory); `EXPLAIN` on a branch shows index scans for the largest owner. |
| 2 | `getProfileForRoute` returns `stats` and `sales`; `src/__tests__/profile-route-service.test.ts` covers the shape, a failing count, and the merged-guest owner set. | Web tests green; deployed to production before any OTA (deploy, then publish). |
| 3 | Mobile: types, `getProfileStats` order of preference, Wallet and menu from `profile.sales`, snapshot simplification, `adjustProfileStats` at the sites above, tests for each. | `npm test` and `npm run typecheck` green. On the S24, then one iPhone pass: a cold start shows the header totals from the snapshot with no network; publishing a post moves Posts by one at once; archiving moves it back; the menu shows Total sales with no request. |
| 4 | OTA publish for the current store builds. | App-version endpoint reports the SHA; OTA published for Android 76 and iOS 58 (or their successors). |
| 5 | Web hub reads `stats` (optional). | `owner-profile-media-hub.test.tsx` updated. |
| 6 | Delete the `+` fallback; move this plan to `docs/archive/` with a dated status line. | Guard test: no `hasMore` branch left in `profileStatValue`. |

Fixture set for step 1, and already the cases `__tests__/creation-library.test.ts`
should hold, so the two rules cannot drift apart unnoticed:

- succeeded image with `output_url` → counted
- succeeded text with no output → counted
- succeeded image with no output → not counted
- succeeded with `source_unavailable_at` → counted
- succeeded but archived → not counted
- failed, pending, processing → not counted
- a template-run step with `studio_visible = false` → not counted
- succeeded, owned by a merged guest id → counted
- posts: private and unlisted count, archived counts only under `archivedPosts`, a `review_status` of hidden still counts for the owner
- saved: a save of an archived, private or hidden post is not counted; a save of a blocked creator's post is not counted; a person with only `showcase_saves` rows gets the legacy count

## Risks and the calls already made

- **Counting live on every profile fetch, not maintained counters.** Counters
  in `profiles` kept by triggers would need a backfill, drift repair and a
  trigger on every write path of three tables. The live counts are index-only
  scans over one person's rows and run in parallel with the select. Revisit
  only if the profile route's p95 grows past about 100 ms after step 2, with
  the numbers from the deploy to show it.
- **The count and the list drifting apart.** The rule is written once in SQL
  and pinned by the fixture set on both sides. A change to either list filter
  changes both tests in the same PR.
- **Version skew.** Old apps ignore the new fields. A new app against an old
  server keeps the paged `+` fallback until step 6.
- **Grants.** Service-role-only execute, like the sales summary. A pgTAP local
  pass can hide grant drift in CI (see the migrations memory), so the test
  asserts the grants explicitly.
- **Unknown is never 0.** The header, the Wallet and the menu draw `–` for a
  number the server has not sent. That rule already holds for the balance
  (#234) and is extended, not re-decided.

## Not doing

- Persisting the library pages themselves. Owner-post media can carry signed
  links that expire, and the pages are large for a number the server can say
  in a few bytes.
- Persisting the paged counts. They are an artifact of the page size.
- Changing the profile hub's layout on the web, or adding follower counts;
  those are separate product questions.
