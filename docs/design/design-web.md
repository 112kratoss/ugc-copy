# Magicbooklet Web UI/UX Guide

Audience: AI agents and engineers working in the Next.js web app (`src/app/**`, `src/components/**`).

Read this before editing web UI. It covers what each token, primitive and page pattern is for. The values live in `src/app/globals.css` and `src/components/DesignSystem.tsx`, and code wins wherever the two disagree.

Rewritten against the code on 2026-09-24. The research behind the rules is in [ui-consistency-research-2026-06-14.md](./ui-consistency-research-2026-06-14.md). The mobile app has its own guide, [design-mobile.md](./design-mobile.md).

## Product North Star

Magicbooklet web is a premium dark AI creator studio and community:
- media-led;
- dense enough for serious creative work;
- fast to move from idea to output.

It borrows Pinterest-level consistency and feed discipline without copying Pinterest's brand. The web stays dark. It shares its type ramp and coral with the mobile app's dark scheme, so the two read as one product.

Principles, distilled from Pinterest Gestalt, Shopify Polaris, Material 3, Apple's HIG and Atlassian:

- Consistency comes from reusable components, published tokens and one icon library, not from per-page styling.
- Route text through named roles, spacing through a 4px base with an 8px rhythm, and rounding through a small scale.
- Component APIs are the enforcement layer. Typography lives in code, not only in this document.
- Legibility wins over decoration. No tiny critical text, and all caps only for short labels.

## Source Files

