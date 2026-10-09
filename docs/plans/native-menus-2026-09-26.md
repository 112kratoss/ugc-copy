# Native menus for the ••• buttons

Status: merged early as #217 (`767a2138`, 2026-09-27) at the owner's call, and ships in store build 0.1.8. The inventory below was taken on 2026-09-26 at `c40fbe9e` (#215) on the branch `mobile/native-menus`. The owner chose native menus through Expo UI the same day, and settled the two open calls: the viewer menu opens with an icon row for the rail's actions, and the Create disc keeps its sheet. Every ••• below is converted and checked on an iOS 26.4 simulator as a guest (Home, Explore, the reel, post details, the creator profile) and on the S24 signed in (Home, the reel, a text post, a comment). Left for the iPhone pass: the comment menu on iOS, and Home and Explore scrolling (see Steps).

Update, 2026-10-09: Android no longer draws Material's dropdown. The owner found it generic, and the Expo UI binding in the builds people hold passes that dropdown its fill colour and nothing else (no shape, shadow, offset or motion). Android's menu is now the app's own, grown out of the button (`components/anchored-menu.tsx`, opened by `components/native-menu.android.tsx`; look and motion in `docs/design/design-mobile.md`, Overlays). It is JavaScript only, so it reaches Android over the air. Everything below about Android describes the dropdown it replaced; the iOS menu is unchanged.

Second update, 2026-10-09, from a look at the shipped menus on a Galaxy S24: a left-hand Explore card's menu no longer slides across to sit under the next card's ⋮, Hide is plain in the reel as it is on a card, and your own post lists no Hide, Report user or Block user row on a card, as in the reel and on the web. `docs/design/design-mobile.md` (Overlays) holds the rules.

Scope: `ugc-mobile/` only; paths below are relative to it. Expo UI (`@expo/ui`) is a new native module, so this ships in store build 0.1.8, never over the air. The plan was to keep the branch unmerged until 0.1.8 was cut; merged early, it left OTAs published from `main` no longer matching 0.1.7's fingerprint, as after #202, so 0.1.7 fixes publish from `7113b590` with `publish-ota.mjs --ref` until 0.1.8 ships. Develop and check on the S24 first; the iPhone gets one batched pass.

## Why

- **The reference.** The owner sent a clip of WhatsApp's ••• on iOS 26. On touch, the glass button flashes and swells (about 130 ms). Its glass then stretches out of the button and becomes the menu (about 200 ms, a slight spring, nothing dimmed). A tap outside plays it back into the button (about 250 ms). WhatsApp writes none of this: iOS 26 plays it for any native menu attached to a button.
- **Ours.** Every ••• opens a bottom sheet. The screen dims and a panel rises from the bottom edge, away from the button that was tapped.
- **The HIG sides with WhatsApp.** Pull-down buttons recommends a More pull-down button for items that don't need a prominent place. Action sheets are for choices that follow an action, and should not scroll. The reel's sheet scrolls (`maxHeight: '84%'`).

## What was checked

AGENTS.md asks for a native API before a hand-built behaviour.

