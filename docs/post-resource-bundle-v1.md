# Post + Resource Bundle

magicbooklet is centered on one primary object: a post.

Creators can:
- create media inside magicbooklet and publish it as a post
- upload media made elsewhere and publish it as a post
- publish a text-only note
- attach one optional resource bundle to that same post

The post is the public proof.
The resource bundle is the reusable "how".

## Public experience

- the media or note in the post stays public
- the public post can include a short public description
- if a resource bundle exists, buyers can unlock it from the post page
- before unlocking, only the summary, the preview text, the *kinds* of included
  resources, their counts in plain words ("1 prompt, 2 files, settings") and each
  card's public title are visible; filenames, item titles and sizes are redacted
- on a post made from a creation (not a template's result), a published recipe,
  free or paid, **includes the post's Remix**: the owner and anyone who unlocked
  it can remix; everyone else is asked to unlock first (`unlock_required`, and
  `/api/remix-source` answers 403 `REMIX_UNLOCK_REQUIRED`), so the creation's
  prompt and settings never go to someone who has not unlocked a recipe that
  sells them. A free recipe is claimed by the Remix tap itself. Every read
  reports such a recipe with `allowRemix: true` and `remix` among its kinds,
  whatever its stored switch says (2026-10-27); a post without a recipe, an
  upload and a template result are unchanged
- the creation's saved inputs (reference media) are another matter: they can
  be personal, so they reach the people who unlock a recipe -- merged into it
  at read time, or restored into their remix -- only where the creator's
  stored switch (`resources.allowRemix`, the value the editor round-trips)
  offered them. "Include creation references" items are stored copies and are
  unaffected

## Bundle experience

A resource bundle can be:
- free
- paid

### Pricing is denominated in tokens

Tokens are the platform currency: **100 tokens = $1.00**. The database column is
still named `price_usd_cents` for historical reasons and stores the token count
directly — at the fixed rate the two numbers are equal.

- paid bundles start at **10 tokens** and go up in **10-token steps**
- there is no maximum
- below **100 tokens**, web checkout is credits-only: a card checkout for ten
  cents costs more in fees than it collects. At or above 100 tokens web buyers
  choose card or credits
- mobile is **always credits-only** — Apple and Google require digital goods to
  flow through in-app purchase, so mobile users buy credits via IAP and spend
  them on unlocks. A database trigger rejects any direct resource IAP
- a credits unlock charges **the price the buyer confirmed**: the clients send
  `{ "expectedPriceCredits": 900 }` to
  `POST /api/posts/:postId/resource-bundle/unlock-with-credits`, and when the
  creator has repriced the recipe since, nothing is spent and the route answers
  409 `RESOURCE_PRICE_CHANGED` with the new `priceCredits` for the buyer to
  confirm again. The comparison runs under the bundle's row lock in
  `unlock_post_resource_bundle_with_credits`. A request without the body (app
  builds before 2026-10-27) is charged the live price. The card checkout has
  the same guard through its immutable quote (`RESOURCE_QUOTE_CHANGED`)

Bundle contents can include:
- prompt text
- workflow notes, links, and snapshots
- reference images, video, and audio
- source files and attachments
- presets and settings
- external links
- remix access

Items can be grouped into **sections** and scoped to specific media in a
multi-item post, so a five-image post can ship a different prompt per image.

## What a buyer keeps

Every content change to a bundle is snapshotted into an immutable **revision**,
and each purchase pins the revision that was live at checkout.

- **a sold recipe can be edited** (owner decision, 2026-10-27): its items,
  preview, title, price and access mode can all change after a sale, paid or
  free, and each save is a new revision. Buyers see the latest version by
  default and keep the one they unlocked, which stays available to them
  forever, so a correction never takes away what they paid for. Only a
  moderation lock on the post stops an edit; a sold recipe cannot move to
  another post or creator
- removing a recipe that anyone has (a sale or a free unlock) **retires** it:
  delisted (draft), `retired_at` set, no new sales, buyers keep it. It stays
  retired when the post goes public again; saving a recipe on the post again
  brings the row back as the post's recipe. A recipe nobody has is deleted
- "Updated <date>" on a recipe is its latest revision's time, so it moves
  with content changes only, never with a sale or a free unlock
- a post that has been bought can no longer be hard-deleted. Deleting it
  **tombstones** it: gone from every public surface, still resolvable in the
  buyer's unlock library with its title and cover intact

The one case where access does not survive is a **moderation take-down**:
violating content stops being served to everyone, buyers included.

## Creator earnings

- creators keep **85%**; the platform fee is 15%
- earnings accrue to `creator_resource_wallets` in exact token subunits, and are
  reversed automatically on refund
- payouts require a **$100** (10,000 token) minimum balance

## Product rules

- one post can have at most one resource bundle
- a bundle can only be publicly published when its post is public
- there is no separate user-facing marketplace item creation flow
- marketplace is a secondary discovery surface for public posts with published
  bundles
- creator revenue is never public; sales counts are

## UX principle

The creation flow should feel like:

1. make or upload the proof
2. publish the post
3. optionally attach free or paid resources in the same flow
4. let buyers unlock the resources directly from the post
