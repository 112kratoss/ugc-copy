# Magicbooklet Mobile Design System

Audience: designers, engineers, and AI agents working in the Expo/React Native app at `ugc-mobile/**`.

Read this before editing mobile UI. It covers what each token, primitive and screen pattern is for, and which rules the tests enforce. The values themselves live in code (`lib/theme.ts`, `components/ui.tsx`), and code wins wherever the two disagree.

Rewritten against the code on 2026-09-24 (app 0.1.6). The reasoning behind the original rules is in [ui-consistency-research-2026-06-14.md](./ui-consistency-research-2026-06-14.md). Most of what follows was shaped by the HIG audit recorded in [docs/archive/hig-alignment-2026-08-27.md](../archive/hig-alignment-2026-08-27.md).

## Purpose

Magicbooklet mobile should feel like a premium AI creator studio in your pocket, in the phone's own light or dark appearance: fast, media-led, touch-friendly, polished, and calm enough that creators can move from idea to output without fighting the interface.

The app can be visually rich, but the system underneath must be strict. Addictive and beautiful mobile apps work because they repeat familiar patterns: predictable tabs, consistent typography, obvious primary actions, clear progress, rewarding results, and low-friction recovery.

## References

- **Apple's Human Interface Guidelines come first.** Mobile UI is held to them, and the numeric floors are tests (see [What the tests enforce](#what-the-tests-enforce)).
  - The HIG pages are client-rendered.
  - The full text of any chapter is JSON at `developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`.
- **Look for a native API before building a behaviour** (`AGENTS.md`). Examples:
  - UIKit's zoom transition opens the reel on iOS.
  - The platform's own sheets, pickers and haptics come before anything drawn in JavaScript.