- **Tokens and shared classes:** `src/app/globals.css`, which holds the `:root` variables, Tailwind's `@theme` mapping and the `.ui-*` classes.
- **Signed-in utilities:** `src/app/non-public-utilities.css`, the route-only utility supplement (see [CSS split](#css-split)).
- **Primitives:** `src/components/DesignSystem.tsx`.
- **App shell:** `src/components/AppShellClient.tsx`, with its destinations in `src/components/app-shell-nav.ts`.
- **Toasts and the confirm dialog:** `src/components/FeedbackViewport.tsx`, driven through `feedback-state`.
- **Home shell:** `src/components/HomeExperience.tsx`.
- **Creator pages:** `src/components/CreatorStudio.tsx`.
- **Marketing pages:** `src/components/FeatureLandingPage.tsx`.
- **Feed:** `src/app/feed/` (`FeedClient`, `WindowedFeedList`, `FeedPostCard`, `FeedMediaLightbox`) and `src/components/PostComments.tsx`.

## CSS Split

- `globals.css` is the stylesheet for every route a signed-out visitor can land on: marketing, blog, models, the post, creator and referral landings, templates, login and auth, and the policy pages (terms, privacy, child safety, cancellation, account deletion).
- Signed-in surfaces add `non-public-utilities.css` through their route layouts. It stays in the document after a client navigation, so a public page opened from a signed-in route is drawn with it too: it scans the whole app folder and every component, the public ones included, and holds every utility `globals.css` holds.
- CSS is inlined per response (`experimental.inlineCss`), so a public route must never import the supplement.
- `src/__tests__/route-style-readiness.test.ts` pins which directories link which sheet and the exact component closure of `globals.css`; `route-style-two-sheet-order.test.ts` holds the supplement to every utility rule of `globals.css`.
- A class used by both public and signed-in pages, such as toasts and the confirm dialog, lives in `globals.css` as a named class rather than as utilities.

## Typography

**Geist Sans**, from `next/font` in `src/app/layout.tsx`, carries everything.
- It loads with `display: "optional"`, so a slow first visit keeps the metric-compatible fallback instead of repainting when the font arrives.
- Code, IDs and technical values use `font-mono`, the system monospace stack.

Roles, through `Text` (`TEXT_VARIANTS` in `DesignSystem.tsx`):

| Role | Size | Weight / tracking | Use |
| --- | --- | --- | --- |
| `display` | 36px → 48px (sm) → 60px (lg), line 1.08 | 800, −0.035em | Landing heroes only |
| `pageTitle` | 36px → 48px (sm), tight | 800, −0.025em | One page heading |
| `sectionTitle` | 24px → 30px (sm), tight | 700, tight | Section headings |
| `cardTitle` | 20px / 28px | 700, tight | Cards and panels |
| `body` | 16px / 24px, secondary colour | 400 | Readable copy |
| `bodySm` | 14px / 24px, muted colour | 400 | Compact explanations |
| `label` | 13px / 18px, secondary colour | 700 | Controls and form labels |
| `caption` | 12px / 17px, faint colour | 600 | Metadata only |
| `metric` | 36px / 40px | 800, tight | Dashboard numbers |
| `code` | 13px / 20px, mono | 400 | Code and IDs |

Rules:

- Use `Text`, `Kicker` and `SectionHeader` for new work. Pick the element with `as` (`h1`, `h2`, `p`…) for the document outline and the variant for the look.
- Titles carry the role's own tracking. Don't add tracking elsewhere, and don't write arbitrary type classes (`text-[1.2rem]`, `tracking-[...]`) outside a shared primitive.
- Keep uppercase to `Kicker`, which is 12px with 0.16em tracking, one to three words.
- Hero type never goes inside compact panels or cards.

## Color And Surfaces

`:root` in `globals.css` (the `--ui-*` variables, mapped into Tailwind's `@theme` as `ui-*` and `brand-*` colours):

| Token | Value | Use |
| --- | --- | --- |
| `--ui-bg-app` | `#0c0c0e` | Root ground |
| `--ui-bg-page` | `#101012` | Page background |
| `--ui-surface-1` | `#19191c` | Panels and cards |
| `--ui-surface-raised` | `#202024` | A step above a panel |
| `--ui-surface-2` / `--ui-surface-3` | ivory 5% / 8% | Soft fills, hover |
| `--ui-surface-inset` | `#0d0d0f` | Inputs and wells |
| `--ui-border-subtle` / `default` / `strong` | ivory 9% / 14% / 24% | Hairlines |
| `--ui-text-primary` · `secondary` · `muted` · `faint` | `#fff8ed` · `#ddd6cc` · `#aaa39b` · `#8d8780` | Type ramp, shared with mobile's dark scheme |
| `--ui-primary` / `--ui-primary-strong` | `#ff7a59` / `#ff8a6d` | Coral: primary actions and their hover |
| `--ui-primary-on` | `#1a0d08` | Ink on a coral fill |
| `--ui-primary-soft` / `--ui-primary-selected` | coral 13% / `#2a1b1a` | Washes and selected rows |
| `--ui-focus` | `#ffaa94` | Focus rings |

Tool accents: image `#73bff2`, video `#ff8e72`, motion `#b7a0f5`, workflow `#67d6a7`, commerce `#f2b95e`, danger `#ff7c8b`. A component takes an accent's border, badge, icon well, wash and text classes from `getAccentClasses(accent)`, never a local accent map.

Rules:

- Surfaces are dark, low-noise and layered by fill and border, not by shadow.
- Gradients are for media placeholders and accent washes only. No decorative orbs, bokeh blobs or purely atmospheric backgrounds.
- Don't repeat raw alphas (`border-white/10`, `bg-white/5`) outside a shared primitive; use the tokens.
- Keep media visible and inspectable.

## Spacing And Layout

- **Scale:** `--ui-space-1` … `--ui-space-24` run from 4px to 96px (4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96). Tailwind's own steps match it.
- **Section gaps:** `.ui-section-gap` spaces page sections from 32px to 48px (`clamp`, 4vw).
- **Panel padding:** `Surface` pads `sm` 16px, `md` 20px, `lg` 24px.
- **The top bar:** the sticky app-shell top bar is exactly its token, border included: `--app-shell-topbar-height`, 4rem, 64px at the default text size (its `min-height` with no vertical padding, so its controls centre in it rather than grow it). A larger browser text size grows its 3rem controls, and the token in rem grows with them; at a fixed 64px the bar grew past its token instead (73-75px at 24px text), and every page sized from the token scrolled 9-11px (until October 2026). Anything else pinned below it offsets by that variable or in rem, never a pixel figure such as `top-[72px]`. Its controls on the right keep their size and the search field gives way; below 1024px the field folds into its search button and "New creation" into a 48px icon (`.app-shell-search` and `.app-shell-create` in `globals.css`).
- **Page height:** a page root fills the window with `.ui-page` or `min-h-screen`; an editor that never scrolls the page (the workflow canvas) is exactly the window's height, `h-screen`, and scrolls its own panels. Inside the app shell each fills what the shell leaves instead: the window less the top bar and, below 768px, the bottom navigation's room (`--app-shell-page-height`, which `.app-shell-content .ui-page`, `.app-shell-content > .min-h-screen` and `.app-shell-content > .h-screen` read in `globals.css`). A short page then never scrolls, where it used to scroll one bar's height and put its top under the bar. An editor keeps at least 20rem, so on a window too short for that (a phone held sideways) the page scrolls rather than squeezing it. Don't size a root by hand (`min-h-[calc(100dvh-64px)]`, `h-[calc(100vh-4rem)]`): beside one of those classes the shell's rule overrules it, and without one it misses the bottom navigation's room, which the page then scrolls through below 768px (the workflow library and canvas did until October 2026). The 404 follows the same rule through the app's own `src/app/not-found.tsx`, drawn for any address with no page and for any `notFound()` without a not-found of its own: Next's default sets `height: 100vh` inline, which no sheet rule overrules. The body and the shell are at least `100dvh`, the window as it is, never `100vh`: on a phone that is the window with its toolbar put away, and a body of 100vh let every short page scroll by the toolbar's height while it showed (until October 2026).
- **Stable dimensions:** fixed-format UI gets stable dimensions with responsive constraints, and media grids hold their aspect ratio so nothing shifts as it loads.
- **Cards:** page sections are full-width bands or unframed layouts. Cards are for repeated items, tools and modals, and never nest inside decorative cards.

## Radius, Elevation And Motion

- **Radius:**
  - The scale is `--ui-radius-sm` 8, `md` 12, `lg` 16, `xl` 20, `2xl` 24, `pill` 999.
  - Cards and panels (`.ui-card`, `.ui-surface`) use 24, media frames 20, and buttons, pills and icon buttons `pill`.
  - No arbitrary `rounded-[...]`.
- **Elevation:** `--ui-shadow-panel` for floating panels and `--ui-shadow-card-hover` for a lifted interactive card. Most surfaces need none, and there are no inline `shadow-[...]` strings.
- **Motion:**
  - Durations are `--ui-duration-fast` 160ms, `--ui-duration-base` 180ms and `--ui-duration-reveal` 240ms, on `--ui-ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`).
  - Entrances use `.ui-enter`, `.ui-enter-pop`, and `.ui-stagger` (35ms steps).
  - `prefers-reduced-motion` cuts every animation and transition to nothing and turns off smooth scrolling, app-wide.

## Icons

Use `lucide-react` only, with no custom inline SVGs for standard actions.

- **Sizes:** 16px (`h-4 w-4`) in compact controls and card actions, 20px in normal controls, 24px for feature marks.
- **Buttons:** icons go inside buttons for common commands (create, save, share, download, search, filter, expand, play). `Button`, `Pill` and `Kicker` take an `icon` prop.
- **Labels:** pair unfamiliar icons with visible text or a tooltip. Don't mix filled emoji-style icons with Lucide.

## Components

Use these from `DesignSystem.tsx` for new or migrated UI:

| Primitive | Use |
| --- | --- |
| `Text` | Every piece of copy: a role and an element |
| `Kicker` | Short uppercase metadata, optionally with an icon |
| `SectionHeader` | Eyebrow, title, body and an optional action; `compact` inside panels |
| `Surface` | A panel or card shell: `panel`, `card`, `soft` or `ghost`, padding `none`/`sm`/`md`/`lg`, `interactive` for a hoverable card |
| `Button` | `primary` (coral fill, ink text), `secondary` (bordered), `ghost` (toolbars) or `accent`; a link when given `href`; 48px tall, pill-shaped |
| `IconButton` | An icon-only action, 48 × 48, whose `label` is required |
| `Pill` | Compact metadata and filters, 36px tall, with an optional accent and icon |
| `MediaFrame` | The image or video wrapper that holds an aspect ratio |
| `StatusCallout` | Empty, info, success, warning and error messages: a title, a body and a next step |

Also shared:
- **`FeedbackViewport`:** toasts and the one confirmation dialog, mounted once in the root layout.
- **`.ui-focus-ring`:** the focus style for anything custom-clickable.

Rules:

- One visual hierarchy per card: media, title, summary, action. Don't invent a new card background per feature.
- Panel titles use `sectionTitle` or `cardTitle`, never hero type.
- Every action is reachable by keyboard, with a visible focus ring, including a modal's primary and dismiss actions.
- Minimum control height is 48px for buttons and icon buttons, and 36px for pills and chips in dense rows.

## App Shell And Navigation

`AppShellClient` draws the signed-in chrome:
- a sticky top bar, 4rem (64px at the default text size);
- a side navigation on desktop;
- a drawer plus a bottom bar on small screens.

The destinations, in order (`APP_NAV_ITEMS`), are Home, Feed, Create, Studio, Explore, Search, Marketplace, Workflow Canvas, Alerts, Invite & Earn, and Profile.

- **Names:** they match the mobile app where the surfaces match. Alerts is Alerts on both, and Explore is Explore.
- **Scroll on arrival:** a page opened from the navigation starts at its top, and pressing Home, Explore, Alerts or Profile while it is open scrolls it back to the top. Back and Forward keep the browser's own restoration. The shell keeps no scroll position per tab: a Profile that reopened at its last row read as a page that loaded wrong (owner, 2026-10-18). Next scrolls to the top only when the new page's top is out of view, and a top under the sticky bar counts as in view, so after a forward navigation `AppShellClient` scrolls a page left within one bar's height of the top, with its top under the bar, to the top. A link whose hash names an element lands on it; one whose hash names nothing (the creator page's tab hashes) starts at the top, because Next drops its scroll for it. Not `scroll-padding-top` on the root, which Next's docs suggest: it made every focus in the bar or the drawer scroll the page by half a window.
- **Rewrites:** signed-in `/`, `/feed`, `/showcase` and `/marketplace` are served through rewrites (`next.config.ts`, `src/proxy.ts`), and Next route interception never fires on a rewritten path. An overlay on those pages is a client-side component, not an intercepting route.
- **Layers:** the top bar is z-50 and the bottom navigation z-60, so anything that covers the page sits above 60 and covers them too. A new overlay takes its layer from this scale: the shell's drawer and the app's modals at z-[80]; lightboxes, menus drawn in the page body and a dialog that a modal raises at z-[90]; the confirmation dialog (`.ui-confirm-backdrop`) at 100; the toasts (`.ui-toast-viewport`) at 110. Not every overlay is on the scale yet, so read the neighbours before relying on the order between two of them: the generation-finished notifications (`GenerationNotifications.tsx`) are z-[70], under every modal; the composer's resource card editor (`ResourceCardEditorDialog.tsx`) is z-[85]; the feed's lightbox (`FeedMediaLightbox.tsx`), the workflow library's dialogs (`WorkflowLibraryClient.tsx`) and the reel's loading fallbacks are z-[100]; Explore's notice (`ShowcaseClient.tsx`) is z-[110]; the skip link (z-[120]) and the navigation progress bar (z-[130]) are meant to be above everything. A few older overlays still sit at or under the bottom navigation's layer, which draws over them on a phone: the creator page's profile editor (`ProfileActions.tsx`, z-50), `StudioModelPicker`'s phone sheet (z-50), the composer's phone bar (`NewPostClient.tsx`, z-40) and the post page's phone CTA (`ShowcaseDetailBody.tsx`, z-40). The workflow canvas's dialogs and media preview sat at z-50 until October 2026, so on a phone the bottom navigation was drawn over them and still took taps; at their layers now, the dialogs (80) and the preview and context menu (90) also draw over a generation-finished notification (70), as the app's other z-[80] modals already did.

## Page Patterns

### Home (`/`)

`HomeExperience` is one layout for both variants: the community feed in the centre and a sticky context rail on the right.
- **Signed-out:** `AnonymousHome`, where the rail holds the sign-in card.
- **Signed-in:** `src/app/home/page.tsx`, served on `/` through the rewrite. The rail carries live workspace context: a greeting and the creator's recent generation.

The two must look and behave like one product. A stale session falls back to the signed-out page in place, never through a redirect loop.

### Feed (`/feed`)

- **Lanes:** For you, Recent, Unlocks (`src/lib/post-feed-chips.ts`).
- **The list:** `WindowedFeedList`. A card with live state, such as an open comment composer, stays mounted, so windowing never loses a draft.
- **Coming back:** leaving and returning restores the pages already loaded from a session snapshot rather than refetching page one.
- **Card anatomy** (`FeedPostCard`):
  - the creator line, then the title and body, clamped with a way to expand it;
  - the media cover (the first cover is prioritized as the page's LCP);
  - then the actions: Remix where the post can be remixed, Save (heart), Comments (opens the thread inline, first page loaded at once) and Share;
  - and, at the far end of that row, the post's recipe as a chip, only where it says something the row does not (`getPostFeedRecipeChip`): a paid recipe shows its price, a free one shows "Free recipe" only on a card with no Remix. It opens the post at its recipe. There is no bar under the media for it: the bar repeated the post's title. The app's card follows the same cases (`contracts/feed-recipe-chip-v1.json`).
- **Clicks:** the card itself opens the post. Anything inside it that owns a click is a link or a button, or carries `data-feed-card-inert`. A click on a control's icon is the control's too: it lands on an `<svg>`, which is an `Element` but not an `HTMLElement` (`event-target-narrowing-guard.test.ts` fails a narrowing to `HTMLElement` before `closest()`).
- **Save:** the heart never locks. Every tap flips it and moves the count at once, as the app's Home card does (the app's reel and post page still lock theirs). `useOptimisticPostSave`, which every web heart shares (Explore, the reel, a creator's page, the profile and the post page), sends one request per post at a time from each mounted hook, and after it only the newest tap, if that came meanwhile and still differs.
- **Media:** it opens in `FeedMediaLightbox`.
- **The ⋯ menu** (`ShowcaseFeedbackMenu`): one menu for a feed card, an Explore tile, the reel and a creator's page, with the rows the app carries in the same places.
  - Not interested and Hide @handle, then Report content, Report user and Block user.
  - The first two tune a feed, so they are offered only where there is one: the feed card, the Explore tile and Explore's reel. A creator's page, the reel opened from it and the reel over your saved posts carry the safety rows alone.
  - A row that can never apply is left out: your own post keeps Not interested and nothing else, and a post with no creator account keeps Not interested and Report content. With no row left there is no ⋯ at all: the reel over your own posts, and your own creator page.
  - The three safety rows are asked for, sent and answered one way (`src/lib/feed-safety-actions.ts`). They need an account, so a signed-out viewer is sent to sign in and comes back.
  - What leaves the screen is the surface's to decide. A feed takes a reported post away; a creator's page and your saved posts keep what they list, and say only that it was reported. A block takes the creator's posts off a feed and out of your saved posts, sends you from their page to Explore, and takes their posts out of what Explore and the home feed kept for coming back, and out of Explore's first page, which the server builds for everyone, in its shell and in its grid (`takeBlockedCreatorOffClientFeeds`).
  - On a card, on a tile and on a creator's page the open menu is drawn in the page body, fixed to its button: all three clip what they hold. The reel's menu stays in the reel, which is a layer above the body's menus.

### Explore (`/showcase`)

- **Controls:** a category filter (All posts, Images, Videos) and a sort (For you, Recent, Saved, Remixed, Sales) over a media grid.
- **The reel:** a tile opens the reel viewer (`ShowcaseReelViewer`), which is loaded on demand and warmed ahead of the click. While a confirmation is open above it ("Report content?") the reel leaves the keyboard alone. A creator's page and the profile open the same viewer, and its close button names the page it goes back to (Explore, Creator, Profile), as the shell titles them.
- **The first page is everyone's:** the server builds it without knowing the viewer, so that it can be cached and painted at once, and the viewer's own feed is merged in under the rows already drawn. A signed-in page therefore asks the server which of the posts it drew the viewer's own feed leaves out (`/api/showcase/viewer-exclusions`) and takes those out: a creator with a block between them and the viewer on every lane, and on For you what the viewer hid or marked not interested, as on the server. The answer is kept for the visit (`showcase-client-cache.ts`), so Explore does not draw them again the next time it opens in the tab. What the tab keeps is one viewer's: signing out, or in as someone else, does not reload the page, so a page reads it only for the viewer it was learned for and drops it once someone else, or nobody, is looking. A post open in the reel stays until it is closed.
- **Order:** media comes first, gutters are consistent, and filters show real selected state.

### Post page (`/showcase/[id]`)

- **Contents:** the post (`ShowcaseDetailBody`), its engagement row and actions, the resource bundle panel for unlocks, report (not on the creator's own post; the server refuses a report on your own post too), and the comment thread (`PostComments`).
- **Links in, links out:**
  - Every state keeps a way back (`ShowcaseDetailBackLink`).
  - Shared links render a rich social card and structured data from the cover's poster frame.
  - A `?s=<surface>` parameter marks a visit that came from a share.
- The composer lives at `/post/new` and editing at `/post/[id]/edit`.

### Create (`/create`, `/create-image`, `/create-video`, `/create-motion`, `/create-workflow`)

- **Launchpad (`/create`):** the page title, a short body and the tool pills, then `CreatorToolCard`s with live previews. A card shows what the tool makes, not just a model name.
- **Creator pages:** they share the `CreatorStudio` shell:
  - a header with a quick switch between tools;
  - control cards for the prompt, model and settings, and a run panel with generation status.
- **Notices:** they occupy one slot: a retired or replaced model, reset settings, a remix being restored. A placeholder holds that slot while a remix loads, so the form never looks finished before it is.
- **Tone:** a focused workspace, not a landing page. Accents come from `getAccentClasses`.
- **The workflow builder** (`/create-workflow`) is the node canvas; `docs/plans/workflow_canvas.md` covers it. Its right-click menu opens at the pointer, and on the pointer's other side where it would leave the window, as a native menu does (`placeMenuAtPointer`). Until October 2026 it never showed at all: the editor's selection handler closed it as it opened.

### Studio (`/creations`)

The creator's own generations. From here they:
- open a generation's details (`MediaDetailsPreviewModal`);
- set post visibility;
- publish to Explore (`PublishToShowcaseModal`);
- reach the rest through an overflow menu.

Failed and processing states say what happens next.

### Other signed-in pages

- **Marketplace** (`/marketplace`): the resource bundles creators sell.
- **Search** (`/search`): one unified search, in tabs for Top, Creators, Posts and Recipes.
- **Alerts** (`/notifications`): every alert links to its target (`resolveWebNotificationPath`).
- **Profile** (`/profile`): the owner's card and media hub. The reel over Saved carries the ⋯ menu's safety rows; the reel over your own posts has no ⋯.
- **Blocked users** (`/profile/blocked`, a quiet row under the profile's shortcuts): whom you have blocked, newest first, each with Unblock. It is the one way to take a block back, because a blocked creator is left out of every place that would show them. Unblock asks first, and the row leaves at the answer, not at the server's reply: a refusal draws it again in its place and says why in a toast, and a success says so and lets Explore draw them again. A list that cannot be read says so and never reads as empty.
- **Public profiles** (`/creators/[username]`): Follow (Edit Profile on your own), Share profile, and for anyone but the creator a ⋯ with Report user and Block user, as on the app's creator screen. Their answers are toasts, and a block leaves for Explore.
- **Pricing** (`/pricing`): Razorpay credit packs.
- **Credit history** (`/credits`, `noindex`, from the account menu and the balance on Pricing): every credit in and out, newest first, with signed amounts and Load more, in the words of the app's Credit History screen. A signed-out visitor goes to `/login?returnUrl=/credits`.
- **Invite & Earn** (`/invite`).
- **The operator console** (`/admin`): it lives in the same app under its own shell, `AdminShell`. It uses `Surface` and `Text` like everything else; see `AGENTS.md` for its auth model.

### Marketing pages

- **Feature landings** (`/ai-image-generator`, `/ai-video-generator`, `/ai-motion-transfer`, `/ai-workflow-builder`) use `FeatureLandingPage`:
  - an H1 that states the feature or the literal offer;
  - a CTA pair of shared `Button`s;
  - benefit and step cards on `Surface`;
  - long-form prose.

  Each page names its own steps heading, so the pages don't read as duplicates.
- **Also on the public sheet:** `/models`, `/blog`, `/alternatives` and the legal pages. All are public, so they stay on `globals.css`.

## Avoid Checklist

Do not add these in new UI:

- Arbitrary text, radius or tracking classes (`text-[...]`, `rounded-[...]`, `tracking-[...]`) outside a shared primitive.
- Raw border and surface alphas (`border-white/10`, `bg-white/[0.03]`) outside a shared primitive.
- Raw gradients for buttons or cards, and inline `shadow-[...]` strings.
- One-off CTA, pill and card class bundles.
- Inline SVGs when a Lucide icon exists.
- Hero-scale type inside compact panels or cards.
- A signed-in route's utility on a public route's closure (it belongs in `non-public-utilities.css`). A signed-in state of a public page, such as the deletion form on `/delete-account`, is part of that page and rides on `globals.css`.
- An intercepting route for a page served through a rewrite.

## Migration Rule

When touching a file, move the touched surface onto the shared primitives. Don't attempt a full redesign unless one was asked for; consistency should improve incrementally without changing product behaviour. Check keyboard reach, focus, reduced motion and a narrow viewport before calling a change done.