| Option | Result |
| --- | --- |
| Expo Router `Stack.Toolbar.Menu` (react-native-screens' bar-button `UIMenu`, already in 0.1.7) | Native header only. Every screen sets `headerShown: false` and draws its own header, and only one ••• sits in a header. |
| Expo Router `Link.Menu` (already in 0.1.7) | A long-press context menu (`UIContextMenuInteraction`). It cannot open on a tap. |
| Expo UI `Menu` (SwiftUI) and `DropdownMenu` (Compose), `@expo/ui` 55.0.17 | **Chosen.** Opens on a tap from any view. Has sections, submenus, a single-choice `Picker` with a checkmark, the destructive role, a `ControlGroup` row of icon buttons, and `buttonStyle('glass')` for the Liquid Glass trigger. Android gets Material 3's dropdown, anchored to the button. Beta in SDK 55, development builds only. |
| `@react-native-menu/menu` 2.0.0 | The fallback if Expo UI falls short. Last published 2025-09-10. |
| Rebuilding the morph in JS | Rejected. The glass refraction is drawn by the system. |

## Inventory

### Convert: the ••• buttons (8 buttons, 4 menus)

| Section | Button | Opens today | Menu |
| --- | --- | --- | --- |
| Reel, in every chrome variant (`MediaZoomChrome`, `MediaSlidePage`) | rail ••• `components/reel-chrome.tsx:269` | `ViewerActionSheet` | Viewer |
| Post page, text post | ⋮ `app/post/[id].tsx:495` | `ViewerActionSheet` | Viewer |
| Post details page (the reel's second page, and the post page) | header ⋮ `components/post-details-page.tsx:436` | `ViewerActionSheet` | Viewer |
| Profile → your Creations and Posts (`profile-media-feed`) | card ⋮ `components/feed-card-shell.tsx:177`, from `profile-feed-card.tsx:74` | `ViewerActionSheet` | Viewer |
| Home feed | card ⋮, the same shell, from `home-feed-card.tsx:86` | `FeedFeedbackSheet` | Feed |
| Explore grid | card ⋮ `app/(tabs)/showcase.tsx:1170` | `FeedFeedbackSheet` | Feed |
| Comments | ••• `components/comments-sheet.tsx:981` | action sheet "Comment options" | Comment |
| Creator profile | ⋮ `components/creator-profile-screen.tsx:513` | action sheet with Report user and Block user | Creator |

- **Viewer menu.** Replaces `components/viewer-action-sheet.tsx`, a `Modal` sheet with a title, a sentence, grouped rows with a second line each, and a scroll.
  - The groups become sections: Your post, Creation to post, Explore preferences and Safety.
  - Someone else's post reaches about 11 items. Save, Comments and Share are already on the rail, so they move into a `ControlGroup` row of icons at the top of the menu (the owner's call, 2026-09-26); Remix leads the first section, since iOS fits three in the row. The same menu opens from screens without the rail, so nothing disappears there. Android has no such row, so they become its first rows.
  - A menu row carries one short subtitle at most, so the per-row descriptions go. A disabled row keeps its reason as the subtitle ("This post is archived").
  - Change visibility becomes a submenu with the current value checked. It replaces the second sheet from `pickPostVisibility`.
- **Feed menu.** Replaces `components/feed-feedback-sheet.tsx`: Not interested and Hide @creator, then Report content, Report user and Block user.
- **Comment menu.** Delete, Remove from post and Report, one to three items.
- **Creator menu.** Report user and Block user. That is two items, and the HIG suggests at least three for a pull-down, so consider adding Copy profile link.

Destructive picks keep their confirmation through `showConfirmDialog`, as the HIG asks of destructive menu items. Every one of those flows already exists.

### Convert: pickers become pop-up menus

| Section | Control | Today | Becomes |
| --- | --- | --- | --- |
| Post composer footer | "Public ⌄" `app/post/new.tsx:1168` | `VisibilitySheet`: radio rows with a line each | **Stays a sheet** (decided 2026-09-27). An iOS menu row cannot carry its line (see below), and each choice needs it to be understood: "Unlisted" means nothing without "Only people with the link can open it". |
| The post menus | Change visibility, `lib/post-lifecycle.ts:132` | a second action sheet | A submenu of the viewer menu. Whoever changes a live post's visibility has chosen it once already, so the bare names do. |

### The owner's call

| Section | Control | Note |
| --- | --- | --- |
| Dock | Create disc `components/magic-tab-bar.tsx:315`, opening `MagicCreateMenu` | Two choices with descriptions (design-mobile.md, Create menu). A native menu would grow out of the disc, but two items is under the HIG's suggested minimum, and the disc's sheet is a designed surface. **Stays** (the owner's call, 2026-09-26). |
| Comments | Report reasons, `components/comments-sheet.tsx:433` | Follows a Report pick. It could be a Report submenu. Recommended: keep it an action sheet, since it is a choice that follows an action. |

### Stays as it is

- Choices that follow an action: "Leave this post?" (`app/post/new.tsx:2247`), "Unlock this resource?" (`app/marketplace/[assetId].tsx:79`) and every `showConfirmDialog`.
- Pickers with search: the model picker (`components/media-creation-screen.tsx:3819`) and Made with (`app/post/new.tsx:3641`).
- Forms and panels: the creator parameter sheet (`components/media-creation-screen.tsx:3902`), reference details, which has a rename field (`:3629`), and the resource composer and its scope picker (`app/post/new.tsx:1297`, `:1633`).
- Choices already on screen: Settings → Appearance, Explore's filter chips, the profile post filter, and the Image/Video/Motion switcher. A menu would add a tap to each.
- Navigation: Home's side menu.

### Later, out of scope

Long-press context menus with a preview on feed cards and grid tiles, the way Photos does it. Nothing offers this today. Expo Router's `Link.Preview` and `Link.Menu` could do it over the air.

## What the simulator showed (iOS 26.4, 2026-09-27)

Checked with a dev client of this branch on a simulator of its own (`MagicBooklet Native Menus`), driven by an XCUITest runner copied from `.claude/tools/reelprobe` and filmed with `screencapture -l` on its window.

- **The morph is the system's.** A SwiftUI `Menu` whose label is our glyph grows out of the button in about 200 ms and shrinks back in about 200 ms, the same motion as WhatsApp's.
- **The label must be drawn from props.** Expo UI's `Image` applies its own `size` and `color` right on the symbol, so `font` and `foregroundStyle` modifiers lose to them, and the default menu style tints the label with the accent blue until `buttonStyle('plain')`.
- **Rows are drawn from props only.** A subtitle needs a label built from child texts, and SwiftUI filled those in about a second after the menu opened, so rows grew under the finger. iOS rows carry no subtitle. The guest's "For this visit" is the section heading there instead.
- **The icon row holds three.** A fourth quick action (Remix) was moved out of the row by iOS, so the model keeps Save, Comments and Share there and Remix leads the first section.
- **The closing tap reached the app.** In Files, a tap outside the ••• menu only closes it. Ours also pressed whatever was under the finger (a tab, a carousel card): React Native's touch handler still receives that tap, most likely because the menu is hosted inside React Native's views. `lib/native-menu-shield.ts` fixes it: the menu's content raises a shield when it appears (`onAppear`, which fires on each open; `onDisappear` never fires), the root view claims the next touch in the responder capture phase, and a chosen row or the app leaving the foreground lowers it.

## What the S24 showed (release `.dev` build, 2026-09-27)

Built from this branch with the JS embedded (`com.magicbooklet.mobile.dev`, 0.1.7, production values), signed in.

- **Every menu opens Material's dropdown from its button,** right-aligned under it, or above it on the reel's rail where there is no room below: Home cards, the reel, a text post's ⋮ and a comment's •••. The dropdown grows out of its corner in about 100–150 ms.
- **The closing tap stays in the dropdown.** Unlike the SwiftUI menu on iOS, the dropdown is a window of its own: with it open, a tap on the Notes tab only closed it. Android needs no shield.
- **Rows read as expected:** the reel's icon-row actions become its first three rows, sections are separated by dividers, destructive rows are red, and a comment you wrote offers Delete alone.

## Steps

1. Add `@expo/ui` at the SDK 55 pin through `expo install`, build an Android dev client, and install it on the S24.
2. Build one primitive, `components/native-menu.tsx`, and list it in `components/ui.tsx` as the design guide asks. It takes one description of a menu (sections, items, subtitles, destructive, disabled, checked) and draws it as a SwiftUI `Menu` on iOS and a Compose `DropdownMenu` on Android. The pure mapping lives in `lib/` and is unit-tested.
3. Convert in this order: feed menu, comment menu, creator menu, the composer's visibility pop-up, then the viewer menu.
4. Check each surface on the S24, then do one iPhone pass: the morph, both appearances, Reduce Motion, and the comment menu, which a guest never sees.
   - **Measure Home and Explore scrolling on the iPhone before shipping.** Every card's ⋮ is now a SwiftUI `Host`, which is one `UIHostingController` per card, built as cells are created and updated as they are recycled. The reel mounts one only for the slide on screen, after it lands; the feeds mount one per card. If Instruments shows it in the hitches, mount the host only on cards at rest and keep the plain button (and its sheet) while the list moves. Android mounts its dropdown only while it is open, so it has no such cost.
5. Update `docs/design/design-mobile.md` (Overlays: a ••• opens a native menu, and action sheets are for choices that follow an action). Extend the HIG guard tests if a rule is adopted.
6. Merged early as #217 rather than held for 0.1.8. Record the OTA target when store build 0.1.8 ships.
