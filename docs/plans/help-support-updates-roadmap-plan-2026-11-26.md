# Help & Support: Chat, Updates and Roadmap (plan, 2026-11-26)

Status: built, both phases, on branch `feat/support-updates-roadmap` (off `main` at `92db9822d`), on the owner's "go ahead and finish it . giving you full permissions" (2026-11-26). "As built" at the end lists where the build differs from this plan.

## The owner's ask and what was agreed

On 2026-11-26 the owner asked for three options when someone opens Help & Support ("in the help and support when they opens it, i actually want 3 option"):

1. **Feature requests:** the features being worked on and a log of old ones. Users cannot message there, but can react.
2. **Announcements:** news, or questions to users. Users cannot chat there, but each announcement has comments people can open and add to.
3. **The regular support chat.**

The owner asked for an honest opinion and said merging or adding sections was fine. The recommendation, given in chat and answered "Yes, plan it":

- **Sections: Chat, Updates and Roadmap.**
  - *Updates* are the announcements and the log of shipped features in one timeline, with reactions and comments. Comments can be turned off for any single update.
  - *Roadmap* is what is coming. It takes reactions only, and each reaction counts as a vote.
- **Updates are built on posts:** they are posts of the official @magicbooklet account, not a new system.
- **The chat stays one tap away.** Help & Support still opens on Chat (as since #933), with Updates and Roadmap as tabs at the top and an unread dot on Updates. This holds on the web and in the app.
- **Added:**
  - a "You asked, it's live" alert to everyone who reacted to a roadmap item when it ships;
  - a "Suggest a feature" button that opens the chat;
  - an alert for new announcements, and a push for big ones;
  - polls, later.
- **Kept small:** the roadmap is short and gives no dates. Later, drafts of Updates entries are written from merged PRs for the owner to approve in `/admin`.

## What exists today (read at `92db9822d`)

- **Support chat:**
  - Web: `/support` (`src/app/support/`), which its layout wraps whole in `RequireAuth`.
  - App: `app/support.tsx`. Console: `/admin/support`.
  - Routes: `/api/support/*`, for registered accounts only (`src/lib/route-identity-policy.ts`).
  - Shared rules, including the six quick reactions: `ugc-mobile/lib/support-conversation-policy/`.
- **Posts:** `public.posts` has `visibility` (`public`, `unlisted` or `private`) and `post_format` (`text`, `media` or `mixed`, with `body` for text). Text posts appear in Home's Notes feed and on the post page: `/showcase/<id>` on the web, `post/[id]` in the app.
- **Comments:**
  - The table is `post_comments`, which is threaded and backend-owned (`create_post_comment` and its sibling functions). Comments are allowed on public posts only.
  - It already has comment likes, the creator's heart, one pinned comment, edits, reports and the moderation queue, blocks, and anonymizing at account deletion.
  - Guests and signed-out visitors can read a thread (`GUEST_READABLE_REGISTERED_ROUTES`, and a cached `scope=public` read for the web).
- **Post reactions:** posts have none. They have saves, shares, remixes, views and comments.
- **Alerts:**
  - `mobile_notifications`, whose type check was last widened in `20261122150427_support_conversations.sql`.
  - `createMobileNotification`, and the Expo push batch senders in `src/lib/mobile-notifications.ts`.
  - The app opens only links on `NOTIFICATION_ROUTE_PATTERNS` (`ugc-mobile/lib/notifications.ts`). `/showcase/<id>` and `/support` are already on that list.
- **Missing pieces:**
  - Nothing sends an alert to every account yet.
  - No setting names the official account; @magicbooklet is only a reserved handle.
- **Names already taken:**
  - "What's new" is the new-models strip (`whats-new-models-v1.json`).
  - "Update" already means OTAs and post edits (`post-update-service.ts`).

  So code here says `support_update` and `support_roadmap`, and the screens say "Updates" and "Roadmap".

## The screen (web and app)

- **Tabs:** a segmented control under the header, Chat · Updates · Roadmap, opening on Chat.
  - The tab travels as `tab`: `/support`, `/support?tab=updates` and `/support?tab=roadmap`, on the web and as the app route's parameter.
  - The Roadmap tab stays hidden until phase 2.
- **Unread dot:**
  - It shows on Updates when a published update is newer than the reader's last look.
  - The same dot shows on the app menu's Help & Support row and on the web shell's Help & feedback.
  - Opening Updates marks it seen.
- **Chat:** unchanged.
- **Updates:**
  - Newest first, 20 to a page.
  - A card shows the kind (Announcement or New), title, date and the first lines of the body.
  - Under that sits the reactions row: the six quick reactions, one per person, where a tap sets, changes or clears yours.
  - Then the comment count, or "Comments off". Tapping the card opens the post page with its comments.
- **Roadmap (phase 2):**
  - Grouped as Building, Exploring and Shipped recently.
  - An item shows its title, one line and its reactions; the count of people is the vote.
  - "Suggest a feature" opens Chat with the composer starting "Feature idea: ".
- **People without an account:**
  - Guests (app) and signed-out visitors (web) can read Updates and Roadmap.
  - Reacting or commenting asks them to sign in, as comments do today.
  - The Chat tab keeps today's guest state: sign in, or email.
- **The web page itself:**
  - `/support` stops being behind `RequireAuth` as a whole; only its Chat tab asks for a sign-in.
  - Help & feedback then goes to `/support` for everyone (today a visitor without a session goes to `/contact`).
  - `/contact` stays linked from the page's footnote.

## Updates are official posts

- **What an update is:** a public text post by @magicbooklet with `posts.support_update_kind` set to `announcement` or `shipped`.
  - Only the console's publish sets that column, with the service role.
  - The publish service refuses any author but the official account.
  - A check in the database keeps the column null for every other account. It is a trigger comparing `user_id` to the profile holding the reserved handle; the review decides whether it earns its keep.
- **Where it shows:** an update shows in feeds and on the @magicbooklet profile like the account's other posts (decision 1 below). Its comments, reports, moderation and blocks are the post's own.
- **Locked comments:** `posts.comments_locked boolean not null default false`.
  - `create_post_comment` refuses a new comment on a locked post with `COMMENTS_LOCKED`; the comments already there stay readable.
  - Both post pages hide the composer and say "Comments are off".
  - Only the console sets it for now.
- **Reactions:** `support_update_reactions`, with columns:
  - `post_id`, referencing `posts` with `on delete cascade`;
  - `user_id`, referencing `auth.users` with `on delete cascade`;
  - `emoji`, checked against the six;
  - `created_at`;
  - primary key `(post_id, user_id)`.

  Writes go through one SECURITY DEFINER function that sets or clears a reaction. The table is backend-owned like comments: RLS on, nothing granted to clients.
- **Seen marker:** `support_hub_reads (user_id primary key, updates_seen_at timestamptz not null)`. A guest's or signed-out visitor's marker lives on the device: AsyncStorage in the app, `localStorage` on the web, guarded for private windows.
- **The official account:** one server function finds @magicbooklet's user id from its reserved handle and fails closed, with a console error naming the missing profile.

## Roadmap (phase 2)

- **Items:** `support_roadmap_items`, with columns:
  - `id`;
  - `title`, 1–80 characters;
  - `summary`, 0–280 characters;
  - `status`: `exploring`, `building` or `shipped`;
  - `position`;
  - `shipped_update_post_id`, referencing `posts` with `on delete set null`;
  - `shipped_at`, `archived_at`, `created_at`, `updated_at`.
- **Reactions:** `support_roadmap_reactions (item_id, user_id, emoji, created_at, primary key (item_id, user_id))`, with one function to set or clear a reaction.
- **Shipping an item:** marking an item shipped names the update that announced it. The server then alerts everyone who reacted.
- **Shipped recently:** shipped items show there for 30 days, then leave the list; they live on as Updates.

## Routes

Each route is a `route.ts` shell, a `*-route-adapter-service.ts` with its rate limit, and a service. Each gets entries in `contracts/mobile-api-v1.json` and `contracts/mobile-api-operations-v1.json`, plus policy entries. The admission rules are in `.claude/rules/web-mobile-contract.md`.

**Phase 1**

- `GET /api/support/updates?cursor=`: the published updates, newest first, 20 to a page.
  - Each carries `id`, `kind`, `title`, `body`, `createdAt`, `commentCount`, `commentsLocked`, `reactions` (counts by emoji) and `myReaction`, which comes only with a registered token.
  - The page also carries `latestAt`, for the dot.
  - Everyone can read it, on the comments thread's precedent: listed in `GUEST_READABLE_REGISTERED_ROUTES`, with a cached `scope=public` read for a web reader with no session.
- `POST /api/support/updates/[postId]/reaction`, body `{ emoji }` (null clears it): registered accounts only.
- `POST /api/support/updates/seen`, body `{ upTo }`: registered accounts only.

**Phase 2**

- `GET /api/support/roadmap`: the items by status and position, with their counts and `myReaction`. Readable the same way as Updates.
- `POST /api/support/roadmap/[itemId]/reaction`: registered accounts only.

**Console:** `GET` and `POST /api/admin/support-updates`, and in phase 2 `/api/admin/support-roadmap`, behind both admin gates (`.claude/rules/admin-console.md`).

## Console: `/admin/updates`

- **The list:** each update with its kind, date, reaction counts and comment count.
- **The composer:**
  - Fields: kind, title, body (plain text with links, as text posts take), and comments on or off.
  - Who hears about it: *Quiet* (the dot only), *Alert* (an alert to every registered account) or *Alert + push*.
  - Publishing creates the official post through the composer's own text-post create, the path `publish_post` takes for an agent (`src/lib/agent-upload-publish-request.ts`), so the public-post rules hold. It then sets `support_update_kind`.
- **Editing:** the title and body can change, comments can be locked or unlocked, and unpublishing archives the post.
- **Phase 2:** a Roadmap list to add, edit, reorder and change status, plus "Mark shipped", which picks the update that announced the item.
- **Phase 3:** "Drafts from merged PRs".

## Alerts

- **Types:** `support_update` and `support_roadmap_shipped`, both in category `system`.
  - Both link to `/showcase/<postId>`, which is already on the app's list, so installed apps open them with no update.
  - The type check and the deep-link lines in `mobile-api-v1.json` are widened in the same change.
- **Sending to everyone:** a job in the `backend-jobs.ts` registry sends an announcement's alerts in batches to registered accounts (`is_anonymous = false`).
  - The publish request starts the first batch in `after()`.
  - It pushes only when the console chose *Alert + push*, through `sendExpoPushNotificationBatch`.
  - A `support_update_broadcasts` row records progress (`post_id`, `push`, `cursor`, `sent_count`, `finished_at`), so a retry carries on and never sends twice.
- **"You asked, it's live" (phase 2):** one alert to each account that reacted to the item, sent by the same job.

## Shared rules

A new module, `ugc-mobile/lib/support-hub-policy/`, with its own self-contained `tsconfig.json` and no React Native, Expo or Node imports. It holds:

- the tabs, their order and the default;
- the `tab` parameter;
- the update kinds and their labels;
- the six reactions, re-exported from the chat's policy;
- the unread rule;
- the cards' words;
- the roadmap statuses and their words;
- the "Suggest a feature" starting words;
- a reader for every answer.

It is imported by the server, the web's `/support` and the app's `support.tsx`.

## Phases

1. **Updates:**
   - the migration (`support_update_kind`, `comments_locked`, reactions, reads, broadcasts) and its routes;
   - the console page;
   - Chat · Updates on the web and in the app;
   - the alerts and the sending job;
   - locked comments on both post pages.
2. **Roadmap:** its migration, routes and console tab, the Roadmap tab, "Suggest a feature", and the shipped alerts.
3. **Later:** polls on updates, pictures on updates, drafts from merged PRs, and keeping an update out of feeds if that is wanted.

## Sessions

- Phases 1 and 2 touch the same screens, the same policy module and the same contract file, so each is one branch and they go in order: phase 2 starts once phase 1 is merged.
- The one piece that could run beside phase 1 is phase 3's script for drafts from merged PRs, which touches nothing else.

## Checks for each phase

- **Unit:**
  - services, adapters and view models in both suites, and the shared policy;
  - a `*-migration.test.ts` for each migration;
  - pgTAP for the new tables' RLS and functions, with the new-table checklist;
  - contract tests on both sides, and `route-identity-policy.test.ts`.
- **E2E (web):**
  - a signed-out visitor reads Updates, and a reaction asks them to sign in;
  - the Chat tab is unchanged;
  - the console's composer works.
- **Devices:**
  - before merging, the iPhone simulator and the Pixel emulator against a local stack;
  - after the OTA, a look on the S24 and the iPhone.
- **Review:** the change has migrations, route admission and alerts, so it gets AGENTS.md's `max` review.

## Rollout

1. Release the web first; its release applies the migration.
2. Publish the app OTA: JS only, no store build.
3. Publish the first update from the console as *Quiet*, then one as *Alert*.
4. Use *Alert + push* only after the owner has seen the flow end to end.

## Owner decisions (built this way unless the owner says otherwise)

1. **Feeds:** updates also show in Home feeds and on the @magicbooklet profile, because they are its posts. Keeping shipped entries out of feeds is a phase 3 filter.
2. **Alerts:** *Alert* goes to every registered account; guests see only the dot. Push goes out only when the owner picks *Alert + push* for that update.
3. **Who can open `/support`:** everyone. Signed-out visitors read Updates and Roadmap, Chat asks them to sign in, and Help & feedback goes to `/support` for everyone.
4. **Reactions:** the chat's six, one per person per item. On the Roadmap, the number of people is the vote count.
5. **Roadmap statuses:** Exploring, Building and Shipped, with no dates. Shipped items stay 30 days.

## As built (2026-11-26)

Both phases went into one branch: once one session built them, the reason for two (two sessions touching the same screens) no longer held. Three differences from the plan above:

- **The seen marker lives on the device only.** It is stored in AsyncStorage in the app and in `localStorage` on the web, under `SUPPORT_UPDATES_SEEN_STORAGE_KEY`.
  - There is no `support_hub_reads` table and no `POST /api/support/updates/seen`.
  - A dot seen on one device is not cleared on another. In exchange, nothing is written per reader, and there is one route fewer.
- **The broadcast does not use the job registry.** An announced update's alerts are sent behind the publish response (`runSupportUpdateBroadcast`, 40 s budget, batches of 300). The console's "Continue sending" resumes a run that stopped short.
  - `support_update_alert_batch` makes the send safe to repeat: each account is told once, by the alert's dedupe key `support_update:<post id>`.
  - A backend job can be added later if broadcasts outgrow one request.
- **Two read functions were added:** `support_update_reactions_for` and `support_roadmap_reactions_for`. Each list reads its counts, and the reader's own reaction, in one call.
