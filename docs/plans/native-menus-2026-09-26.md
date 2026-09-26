# Native menus for the ••• buttons

Status: building. The inventory below was taken on 2026-09-26 at `c40fbe9e` (#215) on the branch `mobile/native-menus`. The owner chose native menus through Expo UI the same day, and settled the two open calls: the viewer menu opens with an icon row for the rail's actions, and the Create disc keeps its sheet.

Scope: `ugc-mobile/` only; paths below are relative to it. Expo UI (`@expo/ui`) is a new native module, so this ships in store build 0.1.8, never over the air. Keep the branch unmerged until 0.1.8 is cut: once it is on `main`, OTAs published from `main` no longer match 0.1.7's fingerprint, which is what happened after #202. Develop and check on the S24 first; the iPhone gets one batched pass.

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
  - Someone else's post reaches about 11 items. Save, Comments, Share and Remix are already on the rail, so they move into a `ControlGroup` row of icons at the top of the menu (the owner's call, 2026-09-26). The same menu opens from screens without the rail, so nothing disappears there. Android has no such row, so they become its first rows.
  - A menu row carries one short subtitle at most, so the per-row descriptions go. A disabled row keeps its reason as the subtitle ("This post is archived").
  - Change visibility becomes a submenu with the current value checked. It replaces the second sheet from `pickPostVisibility`.
- **Feed menu.** Replaces `components/feed-feedback-sheet.tsx`: Not interested and Hide @creator, then Report content, Report user and Block user.
- **Comment menu.** Delete, Remove from post and Report, one to three items.
- **Creator menu.** Report user and Block user. That is two items, and the HIG suggests at least three for a pull-down, so consider adding Copy profile link.

Destructive picks keep their confirmation through `showConfirmDialog`, as the HIG asks of destructive menu items. Every one of those flows already exists.

### Convert: pickers become pop-up menus

| Section | Control | Today | Becomes |
| --- | --- | --- | --- |
| Post composer footer | "Public ⌄" `app/post/new.tsx:1168` | `VisibilitySheet`: radio rows with a line each | Public, Unlisted and Private with the current one checked and each line as its subtitle. The button's label follows the choice. |
| The post menus | Change visibility, `lib/post-lifecycle.ts:132` | a second action sheet | A submenu of the viewer menu |

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

## Steps

1. Add `@expo/ui` at the SDK 55 pin through `expo install`, build an Android dev client, and install it on the S24.
2. Build one primitive, `components/native-menu.tsx`, and list it in `components/ui.tsx` as the design guide asks. It takes one description of a menu (sections, items, subtitles, destructive, disabled, checked) and draws it as a SwiftUI `Menu` on iOS and a Compose `DropdownMenu` on Android. The pure mapping lives in `lib/` and is unit-tested.
3. Convert in this order: feed menu, comment menu, creator menu, the composer's visibility pop-up, then the viewer menu.
4. Check each surface on the S24, then do one iPhone pass: the morph, both appearances, and Reduce Motion.
5. Update `docs/design/design-mobile.md` (Overlays: a ••• opens a native menu, and action sheets are for choices that follow an action). Extend the HIG guard tests if a rule is adopted.
6. Hold the merge for 0.1.8, and record the OTA target when that store build ships.
