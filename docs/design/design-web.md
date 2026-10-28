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
- **Creator pages:** `src/components/CreatorColumn.tsx` (the column, its bar and settings, the result canvas) for the image, video and motion creators, and `src/components/CreatorStudio.tsx` for the launchpad's cards and the notices, previews and statuses they share.
- **Marketing pages:** `src/components/FeatureLandingPage.tsx`.
- **Feed:** `src/app/feed/` (`FeedClient`, `WindowedFeedList`, `FeedPostCard`, `FeedMediaLightbox`) and `src/components/PostComments.tsx`.

## CSS Split

- `globals.css` is the stylesheet for every route a signed-out visitor can land on: marketing, blog, models, the post, creator and referral landings, templates, login and auth, and the policy pages (terms, privacy, child safety, cancellation, account deletion).
- Signed-in surfaces add `non-public-utilities.css` through their route layouts. Alerts, the shell's tab on every page, draws its sign-in card on `globals.css`; its signed-in half links the supplement itself and loads with `import()` once a reader is known. The supplement stays in the document after a client navigation, so a public page opened from a signed-in route is drawn with it too: it scans the whole app folder and every component, the public ones included, and holds every utility `globals.css` holds.
- CSS is inlined per response (`experimental.inlineCss`), so a public route must never import the supplement.
- `src/__tests__/route-style-readiness.test.ts` lists every route folder as public or signed-in, pins which directories link which sheet, and holds `globals.css` to the exact closure of the public routes: their components, and any file of a signed-in folder that a public page draws, such as the profile editor on a creator's own page; `route-style-two-sheet-order.test.ts` holds the supplement to every utility rule of `globals.css`.
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
- **The top bar:** the sticky app-shell top bar is exactly its token, border included: `--app-shell-topbar-height`, 4rem, 64px at the default text size (its `min-height` with no vertical padding, so its controls centre in it rather than grow it). A larger browser text size grows its 3rem controls, and the token in rem grows with them; at a fixed 64px the bar grew past its token instead (73-75px at 24px text), and every page sized from the token scrolled 9-11px (until October 2026). Anything else pinned below it offsets by that variable or in rem, never a pixel figure such as `top-[72px]`. Its controls on the right keep their size and the search field gives way; below 1024px the field folds into its search button and Create into a 48px icon (`.app-shell-search` and `.app-shell-create` in `globals.css`). A page that opens with a heading of its own gets no title in the bar (`getAppShellTitle` returns null for it, in `app-shell-nav.ts`): the bar used to say "Studio" over a page headed "Studio".
- **The Create menu:** the top bar's Create and, below 768px, the bottom navigation's centre + open one menu with the app's two choices in the app's words (`AppShellCreateMenu.tsx`, `CREATE_MENU_ITEMS` in `app-shell-nav.ts`, held to `ugc-mobile/lib/create-menu-view-model.ts` by `create-menu-parity.test.ts`): Create (Image, Video, and Motion), which opens `/create`, and Post (Share finished media), which opens the composer with a Back to the page it was started on where the composer knows that page (on the composer itself, Post only closes the menu). It is a native popover, so the browser closes it on Escape or a click outside. The focus goes in, onto the first choice, as it opens and back to its button as it closes, and while it is open the keys are its own, kept from the page beneath: the workflow canvas cancels an Escape to clear its selection, and a cancelled Escape does not close a popover. It hangs under the top bar's button (anchor positioning, with the bar's right edge as the fallback); on a phone it stands above the bottom navigation over a scrim of its own, an element, because a popover's `::backdrop` takes no taps and lets them through to the page. A browser without popovers gets the same menu drawn by the component. A post starts there, not from buttons of each page's own: Explore, Marketplace, Studio and the profile had one each, under five names. An empty list's own "Share the first post" stays.
- **Side navigation:** places only, Home, Explore and Marketplace, then Studio and Workflow Canvas under Create, then Profile. Search, Alerts, Create and Invite & Earn are the top bar's (its field, its bell, its Create menu, the account menu) and are not named a second time. The balance is the top bar's alone, at every width (a phone reads the number by itself).
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
- **Confirmations:** ask with `requestConfirmation` from `feedback-state`, or in a component with `useConfirmation`, whose question is answered "cancel" and taken down when the component goes, or when its `scope` changes (the creator page's editor passes whether it is open, so a save that closes it also closes its discard question). Never the browser's own `confirm`, `alert` or `prompt`: they are unstyled, titled with the site's address and block the page, and ESLint's `no-alert` fails on one in `src/`. The dialog is a sheet along the bottom edge below 40rem, its actions full width with the confirming one on top, and a centred card from 40rem; it enters with a fade and a rise (`ui-rise`, the sheet slides up) and leaves at once, so the chosen action starts without a wait. Its actions are `.ui-button` primitives: Cancel `.ui-button-secondary`, the confirming action `.ui-button-primary`, or `.ui-button-danger` with a warning mark for a step that cannot be taken back (`tone: 'danger'`). Cancel takes the focus. While it is up it takes every key (a capture-phase listener on the window that stops each one), so no modal beneath it hears its Escape or Tab, and it answers "cancel" by itself when Back leaves the address it was asked at, so an unlock or a block is never confirmed for a page that is gone. It is drawn as a child of `<body>` added when it opens, so a modal that made the rest of the page inert (the composer's resource editor) cannot make it inert too.
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

The destinations, in order (`APP_NAV_ITEMS`), are Home, Create, Studio, Explore, Search, Marketplace, Workflow Canvas, Alerts, Invite & Earn, and Profile; the side navigation draws the places among them (`NAV_GROUPS` in `AppShellClient.tsx`), and the top bar the rest.

- **Names:** they match the mobile app where the surfaces match. Alerts is Alerts on both, and Explore is Explore.
- **Scroll on arrival:** a page opened from the navigation starts at its top, and pressing Home, Explore, Alerts or Profile while it is open scrolls it back to the top. Back and Forward keep the browser's own restoration. The shell keeps no scroll position per tab: a Profile that reopened at its last row read as a page that loaded wrong (owner, 2026-10-18). Next scrolls to the top only when the new page's top is out of view, and a top under the sticky bar counts as in view, so after a forward navigation `AppShellClient` scrolls a page left within one bar's height of the top, with its top under the bar, to the top. A link whose hash names an element lands on it; one whose hash names nothing (the creator page's tab hashes) starts at the top, because Next drops its scroll for it. Not `scroll-padding-top` on the root, which Next's docs suggest: it made every focus in the bar or the drawer scroll the page by half a window.
- **Rewrites:** signed-in `/` is served through a rewrite to `/home` (`src/proxy.ts`; `/showcase` and `/marketplace` are ordinary routes, and `/feed` a page that redirects to `/`), and Next route interception never fires on a rewritten path. An overlay on Home is a client-side component, not an intercepting route.
- **Layers:** the top bar is z-50 and the bottom navigation z-60, so anything that covers the page sits above 60 and covers them too. A new overlay takes its layer from this scale: the shell's drawer and the app's modals at z-[80]; lightboxes, menus drawn in the page body and a dialog that a modal raises at z-[90]; the confirmation dialog (`.ui-confirm-backdrop`) at 100; the toasts (`.ui-toast-viewport`) at 110. The shell's Create menu is a popover, drawn in the top layer over all of them (at z-[90] in a browser without popovers), so a question that comes up while it is open puts it away first (`useModalQuestion.ts`). Not every overlay is on the scale yet, so read the neighbours before relying on the order between two of them: the generation-finished notifications (`GenerationNotifications.tsx`) are z-[70], under every modal; the composer's resource card editor (`ResourceCardEditorDialog.tsx`) is z-[85]; the feed's lightbox (`FeedMediaLightbox.tsx`), the workflow library's dialogs (`WorkflowLibraryClient.tsx`) and the reel's loading fallbacks are z-[100]; Explore's notice (`ShowcaseClient.tsx`, along the bottom edge) is z-[95], over the reel and under a confirmation, whose sheet on a phone shares that edge (it was z-[110] and covered the sheet's Cancel until October 2026); the skip link (z-[120]) and the navigation progress bar (z-[130]) are meant to be above everything. Something that stays along the bottom edge on a phone rather than covering the page sits above the bottom navigation instead: its bottom offset adds `--app-shell-bottom-nav-space` (`bottom-[calc(var(--app-shell-bottom-nav-space,0px)+1rem)]`, 0px from 768px), and the page keeps room at its end for it to scroll clear of. The canvas's node library opener, the composer's phone bar (`NewPostClient.tsx`), the post page's unlock CTA (`ShowcaseDetailBody.tsx`) and `StudioModelPicker`'s phone sheet do; the last three sat at z-40 and z-50 until October 2026, where the bottom navigation was drawn over them and took their taps (a phone could not save or publish a post), and a card's menu drawn in the page body (`ShowcaseFeedInteraction.tsx`) was z-50 and lost its last row there. `bottom-nav-overlay-layers.test.ts` holds every `fixed` class list of the web app (each branch of a ternary on its own) to one of the two, to taking no pointer or to being hidden below 768px, outside the routes the shell draws without the navigation and one dialog inside another overlay's layer, and every fixed rule of the two sheets to a layer of 70 or more. The workflow canvas's dialogs and media preview, and the creator page's profile editor (`ProfileActions.tsx`), sat at z-50 until October 2026, so on a phone the bottom navigation was drawn over them and still took taps; at their layers now, the dialogs and the profile editor (80) and the preview and context menu (90) also draw over a generation-finished notification (70), as the app's other z-[80] modals already did.

## Page Patterns

### Home (`/`)

`HomeExperience` is one layout for both variants: the community feed in the centre and a sticky context rail on the right. The column opens with the "Make this" shelf (`HomeShelf.tsx`, `src/lib/home-shelf.ts`): pinned creations that open their remix, three cards and a sliver of the fourth on a laptop, two on a phone, arrows for a mouse, no timer. The first clip card in view plays a muted preview, on a phone as with a mouse, registered with the page's one-clip rule (`useInlineMediaPlayback`: as between the feed's cards, the clip that starts last pauses the rest, and once it stops the last autoplaying clip it paused that is still in view plays again, so the feed's first clip comes back when the shelf scrolls away), never under Reduce Motion or Save-Data. A member also gets at most two offers (Post or Earn third, Invite last); the signed-out page offers none and marks what fits the welcome credits "Free to try". The pins live in `src/lib/home-shelf-lineup.ts`; fewer than three qualifying pins renders no shelf, and while enough are pinned the signed-in page holds the row's place as it streams. The words are `src/lib/home-shelf-copy.ts`, held with the app's to `contracts/mobile-api-v1.json`.
- **Signed-out:** `AnonymousHome`, where the rail holds the sign-in card.
- **Signed-in:** `src/app/home/page.tsx`, served on `/` through the rewrite. The rail carries live workspace context: the creator's recent generations.

The two must look and behave like one product. A stale session falls back to the signed-out page in place, never through a redirect loop.

### Feed (Home's lanes)

- **Where:** Home's column, signed in and signed out (`FeedClient`). `/feed`, the same feed on a page of its own that nothing linked to, sends its visitors to Home on the lane it named (`?chip=`).
- **Lanes:** For you, Notes, Recent, Recipes (`src/lib/post-feed-chips.ts`), as the app names them; Studio's "Unlocked recipes" tab is what the viewer bought.
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
  - On a card, on a tile and on a creator's page the open menu is drawn in the page body, fixed to its button: all three clip what they hold. The reel's menu stays in the reel. The reel and the body's menus share layer 90 (a body menu needs a layer above the bottom navigation's 60), and a body menu closes at any press outside it.

### Explore (`/showcase`)

- **Controls:** a category filter (All posts, Images, Videos) and a sort (For you, Recent, Saved, Remixed, Sales) over a media grid.
- **The reel:** a tile opens the reel viewer (`ShowcaseReelViewer`), which is loaded on demand and warmed ahead of the click. While a confirmation is open above it ("Report content?") the reel leaves the keyboard alone. A creator's page and the profile open the same viewer, and its close button names the page it goes back to (Explore, Creator, Profile), as the shell titles them.
- **The first page is everyone's:** the server builds it without knowing the viewer, so that it can be cached and painted at once, and the viewer's own feed is merged in under the rows already drawn. A signed-in page therefore asks the server which of the posts it drew the viewer's own feed leaves out (`/api/showcase/viewer-exclusions`) and takes those out: a creator with a block between them and the viewer on every lane, and on For you what the viewer hid or marked not interested, as on the server. The answer is kept for the visit (`showcase-client-cache.ts`), so Explore does not draw them again the next time it opens in the tab. What the tab keeps is one viewer's: signing out, or in as someone else, does not reload the page, so a page reads it only for the viewer it was learned for and drops it once someone else, or nobody, is looking. A post open in the reel stays until it is closed.
- **Order:** media comes first, gutters are consistent, and filters show real selected state.

### Post page (`/showcase/[id]`)

- **Contents:** the post (`ShowcaseDetailBody`), its engagement row and actions, the recipe panel (`PostResourceBundlePanel`, before the comments; "Unlocked" / "Your recipe" / the price in credits on its badge, "Remix included" when the post's Remix comes with it, "Recipe unlocked" with an "Unlocked recipes" link after an unlock, items in the creator's order with settings as keys and values), report (not on the creator's own post; the server refuses a report on your own post too), and the comment thread (`PostComments`).
- **Links in, links out:**
  - Every state keeps a way back (`ShowcaseDetailBackLink`).
  - Shared links render a rich social card and structured data from the cover's poster frame.
  - A `?s=<surface>` parameter marks a visit that came from a share.
- The composer lives at `/post/new` and editing at `/post/[id]/edit`. Its Recipe section offers Free, Paid and No recipe as one choice of three cards (`RecipeAccessCards.tsx`: the app's choice, drawn here as native radios in labels, the chosen one in its accent's `selected` classes, three columns once the group itself is wide enough), so a creator sees that a recipe can be sold before choosing anything; Paid opens the price field under them. The recipe speaks the glossary of the recipe audit (2026-10-27): the whole is a recipe, one entry an item, money is credits. Under the cards, top to bottom:
  - **Price** (Paid only): "Price in credits", and under it the one money line, "Buyers pay $9.00 · You earn ~$7.65 (85%) · Payouts from $100" (`formatRecipeMoneyLine`, `src/lib/recipe-money-line.ts`, also under the quick publish window's price), then "Before buying, people see your recipe preview and item titles — never what's inside."
  - **From this creation** (a post made from a creation, not a template result): "Include exact prompt" adds the item "Exact generation prompt", as the app does; "Include creation references" (a new post only) shows in the list as a read-only row, "Creation references · N files", and counts as the recipe's item.
  - **What people receive**: the items, "Add item" and "Add your first item"; on a creation post the line "Remix comes with this recipe: people who unlock it can remix your post." There is no remix switch: the server gates a creation post's Remix at its recipe's unlock. A recipe people already have stays editable, with "N people have this recipe. They keep the version they got and see your changes." over its items. Removing the last item keeps the recipe chosen, and Publish asks for an item.
  - **Recipe preview** (required, 180, "Everyone sees this before unlocking."): the one public text, sent as the preview and copied into the summary. It is suggested from the items ("Includes the prompt, reference media and the model settings.", `getSuggestedRecipePreview`, the app's sentence too) and follows them while it still says what was suggested or nothing; what the creator writes stays. The listing rule's preview half speaks under it.
  - **The item picker and editor** (`ResourceCardEditorDialog.tsx`): "Add an item" lists Prompt or script, Reference media, Model settings and Guide or notes, then "More types" (a disclosure) for the other five, each type with an icon of its own. The editor's fields are "Item title" ("Everyone sees this before unlocking."), "Note shown after unlock" and the content; a field's error waits until the field was touched, and until then a plain line beside the disabled "Save item" says what it needs.
  - **Leaving with a recipe off**: an edit's save that takes a stored recipe off asks first with `useConfirmation` ("Remove this recipe?", "Its N items and files will be deleted." and, when people have it, "The N people who have it keep their copy; it comes off sale.", "Remove recipe" / "Keep recipe").
  - **From Studio**: "Add recipe" opens the post headed "Add a recipe to this post", no mode chosen and nothing focused; "Manage recipe" opens at the recipe's mode with its price focused.

### Create (`/create`, `/create-image`, `/create-video`, `/create-motion`, `/create-workflow`)

- **Launchpad (`/create`):** the page title, a short body and the tool pills, then `CreatorToolCard`s with live previews. A card shows what the tool makes, not just a model name.
- **Image, video and motion creators (`/create-image`, `/create-video`, `/create-motion`):** the app's composer as a column (`src/components/CreatorColumn.tsx`), with the result beside it. The image creator is described here; video and motion follow it, with the differences listed after:
  - the column, top to bottom: Image, Video and Motion as tabs, the open one underlined in its tool's accent; the model chip, which opens the model picker under it (the balance is the top bar's, at every width); the prompt; Templates and Enhance as two tiles, with Enhance's level under them; the reference images as rows (picture, name, and the whole @handle beside Insert), under a line saying that @ in the prompt uses one by its name;
  - at the column's foot a bar that stays in reach while the column scrolls (above the bottom navigation on a phone): a chip that reads the run's settings back ("1K · AUTO · JPG") and opens them in a panel above it, and Generate with its price ("Generate · 8 credits"; until there is a price its face says why it waits). What stops a run (a refusal, a limit, the balance, a start not confirmed) is said in the bar, over its buttons. A setting with one value (ratio, resolution, quality) is a radio group: one tab stop, the arrow keys move the choice. The panel takes the focus when it opens and comes after the bar in the tab order; it closes on Escape inside it, when the focus leaves it, and at a press anywhere but itself and its chip, Generate included; its height is what the window has between the top bar and the bar, so a short phone never puts its first rows under the top bar;
  - the result canvas: beside the column from 1120px, where the sidebar leaves the page about 860px, it stays in view for the whole page; below that it follows the column, and a run the creator starts brings it into view once the start is confirmed (a refusal stays in the bar, in view; a run picked up again on load leaves the page where it is). Empty, it is a frame in the run's aspect ratio, drawn no narrower than 0.45 and no wider than 2.4 (the models offer 1:8 and 8:1); running, the same frame in the shape the run was started with, its progress under it; done, the picture with Publish & share, Download and Start another run under it;
  - no title card and no run summary: the top bar says "Create" and the Image tab marks the page, so the page's own heading is for screen readers only.
- **Signed out (owner, 2026-10-28):**
  - **What a visitor can do.** The three creators work without an account up to Generate:
    - prices are quoted without a token;
    - the draft and its pictures are saved in the browser for the visitor, as an account's are;
    - the canvas has no Studio link.
  - **Generate.** It reads "Sign up to generate", with what a new account starts with and what the run takes in a line under the bar. It checks the form as Generate does, then opens the sign-up sheet (`CreatorSignUpSheet.tsx`):
    - what stays: the prompt, the settings, the pictures;
    - Continue with Google, and email sign-in for the older password accounts;
    - nothing runs until Generate is pressed again.
  - **Other presses that need an account.** Enhance and preparing a Seedance reference open the same sheet. A remix link still signs in first, because remixing someone's post takes an account.
  - **Handing the draft over.** Leaving for sign-in marks the draft for the account (`creator-visitor-draft.ts`). The first creator page of that tool opened signed in within the hour moves it over.
  - **Coming back.** A sign-up started at a creator returns straight to it (`resolvePostAuthPath` adds `?welcome=1`), not to profile setup and the welcome page.
  - **The welcome card.** The creator's welcome card (`CreatorWelcomeCard.tsx`) asks a new account for its name and handle, filled in from the sign-in. One press saves them and adds the welcome credits, because the claim refuses an account without both.
- **Video creator, where it differs:** single shot and multi-shot are a radio group under the model chip, as the app's segmented control; multi-shot puts a card per shot (its prompt, its own Enhance, its length) in place of the prompt and the Templates and Enhance tiles. The inputs follow the prompt as cards: frames (start and end side by side), reusable image references and Kling video elements as rows like the image creator's (name, @handle, Insert, and Copy for a clip; Insert and Copy are named for the handle they act on), named subjects (each with its own Insert), clips and tracks, prepared Omni IDs, Seedance assets, and the standby card for what the model cannot take. Frames and references that a model will not take together lock each other: the locked card is greyed and its file fields are switched off, so the keyboard cannot attach into it either. A model that always makes sound says so in the column, under the prompt. The empty canvas asks for what the run needs: frames or references, each shot, the subjects, or Hailuo 2.3's start frame until it has one. The chip reads the resolution (or the mode that names one), the ratio and the run's length, "720P · 16:9 · 5s", in the app's words from the module both share (`ugc-mobile/lib/creator-settings-summary/`); its panel holds the mode (named as the model's catalog entry names it, "Grok mode"), the duration (a slider, choices or the fixed length; in multi-shot each shot sets its own), resolution, ratio, and Fixed lens and AI sound effects as switches. The finished clip plays once, in a box that takes the clip's own shape once it loads (square until then, as its frame was), with the prompt the run was sent with under it.
- **Motion creator, where it differs:** a "Required inputs" card with the character image and the reference video side by side ("Who should move?", "How should they move?"), the clip's length and its limit under them; the prompt is optional. The chip reads the quality and the clip's length in whole seconds, "720P · 8s", or "720P · Add motion" while the page holds no clip (a run picked up on load brings its length but not its clip); its panel holds the character orientation (Follow video or Favor image) and the quality mode. Its frame is square until the clip arrives, since the page does not measure the reference's shape.
- **Notices:** they occupy one slot: a retired or replaced model, reset settings, a remix being restored. A placeholder holds that slot while a remix loads, so the form never looks finished before it is.
- **Shared pieces:** the bar's action (Check again, Top Up Credits, Generate and its price; a run under way keeps Generate's place, spinning, even when what it left is short of the next run), the lines over it, the reference rows, the add tiles, the upload slots, the "@" panel and the result's actions are `CreatorColumn.tsx`'s, one copy for the three creators.
- **Tone:** a focused workspace, not a landing page. Accents come from `getAccentClasses`.
- **The workflow builder** (`/create-workflow`) is the node canvas; `docs/plans/workflow_canvas.md` covers it. Its right-click menu opens at the pointer, and on the pointer's other side where it would leave the window, as a native menu does (`placeMenuAtPointer`). Until October 2026 it never showed at all: the editor's selection handler closed it as it opened.

### Studio (`/creations`)

The creator's own generations. From here they:
- open a generation's details (`MediaDetailsPreviewModal`);
- set post visibility;
- publish to Explore (`PublishToShowcaseModal`): its recipe box is "Recipe" with No recipe, Free and Paid, packed from the creation's saved setup (its saved inputs included, decision D5 of the recipe audit); Paid's price is in credits with the composer's money line under it;
- reach the rest through an overflow menu.

Failed and processing states say what happens next.

### Other signed-in pages

- **Marketplace** (`/marketplace`): the recipes creators sell; badges price them in credits, as every other chip does.
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
