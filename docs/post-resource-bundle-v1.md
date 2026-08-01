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
- before unlocking, only the summary, the preview text, and the *kinds* of
  included resources are visible; filenames, item titles and sizes are redacted

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

Every published state of a bundle is snapshotted into an immutable **revision**,
and each purchase pins the revision that was live at checkout.

- later edits reach buyers as improvements — they see the current version by
  default
- the revision they paid for stays available to them forever, so a creator
  cannot hollow out or relabel a sold bundle
- a bundle that has been bought can no longer be deleted. Removing the unlock
  **retires** it: delisted, no new sales, buyers unaffected
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
