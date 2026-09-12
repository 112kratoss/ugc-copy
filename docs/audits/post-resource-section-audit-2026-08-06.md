# Post Resource Section Audit

Date: 2026-08-06
Scope: the resource bundle ("recipe") authoring section of the post composer, on web
(`src/app/post/new/NewPostClient.tsx`) and mobile (`ugc-mobile/app/post/new.tsx`,
`ugc-mobile/lib/post-new-view-model.ts`), measured against `docs/post-resource-bundle-v1.md`.

## Result

**The mobile implementation is materially ahead of web, and the gap is product surface, not polish.**
Mobile authors a bundle as a list of discrete resource cards on a dedicated step, with per-card
validation, per-media scoping, a required buyer-facing preview, and an explicit lock for sold
bundles. Web authors the same object as a single long conditional form embedded in the main
composer, with one aggregate validity boolean, no scoping, no editable buyer-facing copy, and no
sold-bundle lock.

Two of the six findings below are not styling differences — they change what a buyer sees before
paying, and whether a product rule stated in the spec is enforced at all on web.

The commerce backbone underneath both clients is sound: the marketplace quality gate runs
server-side on publish *and* update, and purchased revisions are pinned. The problems are in the
authoring layer.

## Model comparison

| | Web | Mobile |
|---|---|---|
| Placement | Inline section in the single-page composer | Dedicated step 2 of 2 |
| Authoring model | Select 5 "kinds", fill a conditional field per kind | Add N discrete cards, 9 types, each edited in a sheet |
| Item taxonomy | 5 kinds + 5 item types + 9 roles + section kinds | 9 card types |
| Buyer-facing summary | **Auto-generated, not editable** | — |
| Buyer-facing preview | **Auto-generated, not editable** | **Required**, 180 chars, with suggestion |
| Per-media scoping | **Absent** | `ResourceScopePicker` |
| Validation | One boolean (`hasResourceContent`) | Per-card errors + readiness + package status |
| Sold-bundle lock | **Absent** | Explicit lock screen |
| Earnings shown | "payment processing may affect the final payout" | "You earn ~N tokens" (85%) |

## Findings

### 1. Buyer-facing copy is machine-generated on web and cannot be edited — High

`resourceSummary` and `resourcePreviewText` are declared as state with **no setter**:

- `NewPostClient.tsx:993` — `const [resourceSummary] = useState(initialBundle.summary ?? '')`
- `NewPostClient.tsx:994` — `const [resourcePreviewText] = useState(initialBundle.previewText ?? '')`

Neither is rendered as an input anywhere in the section. For a new post both are empty, so the
bundle falls back to template strings from `buildDefaultResourceSummary` (`:649`) and
`buildDefaultResourcePreview` (`:661`):

> "Unlock the prompt and notes behind this public post."
> "Includes prompt and notes for reuse after access."

`docs/post-resource-bundle-v1.md` states that before unlocking, "only the summary, the preview
text, and the *kinds* of included resources are visible." Those are the only three things a buyer
can weigh — and on web two of them are a template, varying only by which kind chips are ticked.

Mobile treats the preview as the author's job: required, counted to 180 characters, with a
"Use suggested preview" shortcut for those who want the generated version
(`ugc-mobile/app/post/new.tsx:679-698`).

**Why this outranks a cosmetic gap:** `assessMarketplaceListingQuality` rejects a preview under 18
characters or one that reads as placeholder text. The generated strings clear both by construction,
so for web-authored bundles that gate can never fire. It is not protecting anything — it is being
satisfied by a machine. Every paid listing created on web ships near-identical marketing copy into
a marketplace whose entire job is helping buyers choose between listings.

**Recommendation:** add summary and preview inputs to the web section, seeded with the generated
text rather than replaced by it — the same pattern mobile already uses.

### 2. The sold-bundle lock exists only on mobile — High

Mobile refuses to edit a bundle that has been purchased, with a dedicated explanation
(`ugc-mobile/app/post/new.tsx:2744` → `:529-543`): access mode, price and contents are frozen,
visibility still changes.

Web computes the same signal and discards it. `hasPaidOrders` is derived in `owner-posts.ts:597`,
declared on the draft type (`post-editor-types.ts:37`), and passed into the composer
(`src/app/post/[id]/edit/page.tsx:35`) — then **never read in `NewPostClient.tsx`**.

The server does not backstop it either: `sales_count` is selected for display and ordering only,
with no guard rejecting a mutation to a sold bundle.

**Impact is narrower than it first looks, and worth stating precisely.** Buyers are not robbed:
`20260801100000_post_resource_bundle_revisions.sql` pins each purchase to the revision that was
live at checkout, so what someone paid for stays intact. What a web edit *can* do is degrade the
current version — the one buyers see by default — and change the price and access mode of a live
sold listing. The spec's promise that "a creator cannot hollow out or relabel a sold bundle" is
enforced by one client and not the other.