- [Material Design 3](https://m3.material.io/): Android conventions and the 48dp touch rhythm.
- [Pinterest Gestalt](https://gestalt.pinterest.systems/): media-led surfaces stay consistent through shared components, tokens and language.
- [CapCut](https://www.capcut.com/): creator tools packaged as quick starts and obvious entry points.
- Habit-forming apps such as Instagram, TikTok, Duolingo and Calm: clear reward loops, immediate feedback and repeatable navigation. Never their dark patterns, anxiety loops, or gesture-only controls.

## Product North Star

The first impression should say:

- "This is a serious creator tool."
- "I can make something quickly."
- "My work, credits, and next action are obvious."
- "The app looks cinematic, but it will not surprise me."

Every screen should support one of these jobs:

- Start creating.
- Review or continue a generation.
- Browse, save and discuss community work.
- Publish or unlock creator resources.
- Manage profile, credits, and settings.

If a surface does not support one of these jobs, it should be simplified or moved deeper.

## Design Language

### Personality

Use this tone:

- Premium and cinematic: obsidian on dark, warm paper on light. The reel stays dark in both.
- Confident rather than loud.
- Media-first rather than form-first.
- Friendly enough for first-time creators.
- Tool-like enough for repeat users.

Avoid:

- Random neon decoration.
- Marketing hero sections before useful actions.
- Tiny labels that make controls feel mysterious.
- Too many competing gradients.
- Screens where every card wants to be the hero.

### Visual Model

Use a layered studio model:

1. Background: the app canvas, true black or warm paper.
2. Panels: a real step away from the canvas, lighter on dark and a tinted fill on paper.
3. Cards: repeatable work units with media, title, metadata and action.
4. Accents: the tool colours (image, video, motion, workflow, commerce) and coral.
5. Primary actions: high-contrast, easy to reach, stable wording.

Gradients are for the primary create moment, tool identity, media placeholders, and the shades that protect text over pictures. They are never a substitute for hierarchy.

## Source Files

Use the shared layers before writing anything local:

- **Tokens:** `lib/theme.ts`, which holds both palettes and the static tokens.
  - Read it through `useAppTheme()` in `lib/theme-context.tsx`.
  - The scheme is resolved in `lib/appearance.ts`.
- **Primitives:** `components/ui.tsx`.
- **Motion:** `lib/motion.ts` (`MotionView`, `usePressMotion`, `useReducedMotion`, `useOverlayPresence`).
- **Haptics:** `lib/haptics.ts`.
- **Geometry:** `lib/hit-target.ts` for touch reach, `lib/safe-area.ts` for insets, `lib/tab-bar-layout.ts` for the dock's metrics.
- **Chrome:** `components/magic-tab-bar.tsx` (the dock), `magic-create-menu.tsx`, `home-side-menu.tsx`, `top-scrim.tsx`.
- **Overlays:** `components/overlay-host.tsx`, `action-sheet.tsx`, `dialog.tsx`, `sheet-chrome.tsx`.
- **Feeds and media:**
  - `components/feed-card-shell.tsx`, `home-feed-card.tsx`, `reel-chrome.tsx`;
  - `media-zoom.tsx` with `lib/apple-zoom.ts`;
  - `letterbox-bands.tsx`, `skeleton.tsx`, `reveal.tsx`, `save-heart.tsx`.

When touching a mobile screen, move the touched surface onto these shared files. Do not invent a local style system.

## What the tests enforce

The guards below fail the mobile suite, so a red guard is a real violation: fix the control, never the threshold. Adopting a further HIG rule means extending a guard, so every later screen inherits it.

| Test | Holds |
| --- | --- |
| `hig-type-and-contrast.test.ts` | 11pt minimum type, 4.5:1 contrast for text on every panel in both schemes, 44pt hit regions, no `fontWeight` on a display variant |
| `hig-dynamic-type.test.tsx` | Text always follows the OS text size, within each tier's cap |
| `hig-icon-size.test.ts`, `hig-icon-weight.test.tsx` | Icon sizes come from the ramp; one stroke weight app-wide |
| `theme-color-literals.test.ts` | No raw colour outside the `EXEMPT` list |
| `theme-palette-parity.test.ts` | The light and dark palettes carry the same names |
| `motion-token-compliance.test.ts` | Press opacity and springs come from the theme; every timing names its easing |
| `hig-vocabulary.test.ts` | Haptics go through `lib/haptics.ts`; ellipses are the `…` character |
| `feed-render-cost.test.ts` | The drawing rules in [Feeds and the reel](#feeds-and-the-reel) |
| `bundle-shaping.test.ts` | Icons and fonts imported one module at a time |
| `hig-<surface>.test.ts(x)` | The fixes each surface's audit made: home, collections, profile, post composer, post details, alerts, auth, onboarding, navigation chrome, modality, full screen, branding, create hub, generative creation, edit profile |

## Tokens

`lib/theme.ts` is the single source of truth, in two layers:

- **Scheme tokens** (`colors`, `semantic`, `state`, `shadow`, `dim`, `tabBar`):
  - They exist once per scheme and are read through `useAppTheme()` (`lib/theme-context.tsx`).
  - Never read a colour from a module constant. React Compiler memoises it for the life of the process, so it would not redraw on a scheme switch. `appTheme` carries no colours at all.
- **Static tokens** (`radii`, `spacing`, `type`, `typeScale`, `icon`, `touch`, `opacity`, `motion`) are the same in both schemes and read from `appTheme` anywhere, module scope included.

### Color

The app follows the phone's appearance, and Settings → Appearance can hold System, Light or Dark (`lib/appearance.ts`). Both palettes carry exactly the same names; `theme-palette-parity.test.ts` holds them in step and `hig-type-and-contrast.test.ts` sweeps both for 4.5:1.

Core (dark · light):

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `app` | `#000000` | `#fdfbf8` | Root ground |
| `background` / `page` | `#070708` | `#fbf8f4` | Screen background |
| `panel` | `#151518` | `#f2ede6` | Cards and sheets |
| `panelSoft` | `#1f1f24` | `#ece6de` | A step further from the page |
| `surface` / `surfaceStrong` | ivory 6% / 10% | ink 4% / 7% | Soft raised fills, chips |
| `surfaceInset` | `#0b0b0d` | `#ffffff` | Inputs, wells, segmented-control tracks |
| `surfaceInverse` + `textInverse` | ivory + ink | ink + ivory | The inverted pill |
| `border*` | ivory 7 / 12 / 22% | ink 7 / 12 / 22% | Hairlines |
| `text` · `textSecondary` · `muted` · `faint` | `#fff8ed` · `#ddd6cc` · `#aaa39b` · `#8d8780` | `#1c140f` · `#3f3731` · `#5f5750` · `#675e56` | Type ramp |
| `mediaPlaceholder` | `#050506` | `#ece6de` | The ground a picture loads onto |
| `scrim` | black 58% | ink 32% | Behind a bottom sheet |

**Coral** comes in two tokens:
- `primary` is coral as a foreground: text, icons, borders and thin marks such as progress bars, dots and underlines. It is `#ff7a59` on dark and `#a83d1c` on light.
- `primaryFill` is coral as a surface: buttons and the selected segment. It is bright `#ff7a59` in both schemes, always with `onPrimary` ink (`#1a0d08`, 7.4:1). `primaryFillPressed` is its pressed step.
- They are separate because the bright coral is only 2.4:1 as text on paper.

**Tool accents** (`image`, `video`, `motion`, `workflow`, `amber`/`commerce`) and **semantic tones** (`info`, `success`, `warning`, `danger`) follow the same split: pastel on dark, deep on light, for text and marks.
- A *solid* accent fill uses `accentFill(accent)` with `onAccentFill(accent)`, the bright set, in both schemes.
- A wash is the scheme's accent at low alpha: `hexWithAlpha(theme.colors.image, 0.12)`.

**Over pictures**, text, icons, scrims and chips drawn on a photo or video frame use `mediaColors` (`onMedia`, `mediaScrim`, `mediaChip`, `mediaGround`…). They are identical in both schemes, because the picture decides what sits on it. A component drawn entirely over a picture (a grid tile's state chip, an Explore pin) takes `themes.dark` outright.

**Surfaces that stay dark in both schemes** are the reel (`app/viewer.tsx`), the zoom flight, the media lightbox and onboarding.
- Each is wrapped in `<ThemeScope scheme="dark">`, with a light-content status bar while in front.
- Sheets the reel opens (actions, comments, unlock) return to the app's scheme through `AppSchemeScope`.

Rules:

- Colours come from `useAppTheme()`, `mediaColors`, or `accentFill`. A raw colour literal fails `theme-color-literals.test.ts` unless its file is listed in that test's `EXEMPT` map, with the reason the colour is the point.
- Elevation in light mode is a fill step plus a hairline, never a new shadow. A shadow on scrolled content costs iOS an offscreen pass every frame. The shadow tokens keep the same shapes in both schemes, at a third of the weight on paper.
- Use one accent per screen section unless the screen is a launcher.
- Never place muted text on low-contrast gradients.

### Typography

Two faces:

- **Display: Bricolage Grotesque**, loaded from the bundle in the root layout, weights 700 and 800 only.
  - It carries the titles, the numbers and the wordmark (`BrandLockup`).
  - Until it loads, the splash screen stays up, so the first screen never swaps fonts in view.
- **Everything else: the system font** (San Francisco, Roboto), so running text, labels and buttons match the OS and scale with it.

Roles (`appTheme.type`):

| Role | Size / line | Face | Use |
| --- | --- | --- | --- |
| `display` | 36 / 42 | Bricolage 800, tracking −0.6 | Rare hero moments: the welcome screen, a large empty state |
| `pageTitle` | 30 / 36 | Bricolage 800, −0.3 | Screen title, once per screen |
| `sectionTitle` | 22 / 28 | Bricolage 800, −0.1 | Grouped content |
| `cardTitle` | 18 / 24 | Bricolage 700 | Cards and panels |
| `metric` | 34 / 40 | Bricolage 800, −0.3 | Balances and stats |
| `body` | 16 / 24 | System 400 | Running text |
| `bodySm` | 14 / 21 | System 400 | Compact explanatory copy |
| `label` | 13 / 18 | System 700 | Form labels, small controls |
| `button` | 15 / 20 | System 700 | Buttons |
| `caption` | 12 / 17 | System 600 | Metadata only |

Rules:

- Use `AppText` with a variant rather than restyling type inline.
- **Never give a display variant a `fontWeight`.** Each display role names its weight through the font file and sets `fontWeight: '400'`. Asked for another weight, iOS ignores it but Android drops the face altogether and draws the system font.
- **Dynamic Type is always on**, capped per tier (`appTheme.typeScale`):
  - titles and metrics follow the OS setting up to 1.35×;
  - controls and metadata up to 1.6×;
  - running text up to 2×.
  `AppText` applies its variant's cap; opting out fails `hig-dynamic-type.test.tsx`.
- **Headers:** `display` and `pageTitle` are announced as headers automatically. Pass `heading` for any other heading.
- **Truncated text isn't selectable.** Text with `numberOfLines` stops being selectable, because Android draws selectable text past its truncation.
- **Letter spacing and case:**
  - The tracking on the display roles belongs to the face; don't add letter spacing anywhere else.
  - Use sentence case. All caps is only for a one-to-three-word `Kicker`.
- **Adding a font:** import each weight from its own module (`@expo-google-fonts/<family>/<weight>`) and take `useFonts` from `expo-font`. Every font the bundle requires ships inside the app binary.

### Spacing

A 4pt base with an 8pt rhythm, named by role (`appTheme.spacing`):

| Token | Value | Use |
| --- | --- | --- |
| `unit` | 4 | The base step |
| `compact` | 8 | Tight icon/text gap |
| `gap` | 12 | Default gap inside a component |
| `screen` | 16 | Screen horizontal padding |
| `card` | 16 | Card padding |
| `panel` | 20 | Large panel padding |
| `section` | 32 | Between sections (`Screen` applies it) |
| `page` | 48 | Large vertical separation |

Rules:

- No arbitrary values such as `gap: 13`, `padding: 19` or a new 18pt screen margin.
- Scroll padding goes in `contentContainerStyle`.
- Tab roots reserve the dock's height from `getMagicTabBarMetrics` (`Screen insideTab` does it).

### Radius

| Token | Value | Use |
| --- | --- | --- |
| `xs` | 8 | Tiny tags, thumbnails |
| `sm` | 12 | Compact controls |
| `md` | 16 | Inputs, buttons, small cards |
| `lg` | 20 | Feed and standard cards |
| `xl` | 24 | Panels, media cards, the top corners of sheets |
| `pill` | 999 | Pills, chips, round buttons |

Use `borderCurve: 'continuous'` on rounded rectangles, and nothing off this scale unless a component owns the value.

### Elevation

Dark surfaces separate by fill and hairline first. `theme.shadow` holds shadows by role (`panel`, `floating`, `sheet`, `drawer`, `dock` for surfaces that float over content), and they are drawn at a third of the weight on paper.

Rules:

- **No box shadow on anything that scrolls.** iOS renders it with an offscreen pass every frame. Feed cards are flat.
- **The create disc uses a path shadow over its opaque coral fill, not `boxShadow`.** React Native computes a shadow path only over an opaque background.
- Don't write shadow strings inline.

### Motion

Motion explains a change of state; it is never decoration. The tokens are in `appTheme.motion`:

- **Durations:** `navigation` 140 ms, `navigationSwell` 90, `state` 180, `reveal` 360. Every timing names its easing.
- **Springs over eased curves:**
  - `pressIn` is close to critically damped, so a surface lands under the finger at once.
  - `release` is underdamped, so it settles back with a small visible rebound.
  - `panel` is for drawers and sheets, damped enough that a 360pt panel never overshoots its edge.
  - `navigationSettle` settles the dock's selection.
- **Press scales:** controls 0.9, buttons 0.96, cards 0.975. A 1–2% change reads as nothing under a thumb.
- Use `usePressMotion`, `MotionView`, `useSpringState` and `useOverlayPresence` from `lib/motion.ts` rather than new animation code.
- **Reduced motion** (`useReducedMotion()`) swaps travel for a fade or a cut. Tab switches drop their animation, and `SaveHeart` becomes a plain swap.
- **List entrances:** `Reveal` fades a list's first page into place once, at mount. Recycled cells never replay it.
- **Opening the reel:** a tile opens it with UIKit's zoom transition on iOS (`Link.AppleZoom`, `lib/apple-zoom.ts`) and with the zoom flight in `components/media-zoom.tsx` elsewhere. The reel's chrome draws inside the zoom window, so the hand-over changes no pixel.

### Haptics

`haptic.select`, `light`, `soft`, `medium`, `success` and `error` from `lib/haptics.ts` are the whole vocabulary. On Android each maps to an OS constant (`ANDROID_EFFECTS`).
- Use them for selection changes, save, generate, publish and errors.
- Never on scroll or on every tap.

## Icons

Use `lucide-react-native`. A Babel plugin rewrites each import to that icon's own module.

- **Sizes** come from `appTheme.icon`, stepped to sit beside the type ramp:
  - `xs` 14 beside `caption`;
  - `sm` 16 beside `label` or `bodySm`;
  - `compact` 18 beside `body`;
  - `default` 20 for a standalone control;
  - `feature` 24 beside `sectionTitle`;
  - `hero` 32 for hero and empty states.

  A size off the ramp fails `hig-icon-size.test.ts`.
- **Stroke:** one weight for the whole set, 2.2. The `LucideProvider` in the root layout sets it once, so call sites pass a size and never a stroke.
- **Labels:** icon-only buttons need an `accessibilityLabel`. Pair unfamiliar icons with text.
- **Selected state** shows through colour, fill, background or a badge, never a different icon family.
- **Metaphors:**
  - Home `Home`, Explore `Compass`, Alerts `Bell`, Profile `User`.
  - Create `Plus`, `Sparkles`, `WandSparkles`.
  - Image `Image`; video `Play`, `Video`; motion `Rocket`.
  - Community `Heart`, `MessageCircle`, `Share2`.
  - Account `Settings`, `Wallet`, `Crown` (credits).
  - Navigation `ChevronLeft`, `ChevronRight`, `X`.

## Accessibility And Touch

- **Hit regions:** 44 × 44pt minimum (`MIN_HIT_TARGET_PT`).
  - A control drawn smaller extends its reach with `verticalHitSlop()` from `lib/hit-target.ts`.
  - `appTheme.touch` sizes controls at 48 by default and 56 when roomy, which also meets Material's 48dp.
- **Contrast:** 4.5:1 for text on every panel surface, in both schemes.
- **Text size:** it scales with the OS; see Typography.
- **VoiceOver and TalkBack:**
  - Label icon buttons.
  - Give an `accessibilityHint` where the result isn't obvious.
  - Announce headers.
  - Expose selected and disabled state.
- **Reduce Transparency:** the dock turns it into an opaque fill on iOS.
- **Keyboard:**
  - Screens that take input use `Screen keyboardAware`, and forms keep taps with `keyboardShouldPersistTaps="handled"`.
  - A sheet with a text field renders through the overlay host, because Android reports no keyboard height inside a React Native `Modal`.
  - Focus order follows visual order.
- **Text over pictures:** it sits on a shade (`mediaColors`, the caption scrim). Critical copy never goes on noisy media.
- **Selectable text:** errors, IDs and prompts are selectable where useful.

## Navigation Model

### The dock

`components/magic-tab-bar.tsx` draws a floating dock with five places: Home, Explore, the coral Create disc, Alerts and Profile.

- Labels are always visible. The active tab takes the coral tint, and Alerts carries the unread badge.
- **iOS** draws the dock in Liquid Glass where the OS has it, and otherwise a fill tinted from the content behind it. It honours Reduce Transparency.
- **Android** draws its own opaque dock.
- The dock **hides, never unmounts,** while the Create workspace is up. A blur view torn down mid-fade crashes.
- Credits (`(tabs)/pricing`) is a tab route with no dock button. The credits pill in Home's top bar opens it.
- Don't add a destination to the dock without removing one.

### Create menu

The disc opens two choices, each with its description (`lib/create-menu-view-model.ts`):
- **Create**: "Image, Video, and Motion".
- **Post**: "Share finished media".

Keep generating and publishing visibly different.

### Side menu

Home's menu button opens a drawer (`components/home-side-menu.tsx`) with Templates, Invite & Earn, Your Sales, Your Unlocks, Settings, and Help & Support. Secondary destinations belong there or behind Profile, not in the dock.

### Stack screens

These screens push over the tabs:
- `create/[tool]`, `post/new`, `post/[id]`, `viewer` (the reel);
- `creators/[username]`, `showcase/[id]`;
- `edit-profile`, `settings`, `help`, `invite`, `unlocks`, `unlock/[unlockId]`;
- `marketplace/[assetId]`, `seller-dashboard`;
- `templates`, `templates/[slug]`, `template-runs/[runId]`;
- `profile-media-feed`, `delete-account`.

`auth`, `onboarding` and `update-required` sit outside the tab flow. The last two turn the back gesture off.

Every pushed screen has a real way back, including its loading and error states. Forms and settings should not feel like feed pages.

## Overlays

- **Action sheets** (`showActionSheet`, `components/action-sheet.tsx`) draw in-window through `OverlayHost`, so a sheet opened from another sheet draws above it.
- **Dialogs** (`showConfirmDialog`, `showMessageDialog`, `components/dialog.tsx`) use a `Modal`. A dialog has no text field and has to sit above everything.
- **Sheets with a text field** (comments, editors) render through `components/overlay-host.tsx`, never a React Native `Modal`, for the keyboard reason above.
- **Sheet chrome** (`components/sheet-chrome.tsx`) is the one dismissal contract every bottom sheet shares.
  - The grabber really drags.
  - A swipe down or a tap on the backdrop dismisses the sheet.
  - Its top corners are `radii.xl`.

  Drawing a grabber without the drag is worse than drawing none.
- Keep sheet action lists short, put destructive or final actions last, and never use a sheet for ordinary page navigation.

## Component System

New or migrated UI uses these primitives from `components/ui.tsx`. A missing one gets added there first.

| Primitive | Use |
| --- | --- |
| `Screen` | The standard shell: scroll, safe areas, `screen` padding, `section` gaps. `insideTab` reserves the dock; `keyboardAware` suits input screens |
| `AppText` | All text: a variant and a theme colour, with header semantics and scale caps built in |
| `BrandLockup` | The product name: `compact` in chrome, `hero` on the welcome screen |
| `Kicker` | A one-to-three-word eyebrow in caps |
| `SectionHeader`, `SectionTitle` | Eyebrow, title, body and an optional action for a page section |
| `Card` | A repeatable unit: `default`, `soft` or `inset`, padding `sm`/`md`/`lg`, an optional tool accent |
| `SurfaceSection` | A titled panel grouping related controls |
| `DisclosureSection` | A section that expands and collapses (advanced settings) |
| `ChoiceChip` | One choice among a few, with real selected state |
| `Pill` | A static tag, optionally with an icon |
| `MetricCard` | A number with its label, an optional icon, body and action |
| `ReadinessRow` | A pre-flight line: neutral, ready, warning, danger |
| `ToggleRow` | A labelled switch with an explanation |
| `PrimaryButton` | The one main action of a decision area. It takes a coral fill or a tool accent, and `loadingLabel` narrates the wait ("Publishing…") |
| `SecondaryButton` | Supporting actions; never competes with the primary |
| `IconButton` | An icon-only control; its label is required |
| `AppTextInput` | Label above; `hint`, an announced `error`, a `footer` for counts, a clear button |
| `BottomActionDock` | The action dock at the foot of a long form |
| `MediaFrame` | A picture or video with its aspect ratio held before load |
| `StatusBlock` | Empty, info, success, warning and error states: a title and a next step |
| `WebLinkButton` | Opens a web page (help, legal) |
| `CreatorAvatar` | A creator's photo with an initial as fallback |

Beyond `ui.tsx`:

- `feed-card-shell.tsx`: the frame every feed card shares.
- `skeleton.tsx`: loading bones shaped like the content, breathing on one shared pulse.
- `reveal.tsx`: the first page's entrance.
- `save-heart.tsx`: the optimistic save pop.
- `top-scrim.tsx`: the fade under the status bar on scrolling tab roots.
- `double-tap-pressable.tsx`: a double-tap on media.

Card hierarchy: media or icon, then title, then a short body or metadata, then one clear action. Avoid cards inside decorative cards, mixed radii in one list, and more than one primary action per card.

Button copy uses verbs ("Generate image", "Publish post", "Save", "Remix"). A bare "Open" is fine only when the destination is obvious.

## Screen Patterns

These describe the app as of 0.1.6; each screen's `hig-*` test pins the details.

### Home

`components/home-dashboard.tsx`. Job: the community feed, with the next thing to make one tap away.

1. **Top bar.**
   - The menu button (side menu) sits on the left.
   - The credits pill sits on the right: crown, balance, and `+`. It shows a dash until the balance loads, because a 0 reads as an empty account.
   - The title slot is deliberately empty.
2. **Header rail.** Swipeable slides: continue in the creator workspace, the Image, Video and Motion tools, and promos. It turns every few seconds, but only while Home is at rest and on screen.
3. **Lanes:** For You, Notes (posts with writing), Recent, Unlocks. A lane is a new feed, so switching remounts the list at its top.
4. **The feed.** A FlashList of cards:
   - media cards open the reel;
   - written posts open the post page;
   - the comment control opens comments directly.

Rules:

- The For You first page is kept on the device, so a cold start draws the last posts while the feed refreshes.
- The list header's height must not change with load state, because FlashList anchors on it.

### Explore

`app/(tabs)/showcase.tsx`. Job: browse community media and open it.

1. The title, with search (a full-screen overlay) and the workspace menu.
2. Filters: All, Unlocks, Free, Paid, Remixable.
3. A masonry grid of media posts. Text-only posts live on Home's Notes lane and the post page.
4. A skeleton grid while loading, and paging at the foot.

Rules:

- A post whose preview is still rendering keeps its place in the grid.
- A tile opens the reel with a zoom from the tile itself.

### The reel

`app/viewer.tsx` and `components/reel-chrome.tsx`. Job: watch full-screen and act on a post.

- **Scheme:** dark in both schemes, with a light status bar while in front.
- **Paging:**
  - Vertical paging between posts, with one video playing at a time.
  - A swipe left opens the post's details page.
- **Right rail:** Save, Comment, Share, Details, and Remix or Recreate (coral).
  - Own posts add Publish and a visibility control.
  - Paid posts add Unlock.
- **Chrome:**
  - The creator and caption sit on a shade at the bottom.
  - Pictures and videos that don't fill the screen sit on plain black bands (`mediaColors.mediaGround`), as in a video player. The same black fills any contained picture or video elsewhere, such as reference tiles and creator-profile videos. Nothing is blurred: `media-blur-guard.test.ts` allows no `blurRadius`.
  - A top shade sits under the status bar.
- **Loading:** before the data lands, the reel shows the tapped tile's own picture (and its playing video), never a spinner.

### Post page and details

`app/post/[id].tsx` and `components/post-details-page.tsx`.

- Written posts read as a page, not a reel. Page 0 is the post, and a swipe left reaches the same details page media posts have: how it was made, references, resources and unlock.
- Every state keeps a way back: loaded, loading, or gone.

### Comments

`components/comments-sheet.tsx`. Threaded comments in a sheet:

- replies sit under their parent, and the thread pages as you scroll;
- report, remove and delete appear where allowed;
- writing needs an account, and a guest goes to sign-in and comes back to the thread.

### Post composer

`app/post/new.tsx`. One vertical page, no wizard, in this order:

1. **Made With:** attribution.
2. **Title.**
3. **Proof:** the media or text being posted. Generated media stays attached as it is.
4. **Story:** the public content shown in Explore.
5. **Unlock:** optional gated resources, free or paid.
6. **Publish:** who can see it.

Then the footer with the publish action.

Rules:

- "Post to feed" after generating and "Post this creation" in the reel both open the composer for review. Neither publishes immediately.
- Generation references and exact prompts attach only when the creator chooses them.
- Marketplace details appear only once a free or paid package is chosen.
- Removing something offers Undo just above the footer, where it stays in reach.
- After publishing, the share sheet is offered, then Profile opens on Posts with the new post in view.

### Create workspace

`app/(tabs)/creator.tsx` and `components/media-creation-screen.tsx`. Job: the minimum input, the options when wanted, generate, then continue.

Create is a prompt-first single page for Image, Video and Motion, not a wizard.

- **Structure:** the tool switcher, the prompt, the model and its common settings, and references. Advanced settings are collapsed by default. Readiness and the generate action close the page.
- **Cost:** it is visible before generating and matches the credits pill.
- **Inputs:**
  - The first-time path is prompt, then generate.
  - References are optional, except Motion's required character image and reference motion video, which come before the prompt.
  - Upload guidance says what is accepted and why.
- **Models:** pickers explain each model's benefit in plain words. Prompt enhancement never looks like the primary action.
- **After generating:** the screen offers Post to feed (once there is a generation), Open Alerts, and Back to creator. It may also ask to turn on notifications. Progress survives leaving the screen and can be found in Alerts.

### Profile

`components/profile-dashboard.tsx`. The title (`pageTitle`, announced as a header), the profile header with edit, then Saved / Creations / Posts as a segmented control, then the grid.

- A signed-out profile invites sign-in without looking broken.
- Each segment's empty state says what will appear there.

### Alerts

`app/(tabs)/studio.tsx`. Titled "Alerts".

- Generation progress and history come first. Preferences follow, grouped as Generation updates, Creator activity, and Unlocks & credits, with the device's push state.
- Failures say what still works ("In-app history still works") and how to retry.
- Completed generations open their output.

### Credits

`app/(tabs)/pricing.tsx`. "Top up credits":

- the store's packs and Restore purchases;
- a clear state for each reason a purchase can't happen, such as purchases unavailable in this build, turned off on the device, or packs unavailable;
- a guest can buy first and create an account later.

Buying and restoring show loading, success and error states.

### Settings

`app/settings.tsx`.

- Appearance is a segmented control with radio semantics (System, Light, Dark), and the change lands in the same frame.
- Below it come the account rows (profile, credits, invite, alerts), help, the legal pages, and account deletion.

### Onboarding

`app/onboarding.tsx`. It stays dark in both schemes, because its art is made for black. The app takes the phone's appearance from the first screen after it.

## Feeds And The Reel

What scrolls and swipes has a frame budget, and every rule here came from a measured regression on the phones. `feed-render-cost.test.ts` pins them.

- **Round feed cards without clipping them.** `overflow: 'hidden'` on a card costs iOS an offscreen pass per card per frame.
- **No box shadows on scrolled content.** The create disc uses a path shadow over its opaque fill.
- **Gradients use React Native's own** on anything that mounts while scrolling or swiping: `experimental_backgroundImage` with `linearGradient()` from `lib/eased-fade.ts`, drawn by the render server. expo-linear-gradient paints on the main thread each time its view appears, which cost 16–27 ms per rail switch and per reel open on the iPhone.
- **Pause what nobody sees.**
  - The header rail stops turning while the feed moves or is off screen.
  - The dock subscribes to the sampled colour only where it paints it.
- **One video plays at a time.**
  - The feed elects one player.
  - Set player properties once rather than on every hand-off, because AVPlayer writes stall iOS scrolling.
- **FlashList for every feed.**
  - The list header keeps its height through loading.
  - Masonry cells keep their place when a preview arrives.
- **Measure before and after** on the phones: Instruments on the iPhone, Perfetto on the Android. Keep only changes with a measured gain; feel is the final judge.

## Habit And Retention Patterns

Use positive loops:

- Immediate reward: after generation or publishing, show the result.
- Progress visibility: active jobs are easy to find.
- Saved inspiration: saving is one light tap with a visible pop.
- The remix loop: community work becomes a new creation quickly.
- Gentle status: credits and render state are visible but not stressful.

Avoid:

- Anxiety-based reminders.
- Streak mechanics unrelated to creator value.
- Surprise credit usage.
- Hiding failures.
- Gesture-only critical navigation.

## UX Writing

Voice: clear, short, creator-focused, specific about result and consequence.

Examples:

- Good: "Generate image". Avoid: "Submit".
- Good: "Add start frame". Avoid: "Upload".
- Good: "Costs 18 credits". Avoid: "Premium".
- Good: "Could not upload. Try a JPG, PNG, or HEIC under the limit." Avoid: "Upload failed."

Rules:

- Use action verbs, and explain cost before commitment.
- Explain model settings in terms of the result.
- Error messages say what happened, what still works, and what to do next.
- Empty states offer a next action.
- One name per thing across the app: the tab and its screen title both say Alerts.
- Ellipses are the `…` character, and a waiting button says what it is doing ("Publishing…").

## State Patterns

Every screen or component that fetches or mutates data covers:

- Empty.
- Loading: a skeleton in the content's shape, not a spinner, where the layout is known.
- Saving or uploading.
- Success.
- Error, with a retry.
- Signed-out, and guest where it differs.
- Insufficient credits where relevant.

Generation state language:

- `Ready`: inputs valid and cost known.
- `Uploading`: the file is moving to storage.
- `Starting`: the request was accepted.
- `Processing`: the model is working.
- `Completed`: the output is ready.
- `Failed`: explain and offer recovery.

## When Editing Mobile UI

1. Start with the job of the screen.
2. Reach for `Screen`, `AppText`, `Card`, the buttons, chips, inputs and status blocks first.
3. Take every value from `appTheme` and every colour from `useAppTheme()`.
4. Keep the existing behaviour unless the task changes the UX.
5. Move only the touched surface onto shared primitives, unless a shared primitive must change.
6. Check both schemes, a small width, the largest text size, and the loading, error and signed-out states. Check on a device or simulator, not only in tests.

Before a change is done, answer yes:

- Is the primary action obvious within three seconds?
- Does the screen use the shared tokens and primitives, in both schemes?
- Are type roles consistent, and does the text scale?
- Are icons Lucide, from the ramp, and labelled where needed?
- Are touch targets at least 44pt?
- Is cost visible before paid or generation actions?
- Are the empty, loading, error and success states covered?
- Does the screen respect safe areas and the dock?
- If it scrolls or swipes, does it follow [Feeds and the reel](#feeds-and-the-reel)?
- Does it still feel premium, calm and media-led?

## Final Principle

Magicbooklet mobile should be addictive because making and sharing content feels immediate, not because the interface is noisy. Make the useful path obvious, make the advanced path discoverable, and make every repeated element look like it came from the same product.
