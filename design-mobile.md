# Magicbooklet Mobile Design System

Audience: designers, engineers, and AI agents working in the Expo/React Native app at `ugc-mobile/**`.

Read this before editing mobile UI. This file is the mobile source of truth for typography, color, spacing, icons, layout, components, and UX structure. The older research source is [docs/ui-consistency-research-2026-06-14.md](./docs/ui-consistency-research-2026-06-14.md).

## Purpose

Magicbooklet mobile should feel like a premium dark AI creator studio in your pocket: fast, media-led, touch-friendly, polished, and calm enough that creators can move from idea to output without fighting the interface.

The app can be visually rich, but the system underneath must be strict. Addictive and beautiful mobile apps work because they repeat familiar patterns: predictable tabs, consistent typography, obvious primary actions, clear progress, rewarding results, and low-friction recovery.

## Reference Principles

Use these references as direction, not as brands to copy:

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines): legibility, Dynamic Type, platform navigation, safe areas, and 44pt minimum hit regions.
- [Material Design 3](https://m3.material.io/): role-based typography, semantic color, shape, 8dp layout rhythm, 4dp detail rhythm, and 48dp touch targets.
- [Pinterest Gestalt](https://gestalt.pinterest.systems/): media-led surfaces stay consistent through reusable components, tokens, and shared language.
- [CapCut](https://www.capcut.com/): creator tools should be packaged as quick starts, templates, and obvious task entry points.
- Habit-forming apps such as Duolingo, TikTok, Instagram, and Calm: use clear reward loops, immediate feedback, and repeatable navigation. Do not copy dark patterns, anxiety loops, or confusing gesture-only controls.

## Product North Star

The first impression should say:

- "This is a serious creator tool."
- "I can make something quickly."
- "My work, credits, and next action are obvious."
- "The app looks cinematic, but it will not surprise me."

Every screen should support one of these jobs:

- Start creating.
- Review or continue a generation.
- Browse and save inspiration.
- Publish or unlock creator resources.
- Manage profile, credits, and settings.

If a surface does not support one of these jobs, it should be simplified or moved deeper.

## Design Language

### Personality

Use this tone:

- Premium, dark, cinematic.
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

1. Background: deep dark app canvas.
2. Panels: slightly raised dark surfaces.
3. Cards: repeatable work units with media, title, metadata, action.
4. Accents: image/video/motion/workflow/commerce colors.
5. Primary actions: high-contrast, easy to reach, stable wording.

Gradients are allowed for:

- Primary create/generate CTA.
- Tool identity moments.
- Media placeholders.
- Subtle background washes.

Gradients are not allowed as a substitute for hierarchy.

## Source Files

Use existing shared layers first:

- Mobile tokens: `ugc-mobile/lib/theme.ts`
- Mobile primitives: `ugc-mobile/components/ui.tsx`
- Tab metrics: `ugc-mobile/lib/tab-bar-layout.ts`
- Safe-area helpers: `ugc-mobile/lib/safe-area.ts`
- Current home: `ugc-mobile/components/home-dashboard.tsx`
- Current create flow: `ugc-mobile/components/media-creation-screen.tsx`
- Current tab bar: `ugc-mobile/components/magic-tab-bar.tsx`
- Current create menu: `ugc-mobile/components/magic-create-menu.tsx`

When touching a mobile screen, migrate the touched surface toward these shared files. Do not invent a local style system.

## Tokens

`appTheme` is the single source of truth. Expand it carefully and keep backward-compatible aliases while migrating older screens.

### Color

Core:

| Role | Value | Use |
| --- | --- | --- |
| `bg.app` | `#050506` | Deep app chrome, modal backdrops |
| `bg.page` | `#09090b` | Main screen background |
| `surface.1` | `#111215` | Default panels and cards |
| `surface.2` | `rgba(255,255,255,0.04)` | Soft raised surface |
| `surface.3` | `rgba(255,255,255,0.06)` | Stronger raised surface |
| `surface.inset` | `rgba(0,0,0,0.32)` | Inputs, media insets, nested blocks |
| `border.subtle` | `rgba(255,255,255,0.08)` | Quiet borders |
| `border.default` | `rgba(255,255,255,0.10)` | Cards, inputs, panels |
| `border.strong` | `rgba(255,255,255,0.18)` | Active or modal borders |
| `text.primary` | `#fafafa` | Main text |
| `text.secondary` | `#d4d4d8` | Secondary text |
| `text.muted` | `#a1a1aa` | Support copy |
| `text.faint` | `#71717a` | Metadata only |

Accents:

| Role | Value | Use |
| --- | --- | --- |
| `accent.image` | `#38bdf8` | Image generation |
| `accent.video` | `#fb7185` | Video generation |
| `accent.motion` | `#a78bfa` | Motion transfer |
| `accent.workflow` | `#34d399` | Workflow, success, publish |
| `accent.commerce` | `#f59e0b` | Credits, unlocks, marketplace |
| `accent.danger` | `#fb7185` | Errors and destructive actions |

Rules:

- Use semantic roles, not raw hex values, in new UI.
- Use one accent per screen section unless the screen is a launcher.
- Keep text contrast readable on media overlays.
- Never place muted text on low-contrast gradients.
- Danger and video currently share rose; distinguish by context and icon.

### Typography

Mobile should use native scalable text. The app currently loads `SpaceMono`, but the product UI should not become monospace-led. Use the platform font or intentionally bundled brand font for product text; reserve monospace for technical IDs only.

Type roles:

| Role | Size / Line | Weight | Use |
| --- | --- | --- | --- |
| `display` | 34 / 40 | 800 | Rare hero or major launchpad heading |
| `pageTitle` | 30 / 36 | 800 | Screen title |
| `sectionTitle` | 22 / 28 | 800 | Section title |
| `cardTitle` | 18 / 24 | 800 | Card or panel title |
| `body` | 16 / 24 | 400 | Main readable copy |
| `bodySm` | 14 / 21 | 400 | Compact explanatory copy |
| `label` | 12 / 16 | 700 | Form labels, buttons, small controls |
| `caption` | 11 / 15 | 600 | Metadata only |
| `button` | 15 / 20 | 800 | Buttons |
| `metric` | 34 / 38 | 800 | Numbers and dashboard stats |

Rules:

- Use `AppText` from `components/ui.tsx` for new text.
- Use `pageTitle` once per screen.
- Use `sectionTitle` for grouped content.
- Use `cardTitle` for repeated cards and panels.
- Use `body` or `bodySm` for instructions.
- Use `caption` only for low-risk metadata, never for required instructions.
- Avoid `fontSize: 10` and `fontSize: 11` for anything the user needs to understand before acting.
- Avoid heavy all-caps except `Kicker` labels of one to three words.
- Avoid negative letter spacing.
- Prefer sentence case for UI labels.

### Spacing

Use a 4pt base and 8pt major rhythm.

Primitive scale:

| Token | Value |
| --- | --- |
| `0` | 0 |
| `1` | 4 |
| `2` | 8 |
| `3` | 12 |
| `4` | 16 |
| `5` | 20 |
| `6` | 24 |
| `8` | 32 |
| `10` | 40 |
| `12` | 48 |
| `16` | 64 |

Semantic spacing:

| Role | Value | Use |
| --- | --- | --- |
| `screen` | 16 | Screen horizontal padding |
| `compact` | 8 | Tight icon/text gap |
| `gap` | 12 | Default internal gap |
| `card` | 16 | Card padding |
| `panel` | 20 | Large panel padding |
| `section` | 32 | Section-to-section spacing |
| `page` | 48 | Large vertical separation |

Rules:

- Avoid new `18px` screen padding.
- Avoid arbitrary `gap: 13`, `gap: 17`, `padding: 19`, etc.
- Use `contentContainerStyle` for scroll padding.
- Main tab screens must reserve bottom space from `getMagicTabBarMetrics`.
- Dense controls can use 8 or 12 gaps, not 4 unless icon-only.

### Radius

Use a small radius scale:

| Role | Value | Use |
| --- | --- | --- |
| `xs` | 8 | Tiny tags, thumbnails |
| `sm` | 12 | Compact controls |
| `md` | 16 | Inputs, buttons, small cards |
| `lg` | 20 | Standard cards |
| `xl` | 24 | Panels and media cards |
| `modal` | 28 | Sheets and large dialogs |
| `pill` | 999 | Pills and round buttons |

Rules:

- Use `borderCurve: 'continuous'` for rounded rectangles.
- Media frames use 16, 20, or 24 depending on size.
- Buttons use pill or 16, not unique radii per screen.
- Avoid arbitrary 26, 30, 34 values unless a component token owns them.

### Elevation

Mobile dark UI should rely mostly on borders, alpha, and blur rather than heavy shadows.

Tokens:

- `shadow.none`: default.
- `shadow.surface`: low lift for cards.
- `shadow.panel`: stronger lift for floating panels.
- `shadow.modal`: strongest lift for sheets and menus.
- `glow.accent`: rare accent glow for the center create button or primary generate CTA.

Rules:

- Do not add random shadow strings inline.
- Avoid shadows on every card in a feed.
- Use glow only for primary moments, not normal content.

### Motion

Motion should help people understand state changes.

Durations:

- `fast`: 120ms
- `base`: 160ms
- `slow`: 240ms

Rules:

- Animate menus, sheets, generation state changes, and success confirmations.
- Use subtle press feedback on buttons.
- Avoid scaling every card on every press if it makes lists feel jumpy.
- Respect reduced-motion settings where possible.
- Haptics are useful for create, generate, save, publish, and errors.

## Icon System

Use `lucide-react-native` for product icons.

Sizes:

- 16: metadata and tiny inline actions.
- 18: compact actions.
- 20: normal actions.
- 24: feature marks.
- 28-32: large create menu actions only.

Rules:

- Icon-only buttons need `accessibilityLabel`.
- Pair unfamiliar icons with text.
- Keep stroke width near `2` or `2.2`; do not mix visual weights casually.
- Selected state should use color, fill, background, or badge, not a different icon family.
- Use familiar metaphors:
  - Create: `Sparkles`, `WandSparkles`, `Plus`
  - Image: `Image`
  - Video: `Play`, `Video`
  - Motion: `Rocket`, `Sparkles`
  - Feed/community: `Users`, `Heart`, `Share2`
  - Profile/account: `User`, `Settings`, `Wallet`, `Crown`
  - Navigation: `ChevronLeft`, `ChevronRight`, `X`

## Accessibility And Touch

Minimum targets:

- iOS: at least 44 x 44pt.
- Android / Material: aim for at least 48 x 48dp.
- Primary CTA: 48-58px tall.
- Icon-only controls: at least 44 x 44.
- Chips can look smaller, but their hit area should not be smaller than 44.

Text:

- Important text should remain readable with larger font settings.
- Do not lock critical text to tiny single-line labels.
- Error text should be selectable when useful.
- Important data such as IDs, prompt snippets, and file names can be selectable.

Media overlays:

- Add scrims or gradient protection behind text.
- Do not put critical copy on visually noisy media.
- Keep action buttons separated enough to prevent accidental taps.

Keyboard:

- Forms must use `keyboardShouldPersistTaps="handled"`.
- Inputs near the bottom need keyboard-aware padding.
- Focus order should follow visual order.

## Navigation Model

### Main Tabs

The bottom tab bar is the persistent product map. It should have three to five top-level destinations.

Current visible tabs:

- Home
- Feed
- Alerts
- Profile
- Center create action

Rules:

- Tabs are for navigation; the center `+` is a special product action and must be treated as a deliberate exception.
- Keep tab labels visible.
- Active tab must be obvious through color and label/icon state.
- Do not add more visible tabs unless one is removed.
- Secondary destinations such as Credits, Unlocks, Settings, Help, and Seller Dashboard belong behind profile, menu, or contextual links.

### Center Create Menu

The center create action should open a short, confident choice:

- `Create`: image, video, motion.
- `Post`: publish existing work or external media.

Rules:

- Show both label and short body copy. The current data already includes useful bodies in `create-menu-view-model.ts`.
- Keep actions large and reachable.
- Dismiss with backdrop tap and close button.
- Do not hide the difference between generating content and publishing content.

### Stack Screens

Use native stack behavior for focused flows:

- `create/[tool]`
- `post/new`
- `viewer`
- `edit-profile`
- `settings`
- `marketplace/[assetId]`

Rules:

- Use real back affordances.
- Full-screen media viewer may hide the tab bar.
- Forms and settings should not feel like feed pages.

## Component System

New or migrated UI should use these primitives from `components/ui.tsx` or add them there first.

### Screen

Use for normal screen shells.

Spec:

- Background: `bg.page`
- Horizontal padding: `screen`
- Section gap: `section`
- Safe-area-aware top and bottom.
- Tab screens use `insideTab`.

Use when:

- Home sections
- Profile sections
- Settings/help
- Create launchpad

Avoid:

- Custom per-screen padding unless the surface is a full-screen viewer or masonry feed.

### AppText

Use for all normal text.

Spec:

- Accepts semantic variant.
- Accepts semantic color.
- Defaults to selectable for readable data where appropriate.

Avoid:

- Inline text styles in new components unless the style is a one-off decorative mark.

### SectionHeader

Use for page sections.

Spec:

- Optional eyebrow.
- Title.
- Optional body.
- Optional action.

Rules:

- Section titles should clearly tell users what the area does.
- Do not use vague headings such as "More" when a job can be named.

### Card

Use for repeatable content units.

Spec:

- Radius: `xl` or `lg`.
- Padding: `card` or `panel`.
- Border: `border.subtle` or accent-tinted for selected state.
- Gap: `gap`.

Card hierarchy:

1. Media or icon.
2. Title.
3. Short body or metadata.
4. One clear action or tap target.

Avoid:

- Cards inside decorative cards.
- Mixed radii within the same list.
- More than one primary action per card.

### Buttons

Use `PrimaryButton` for the main action and `SecondaryButton` for support.

Primary:

- Height: 48-58.
- Filled with accent or high-contrast gradient.
- Text uses `button`.
- One per decision area.

Secondary:

- Height: at least 44.
- Bordered or soft surface.
- Never competes visually with the primary.

Ghost/icon:

- Use for toolbar actions.
- Must have accessibility label.

Button copy:

- Use verbs: Generate image, Create video, Publish post, Save, Share, Recreate.
- Avoid vague labels such as "Open" when the destination matters.

### Inputs

Use `AppTextInput` or a shared input wrapper.

Spec:

- Label above input.
- Radius: `md`.
- Border: `border.default`.
- Background: `surface.inset`.
- Minimum height: 48 for single-line, 112+ for prompt/body.
- Placeholder should be useful, not cute.

Rules:

- Required fields should be obvious.
- Optional fields should say optional.
- Long prompt input should have helper text and enhancement action nearby.

### Pills And Chips

Use for filters, statuses, metadata, model options, and unlock tags.

Spec:

- Visual height may be 32-36.
- Hit target should be 44+.
- Radius: pill.
- Active state uses accent border/background.

Rules:

- Use chips for small choices, not for complex decisions.
- If a choice affects cost, show the cost nearby.
- Avoid horizontal chip rows that hide required choices off-screen.

### MediaFrame

Use for all image/video previews.

Spec:

- Stable aspect ratio before load.
- Radius: 16, 20, or 24.
- Border: subtle.
- Background: `surface.inset`.
- Optional gradient scrim for overlays.

Rules:

- Media should be the first visual signal in feeds and viewer surfaces.
- Do not stretch media.
- Video previews need play/pause affordance.
- Text-only posts use a text preview card, not an empty media box.

### StatusBlock

Use for empty, loading, success, warning, and error states.

Spec:

- Title.
- Body.
- Optional action.
- Tone: neutral, success, warning, danger.

Rules:

- Errors must explain the next step.
- Empty states should offer a useful action.
- Loading states should preserve layout when possible.

### Sheets And Menus

Use for temporary focused choices.

Spec:

- Backdrop with blur/dim.
- Rounded top sheet or centered panel.
- Grabber or clear close button.
- Actions at the bottom when destructive or final.

Rules:

- Do not use sheets for normal page navigation.
- Keep sheet action lists short.
- Close/dismiss must be obvious.

## Screen Templates

### Home

Job: orient the creator and start the next useful action.

Structure:

1. Compact top bar: menu, brand, credits, alerts.
2. Welcome/status panel.
3. Creator paths.
4. Recent studio if available.
5. Showcase and unlock rails.

Rules:

- The first useful action should be visible without scrolling.
- `Create new` should feel primary.
- Metrics should support confidence, not crowd the screen.
- Signed-out users should understand they can explore before sign-in.
- Avoid a marketing hero that delays creator paths.

### Create Launchpad

Job: choose what to create.

Structure:

1. Page title and credits.
2. Tool cards: Image, Video, Motion.
3. Short description and estimated starting cost.
4. Recent drafts or recipes if available.

Rules:

- Tool cards should show what each creates, not just model names.
- Keep workflow/future tools visually secondary until available.
- The launchpad should not expose every generation setting.

### Generation Workspace

Job: provide the minimum input, adjust options if needed, generate, then continue.

Phase 3 decision: Create is a prompt-first single page, not a wizard. Keep Image, Video, and Motion in one native workspace with progressive disclosure. Essentials and References stay visible; Advanced settings are collapsed by default.

Recommended structure:

1. Header with credits, cost, and active tool.
2. Tool switcher: Image, Video, Motion.
3. Prompt panel.
4. Essentials: model plus high-frequency settings.
5. References: optional image/video/audio inputs or required motion media.
6. Advanced settings collapsed by default.
7. Readiness rows and primary generate action.
8. Progress and result panel after submit.

Rules:

- First-time path should be prompt -> generate.
- Advanced settings should not block the first output.
- Cost must be visible before generating.
- Upload guidance should explain accepted media and why it is needed.
- Model pickers should explain benefit in plain language.
- Prompt enhancement should not look like the primary action.
- Users should be able to leave and find progress in Alerts/Studio.
- Successful results should offer a `Post this` handoff when a generation ID exists, plus Alerts and Create Another actions.

Image-specific:

- Prompt is required unless using a reference-only supported path.
- Aspect ratio and resolution are common settings.
- References are optional and should not dominate the default path.

Video-specific:

- Start with a recommended model/mode.
- Hide complex multi-shot controls until enabled.
- Explain sound, duration, and resolution in terms of result and cost.
- Frames/elements mode needs plain-language help.

Motion-specific:

- Character image and reference motion video are required.
- Show these required uploads before optional prompt.
- Duration should come from reference video where possible.

### Feed / Showcase

Job: browse, save, open, remix, and learn from community work.

Structure:

1. Title and compact feed controls.
2. Filter chips.
3. Masonry/media grid.
4. Loading, empty, and error states.

Rules:

- Media comes first.
- Gutters must stay consistent.
- Text-only posts need beautiful text cards.
- Save/share/open actions must be touch-friendly.
- Filter chips should have real selected state.
- Avoid controls that look active but do nothing.

### Viewer

Job: inspect media and take the next action.

Structure:

1. Full-screen media.
2. Safe-area top controls: back, more/share.
3. Right-side or bottom action stack: save, share, download, recreate.
4. Bottom metadata: creator, title, caption, unlock/resource cue.

Rules:

- Media should be uninterrupted.
- Overlay text needs strong contrast.
- Actions should stay in predictable positions.
- Recreate/remix should be a major action when allowed.
- Details can live in a sheet or secondary pane.

### Post Composer

Job: publish a text post, external media, Magicbooklet creation, or unlockable resource.

Phase 2 decision: use a guided single-page composer, not a multi-step wizard. The user should scan one vertical flow with clear sections for public post, unlockable resources, preview, and publish readiness. Full create/generation redesign remains later; post publishing should feel feed-first and fast.

Phase 4 decision: creation-to-post publishing is one continuous workspace. `Post this` opens the composer for review; it never publishes immediately. Creation-backed posts default to a normal feed post, with references, exact prompt resources, free packages, and paid packages controlled explicitly by the user.

Recommended order:

1. Selected creation hero when launched from a generation.
2. Public post: title, caption/body, visibility.
3. Content source picker only when no creation is already selected.
4. Collapsed post settings: source/tool and category.
5. Resource package: none, free, or paid.
6. Explicit creation package toggles: attach references, use exact prompt as resource, allow remix.
7. Resource fields when free or paid is selected.
8. Preview.
9. Bottom publish dock with readiness and CTA.

Rules:

- Keep the mental order familiar: what is it, what content, how to describe it, where it belongs, whether it is unlockable.
- Marketplace details should appear only after free/paid package is selected.
- Source/tool and category should be available but quieter than title, caption, visibility, and package decisions.
- Generation references must not auto-attach by default; use explicit package toggles.
- Use readiness rows for public post, resource package, preview, and publish state so blocked actions explain themselves without a separate wizard screen.
- Publish CTA should live in a compact bottom dock when practical.
- After publish, open the new post in the viewer so the reward is immediate.

### Profile

Job: understand identity, media, saved items, posts, credits, and seller status.

Structure:

1. Profile header and edit action.
2. Stats: creations, posts, saved.
3. Credits/wallet cards.
4. Media tabs: Saved, Creations, Posts.
5. Gallery grid.

Rules:

- Signed-out state should clearly invite sign-in without looking broken.
- Gallery cards should use consistent aspect ratio and action labels.
- Credits and wallet should use compact metric cards so money/status surfaces match feed and marketplace hierarchy.
- Saved, Creations, and Posts tabs should use shared chip language with real selected state.
- Empty states should explain what will appear here.

### Alerts / Studio

Job: monitor generation progress, completion, failures, notifications, and recovery.

Structure:

1. Title and notification preferences action.
2. Active generation status.
3. Completed/failed notifications.
4. Retry/open actions.

Rules:

- Active generation states should be visually distinct.
- Failed states need retry or clear next step.
- Completed states should open the output.
- Notification summary, push device state, preferences, and category explanations should use shared cards/metrics so Alerts feels like a product surface, not a system log.
- Notification settings should sit below the history/recovery flow and should not crowd the status list.

### Pricing / Credits

Job: understand balance, buy credits, restore purchases, and know what actions cost.

Rules:

- Credits should appear in the top bar and create flow.
- The pricing screen should also show a compact balance/store readiness row before packs.
- Credit packs use shared cards, typed credit totals, and a small `Popular` pill where applicable.
- Pricing screen should use clear plan cards.
- Buying or restoring must show loading, success, and error states.
- Cost language should match the create flow.

## Habit And Retention Patterns

Use positive loops:

- Immediate reward: after generation or publish, show the result.
- Progress visibility: active jobs are easy to find.
- Saved inspiration: saving should feel lightweight.
- Recreate loop: community work can become a new creation quickly.
- Gentle status: credits and render state are visible but not stressful.

Avoid:

- Anxiety-based reminders.
- Confusing streak mechanics unrelated to creator value.
- Surprise credit usage.
- Hiding failures.
- Gesture-only critical navigation.

## UX Writing

Voice:

- Clear.
- Short.
- Creator-focused.
- Specific about result and consequence.

Examples:

- Good: "Generate image"
- Avoid: "Submit"
- Good: "Add start frame"
- Avoid: "Upload"
- Good: "Costs 18 credits"
- Avoid: "Premium"
- Good: "Could not upload. Try a JPG, PNG, or HEIC under the limit."
- Avoid: "Upload failed."

Rules:

- Use action verbs.
- Explain cost before commitment.
- Explain model settings in result language.
- Error messages should say what happened and what to do next.
- Empty states should give a next action.

## State Patterns

Every screen or component that fetches or mutates data must cover:

- Empty.
- Loading.
- Saving/uploading.
- Success.
- Error.
- Retry.
- Signed-out.
- Insufficient credits where relevant.

Generation state language:

- `Ready`: inputs valid and cost known.
- `Uploading`: file is moving to storage.
- `Starting`: request accepted.
- `Processing`: model is working.
- `Completed`: output is ready.
- `Failed`: explain and offer recovery.

## Current Known Gaps

These should guide the next refactor passes:

- `magic-create-menu.tsx` does not render the body copy already available in `create-menu-view-model.ts`.
- Several screens still use inline type, spacing, border, radius, and shadow values.
- Some tab labels and route names differ: `studio` is titled Notifications but tab label says Alerts. Pick one user-facing language.
- Home has multiple competing starts. Clarify the primary start and make secondary starts quieter.
- Model choices need clearer creator-facing explanations and cost context.

## Migration Rules

When editing mobile UI:

1. Start with the job of the screen.
2. Use `Screen`, `AppText`, `Card`, buttons, pills, inputs, and status blocks first.
3. Use `appTheme` tokens instead of raw values.
4. Keep the existing behavior unless the task explicitly changes UX.
5. Migrate only the touched surface unless a shared primitive must change.
6. Preserve safe-area and tab-bar padding.
7. Verify small width, large text, loading, error, and signed-out states.

Do not add:

- New raw colors outside tokens.
- New arbitrary spacing values outside the 4/8 rhythm.
- Tiny required labels.
- Touch targets below 44.
- Inline SVGs for standard actions.
- One-off card styles for repeated content.
- Text over media without contrast protection.
- New navigation destinations in the tab bar without removing another.

## Implementation Priority

Refactor in this order:

1. Expand `appTheme` with any missing semantic tokens.
2. Strengthen `components/ui.tsx` primitives.
3. Fix the center create menu labels/body and action hierarchy.
4. Simplify the generation workspace into primary path plus advanced sections.
5. Normalize Home cards, rails, and metrics.
6. Normalize Feed cards and viewer overlays.
7. Normalize Profile, Alerts, Pricing, Settings, and composer states.

## Review Checklist

Before a mobile UI change is done, answer yes:

- Is the primary action obvious within three seconds?
- Does the screen use shared tokens/primitives?
- Are type roles consistent?
- Are icons from Lucide and paired with labels when needed?
- Is spacing on the 4/8 rhythm?
- Are touch targets at least 44 high/wide?
- Is cost visible before paid/generation actions?
- Are empty/loading/error/success states covered?
- Does the screen work with safe areas and the bottom tab bar?
- Does the UI still feel premium, calm, and media-led?

## Final Principle

Magicbooklet mobile should be addictive because making and sharing content feels immediate, not because the interface is noisy. Make the useful path obvious, make the advanced path discoverable, and make every repeated element look like it came from the same product.