**Recommendation:** read `hasPaidOrders` in the web composer and mirror mobile's lock. Separately,
consider a server-side guard, since the rule is a product invariant rather than a UI nicety.

### 3. Per-media scoping is mobile-only — Medium

The spec calls this out directly: "Items can be grouped into sections and scoped to specific media
in a multi-item post, so a five-image post can ship a different prompt per image."

Mobile implements it (`ResourceScopePicker`, `ugc-mobile/app/post/new.tsx:1332`), including an
"applies to all" default and per-output selection. A grep of the web section for any scoping or
`mediaKey` control returns nothing.

A creator on web therefore cannot ship a per-image prompt for a five-image post — a documented
capability of the product, reachable from only one client.

### 4. The two clients use different resource vocabularies — Medium

Web models a bundle as 5 kinds (`RESOURCE_KIND_OPTIONS`, `:220`) plus a separate item taxonomy of
5 types and 9 roles. Mobile models it as 9 card types
(`POST_COMPOSER_RESOURCE_CARD_OPTIONS`, `post-new-view-model.ts:478`). The two lists overlap
partially and agree on nothing exactly — mobile has `settings`, `reference_media` and `other`; web
has `role` values like `character_reference` and `before_input` with no mobile equivalent.

Mobile does read incoming sections and items back into cards and re-serialize them
(`post-new-view-model.ts:562-571`, `:1059`), so this is not obviously lossy. But nothing pins the
round trip: there is no test that authors a bundle on one client's model, loads it into the other,
saves, and asserts the payload survived.

**Recommendation:** add a round-trip fixture test before reconciling the vocabularies. This repo
already has the pattern — `contracts/*.json` fixtures imported by both suites — and has been bitten
by exactly this class of mismatch before in the feed.

### 5. Web validation is one boolean; mobile validates per card — Medium

Web reduces the whole bundle to `hasResourceContent` (`NewPostClient.tsx:1124`), surfaced as
"Add one asset". A creator with four half-filled resources is told only that something is missing.

Mobile computes per-card errors and readiness (`getPostComposerResourceCardErrors`,
`post-new-view-model.ts:1615`) plus an aggregate package status, so each incomplete card is marked
where it sits.

This is the difference most likely to explain the feeling that mobile is better: the web form does
not tell you what is wrong, only that something is.

### 6. Currency presentation on web is inconsistent — Low

The mode toggle reads **"Paid ($)"** while the adjacent field is denominated in tokens
(`NewPostClient.tsx:3552`, `:3590`), and the input's `min`/`step` come from
`POST_RESOURCE_MIN_PAID_PRICE_USD_CENTS` / `..._INCREMENT_USD_CENTS`. Those constants are both `10`
and do hold token counts — the doc explains the historical column naming — so the **values are
correct**; only the presentation misleads.

More substantively, web never states the split. It says "payment processing may affect the final
payout", which is vaguer than the truth: the doc fixes creator share at 85%, and mobile simply shows
"You earn ~N tokens" (`ugc-mobile/app/post/new.tsx:717`). Web's hedge reads as less trustworthy than
the real number.

## What web does better

Worth preserving in any convergence:

- **Section layout.** Web exposes explicit section rows with section kinds; mobile derives sections
  from cards.
- **Richer item taxonomy.** The 9 `RESOURCE_ITEM_ROLE_OPTIONS` (style reference, product reference,
  character reference, before/input …) carry provenance mobile's flatter card types cannot express.
- **Attachment rows** carry type *and* role per row, which is more structured than a mobile card's
  attachment list.

The right end state is likely mobile's interaction model — discrete cards, per-card validation, a
sheet — carrying web's richer per-item metadata, rather than either one winning outright.

## Verified as sound

Not everything here needs work, and these were checked rather than assumed:

- **The marketplace quality gate is enforced server-side**, on both creation
  (`post-publish-service.ts:163`) and edit (`post-update-service.ts:1004`) — not client-only. A
  direct API call cannot publish an empty paid bundle.
- **Purchased revisions are pinned** (`20260801100000_post_resource_bundle_revisions.sql`), which is
  what keeps finding 2 from being a buyer-facing integrity bug.
- **Mobile's authoring sheet is accessible**: every input carries an `accessibilityLabel` and
  `accessibilityHint`, with keyboard-inset handling and `keyboardShouldPersistTaps`.

## Suggested order of work

1. Finding 1 — web summary and preview inputs. Smallest change, largest buyer-visible effect.
2. Finding 2 — read `hasPaidOrders` in the web composer; decide separately on a server guard.
3. Finding 5 — per-item validation on web, which mostly means adopting mobile's error shape.
4. Finding 4 — add the round-trip fixture test *before* touching either taxonomy.
5. Finding 3 — per-media scoping on web.
6. Finding 6 — relabel "Paid ($)" to tokens and state the 85% split.
