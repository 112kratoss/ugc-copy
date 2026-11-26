---
paths:
  - "**/src/app/admin/**"
  - "**/src/app/api/admin/**"
  - "**/src/lib/admin-*"
---

# Admin console (`/admin`)

Moved unchanged from `AGENTS.md` on 2026-10-18 so it loads only where it applies; the core file keeps a summary and points here.

A browser-only operator console living in the same Next.js app under the
`src/app/admin/(console)/` route group; `/admin/login` sits outside the group so
it renders without the console chrome. Areas: overview (reuses the
`/api/ops/*` collectors), moderation queue, support, updates and the roadmap, users & credits, revenue,
payouts, referrals, content, operator activity, system.

- **Support** (`/admin/support`, owner 2026-11-21: "first do a simple version";
  2026-11-22: "make the functionalities close to whatsapp as much as
  possible"): each account's one conversation with support, which it opens
  from Help & support in the app or `/support` on the web. The inbox is a chat
  app's list (unread count, the latest message with its ticks, "typing…"),
  read again every 15 s while visible; the ones waiting on a reply
  (`support_conversations.awaiting_reply`, also the menu's count) come first,
  oldest first. The thread is the web's shared `SupportChat` as support
  (`GET /api/admin/support?conversationId=`, read again every 3 to 20 s while
  visible): a reply goes through `send_support_message` and tells the account
  with a `support_reply` alert that opens `/support`; `POST /api/admin/support`
  also takes `read`, `typing`, `edit` (support's own message, 15 minutes),
  `delete` (for everyone, 48 hours) and `react`, each through its function in
  `src/lib/support-conversations.ts`. A reply may carry a photo (owner,
  2026-11-22: "Yes, build photos"): sent as multipart form data (`photo`, with
  the text as its caption), shrunk first in the browser to 2560 px and under
  4 MB, the host's request cap (`shrink-console-photo.ts`); the server
  re-encodes it as the account's are and keeps it under the account's folder
  of `support_attachments`, so it goes with the account. The list says
  "📷 Photo" for a photo without a caption (`last_message_has_photo`).
  Resolving is a switch; the account writing again reopens it. A resolve
  names the time of the account's latest message the operator was shown
  (`seenLastUserMessageAt`), and one that came in since refuses it with 409
  CONVERSATION_CHANGED, so a new question is never resolved away unread
  (#900's review). The lists page by offset with their true totals (a page
  past the end lands on the first), an ended console session or a thread
  that could not be read says so above the chat, and support deleting or
  editing a reply takes away or rewords the account's alert about it. The web's
  `/contact` form stays for visitors without an account.

- **Updates** (`/admin/updates`, owner 2026-11-26: Help & Support's three tabs,
  Chat · Updates · Roadmap; plan `docs/plans/help-support-updates-roadmap-plan-2026-11-26.md`):
  `GET`/`POST /api/admin/support-hub` (`admin-support-hub-route-adapter-service.ts`,
  `admin-support-hub-service.ts`). Publishing an update makes a public text post of
  the official account (the profile holding the reserved handle `magicbooklet`;
  none, and publishing refuses) through the composer's own create
  (`createOwnerPostForRoute`, the path an agent's text post takes), then marks it
  with `set_support_update` (`posts.support_update_kind`, announcement or shipped;
  a post that cannot be marked is archived again). The operator chooses who hears:
  Quiet (the dot only), Alert (an in-app alert to every registered, active
  account) or Alert + push. An announced update's alerts go out behind the
  response, `support_update_alert_batch` a batch at a time, each account once by
  the alert's dedupe key; the run stops at 40 s and "Continue sending" resumes it.
  An update's comments can be turned off (`posts.comments_locked`; the trigger on
  `post_comments` and the comment service refuse a new one, 403 `COMMENTS_LOCKED`),
  and taking an update down archives its post. The roadmap's items are kept here
  (Exploring, Building; ordered by hand; archived to leave it); "Mark shipped"
  names the published update that announced the item, and
  `ship_support_roadmap_item` alerts everyone who reacted, once.

- **Auth is a single master operator**, not per-person accounts: `ADMIN_USERNAME`
  plus a scrypt `ADMIN_PASSWORD_HASH`, an HMAC session cookie signed with
  `ADMIN_SESSION_SECRET`, and `ADMIN_REVIEWER_USER_ID` — which **must be a real
  `auth.users` id** because moderation writes it to `reviewed_by`, a foreign key.
  Missing or malformed values fail closed. Mint them with `npm run admin:credentials`.
- `ADMIN_PASSWORD_HASH` is dot-delimited base64url, **never** the conventional
  `$`-delimited MCF form — Next.js loads `.env` through dotenv-expand, which
  would read `$16384`/`$<salt>` as variable references and silently corrupt it.
- **Two gates, deliberately.** `src/proxy.ts` rejects unauthenticated `/admin` and
  `/api/admin` traffic at the edge (Web Crypto only — `admin-password.ts` uses
  `node:crypto` and must never be imported there), and every page and route
  re-checks via `admin-auth.ts`. Middleware is convenience; the route check is
  the boundary.
- Identity resolution is isolated in `admin-identity.ts` so adding per-person
  admin accounts later changes that module, not the console.
- Moderation actions reuse `moderation-ops.ts`, so the console and
  `npm run ops:moderation` share one transactional take-down path.
- Credit adjustments go through `apply_admin_credit_adjustment` (idempotency
  key, row lock, mandatory reason) with the balance policy in
  `admin-credit-adjustment-service.ts`: goodwill → promotional, refund →
  purchased, clawback → negative promotional. Reversing a real payment stays
  with `reconcile_credit_purchase_adjustment`, not the console.
- Referral decisions (`/admin/referrals`: block or unblock one referral's
  rewards, switch an inviter's link off or on) go through
  `set_referral_attribution_reward_state` and `set_referral_code_enabled`, which
  write the append-only `referral_review_events` trail in the same transaction
  (mandatory reason, reviewer from the session). The abuse guard writes its own
  blocks there as `source = 'system'`, and never overwrites an operator's
  decision. A blocked referral writes no purchase event, so an unblock is paid
  by the hourly reconciliation, not by the console. Taking back credits already
  paid is a credit adjustment. The runbook's "The abuse guard and the
  operator's controls" has the rules.
- Revenue reporting must exclude `transactions.mobile_product_id IS NOT NULL`:
  a mobile IAP writes **both** a `transactions` row and a
  `mobile_store_transactions` row (linked by `source_record_id`), so counting
  `transactions` wholesale double-counts every mobile purchase.
