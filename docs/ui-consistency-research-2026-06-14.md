# UI Consistency Research

Date: 2026-06-14

Scope: Pinterest Gestalt, Material 3, Apple HIG, Shopify Polaris, Atlassian Design System, and the current UGC Copy web/mobile codebase.

## Executive Summary

Clean apps do not stay clean because every screen is individually tasteful. They stay clean because most decisions are routed through shared type roles, spacing tokens, icon rules, surface primitives, and layout templates.

For UGC Copy, keep the current premium dark creator-studio direction. The inconsistency comes from too many local values: arbitrary radii, shadows, label tracking, text sizes, border alphas, gradient shells, and one-off card/button treatments.

The recommended direction is:

1. Create one cross-platform design-token layer for color, type, spacing, radius, elevation, and motion.
2. Use semantic UI primitives instead of raw Tailwind bundles everywhere.
3. Keep Lucide as the single icon family on web and mobile.
4. Align spacing to a 4px base unit with 8px major rhythm.
5. Standardize page templates: marketing, creator workspace, feed/detail, modal/drawer, pricing/settings.

## What Pinterest Does

Pinterest uses Gestalt as its design system. Public Gestalt docs describe it as a shared language and reusable React component system for high-quality product experiences:

- Source: https://gestalt.pinterest.systems/
- GitHub: https://github.com/pinterest/gestalt

Gestalt's public repo and package ecosystem show the important pattern:

- Components are the enforcement layer, not just documentation.
- Tokens are published for multiple platforms.
- Layout primitives such as Box, Flex, Container, Column, Masonry, and Collage keep screens from inventing layout behavior.
- Iconography is a named library, not ad hoc SVGs.

Gestalt token findings from `gestalt-design-tokens@177.0.12`:

- Spacing uses a 4px base: 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64.
- Rounding uses 4px steps: 0, 4, 8, 12, 16, 20, 24, 28, 32, pill, circle.
- Core classic type sizes are compact: 12, 14, 16, 20, 28, 36.
- Newer public token output includes `Pin Sans`, line-height tokens, motion durations, semantic color, semantic space, and semantic rounding.

Pinterest-specific takeaway for us: the feed can feel rich and media-led, but the system underneath should be strict and boring.

## Other Clean Systems

### Material 3

Material 3's theme is built from color scheme, typography, and shapes. The default type scale is 15 roles: display, headline, title, body, and label, each with large/medium/small. Android guidance uses 8dp for layout/component spacing and 4dp for smaller elements such as icons and type.

Useful borrow:

- Use a reduced role-based type scale, not random visual sizes.
- Use one shape scale.
- Use 4/8 grid rhythm.
- Use semantic color roles instead of one-off gradients.

Sources:

- https://developer.android.com/develop/ui/compose/designsystems/material3
- https://developer.android.com/design/ui/mobile/guides/layout-and-content/grids-and-units

### Apple

Apple's typography guidance emphasizes legibility, hierarchy, and layouts that adapt to Dynamic Type. SF Symbols works because icons align with the system font across weights and scales.

Useful borrow:

- Keep text scalable and readable.
- Do not let icons visually fight typography.
- Avoid tiny text except metadata.
- Test layout at larger font sizes.

Sources:

- https://developer.apple.com/design/human-interface-guidelines/typography
- https://developer.apple.com/sf-symbols/

### Shopify Polaris

Polaris has primitive tokens and semantic tokens. Their spacing tokens use a 4px base, then semantic tokens such as card padding and card gap. Typography is routed through semantic text tokens that map font family, size, line-height, weight, and letter spacing together.

Useful borrow:

- Give repeated use cases names: card padding, panel gap, table cell padding, button gap.
- Use a Text component or text class system for every text role.
- Prefer semantic tokens first, primitive tokens second.

Sources:

- https://polaris-react.shopify.com/design/typography/typography-tokens
- https://polaris-react.shopify.com/design/layout/layout-tokens
- https://github.com/Shopify/polaris

### Atlassian

Atlassian's typography work is useful because they solved the same problem at app scale: vague type guidance, mismatch between design and code, and visual inconsistency. Their guidance emphasizes typography tokens/components, responsive rem values, correct heading hierarchy, color tokens, and minimum readable sizes. Their icon guidance favors existing icons, simple metaphors, and a consistent visual style.

Useful borrow:

- Build typography into code, then migrate screens incrementally.
- Use existing icons before inventing new metaphors.
- Keep heading levels visually distinct.
- Avoid all caps as the default because it adds visual noise.

Sources:

- https://atlassian.design/foundations/typography/applying-typography
- https://atlassian.design/foundations/iconography
- https://www.atlassian.com/blog/design/implementing-typography-at-scale-the-journey-behind-the-screens

## Current UGC Copy Audit

Web already has good foundations:

- Font: Geist and Geist Mono in `src/app/layout.tsx`.
- Icon family: `lucide-react`.
- Product language: dark studio surfaces, vivid media accents, preview-led creation flows.
- Shared pieces already exist: `CreatorStudio.tsx`, `FeatureLandingPage.tsx`, `globals.css`.

Mobile also has good foundations:

- `ugc-mobile/lib/theme.ts` centralizes color, radius, and spacing.
- `ugc-mobile/components/ui.tsx` already has `Screen`, `SectionTitle`, `Card`, buttons, inputs, status blocks.

Inconsistency signals from source search:

- `border-white/10`: 492 occurrences.
- `border-white/8`: 194 occurrences.
- `bg-white/[0.03]`: 178 occurrences.
- `tracking-[0.18em]`: 165 occurrences.
- `text-[11px]`: 125 occurrences.
- `rounded-[24px]`: 76 occurrences.
- `rounded-[28px]`: 34 occurrences.
- `rounded-[30px]`: 27 occurrences.
- Arbitrary shadows and gradients repeat across CreatorStudio, CreateImage, Workflow, Pricing, Showcase, and Navbar surfaces.
- Mobile spacing uses 18px for `screen` and `section`, which breaks the 4/8 rhythm.

## Recommended UGC Design Tokens

### Color

Keep the current dark creator-studio personality, but stop repeating raw classes.

Core:

- `bg.app`: `#050506`
- `bg.page`: `#09090b`
- `surface.1`: `#111215`
- `surface.2`: `rgba(255,255,255,0.04)`
- `surface.3`: `rgba(255,255,255,0.06)`
- `border.subtle`: `rgba(255,255,255,0.08)`
- `border.default`: `rgba(255,255,255,0.10)`
- `border.strong`: `rgba(255,255,255,0.18)`
- `text.primary`: `#fafafa`
- `text.secondary`: `#d4d4d8`
- `text.muted`: `#a1a1aa`
- `text.faint`: `#71717a`

Accents:

- `accent.image`: `#38bdf8`
- `accent.video`: `#fb7185`
- `accent.motion`: `#a78bfa`
- `accent.workflow`: `#34d399`
- `accent.commerce`: `#f59e0b`
- `accent.danger`: `#fb7185`

### Typography

Use Geist on web. Use system/loaded native equivalent on mobile unless Geist is intentionally bundled.

Recommended semantic roles:

- `display`: 48/56, 700
- `pageTitle`: 36/44, 650-700
- `sectionTitle`: 28/36, 650
- `cardTitle`: 20/28, 650
- `body`: 16/24, 400
- `bodySm`: 14/22, 400
- `label`: 12/16, 650
- `caption`: 11/16, 500
- `metric`: 36/40 or 40/44, 700
- `code`: Geist Mono, 13/20

Rules:

- Use `body` or `bodySm` for most text.
- Reserve `caption` for metadata, not core instructions.
- Avoid arbitrary text sizes like `text-[1.2rem]`, `text-[1.65rem]`, and `text-[3.85rem]`.
- Avoid negative letter spacing. Use default letter spacing for normal text.
- If uppercase metadata stays, route it through one `Kicker`/`Label` primitive instead of dozens of `tracking-[...]` values.

### Spacing

Primitive scale:

- `0`: 0
- `1`: 4
- `2`: 8
- `3`: 12
- `4`: 16
- `5`: 20
- `6`: 24
- `8`: 32
- `10`: 40
- `12`: 48
- `16`: 64
- `20`: 80
- `24`: 96

Semantic spacing:

- `screen.mobile`: 16
- `screen.desktop`: 24 or 32
- `section.mobile`: 32
- `section.desktop`: 48 or 64
- `panel.padding.sm`: 16
- `panel.padding.md`: 20
- `panel.padding.lg`: 24
- `card.gap`: 12 or 16
- `control.gap`: 8
- `toolbar.gap`: 8 or 12
- `modal.padding`: 20 mobile, 24 desktop

### Radius

Use fewer choices:

- `r.control`: 12
- `r.controlLg`: 16
- `r.card`: 20 or 24
- `r.panel`: 24
- `r.modal`: 28
- `r.media`: 20 or 24
- `r.pill`: 999

Rules:

- No new `rounded-[26px]`, `rounded-[30px]`, `rounded-[34px]`.
- Keep large radius only where the current studio language needs it: media cards, modals, creation panels.
- Inputs and buttons should not each invent their own radius.

### Icons

Keep Lucide:

- Web: `lucide-react`
- Mobile: `lucide-react-native`

Rules:

- Default icon size: 20.
- Dense metadata/action icon size: 16.
- Prominent tool icon size: 24.
- Stroke width: 2 unless a component explicitly owns another size.
- Selected state should use color/background/badge, not a different icon family.
- Tool accent mapping stays: image blue, video rose, motion violet, workflow emerald, commerce amber.

### Elevation And Motion

Recommended elevation tokens:

- `shadow.none`
- `shadow.surface`: low blur, subtle alpha
- `shadow.panel`: current dark panel lift
- `shadow.modal`: strongest
- `glow.accent`: only on hover/focus and only by accent token

Motion:

- `duration.fast`: 120ms
- `duration.base`: 160ms
- `duration.slow`: 240ms
- `ease.standard`: cubic-bezier(0.2, 0, 0, 1)

Rules:

- Use motion to confirm state or reveal content.
- Avoid hover scale on every card. Use it only on primary launch/CTA surfaces.

## Component Primitives To Add Or Tighten

Web:

- `Text`
- `Kicker`
- `Surface`
- `Panel`
- `Card`
- `Button`
- `IconButton`
- `Pill`
- `ToolAccentBadge`
- `SectionHeader`
- `PageShell`
- `StudioGrid`
- `MediaFrame`
- `EmptyState`
- `StatusCallout`

Mobile:

- Extend `appTheme` with the same token names.
- Change screen/section spacing from 18 to 16/24/32.
- Add text roles rather than inline `fontSize` everywhere.
- Keep the existing `Screen`, `SectionTitle`, `Card`, `PrimaryButton`, `SecondaryButton`, `AppTextInput`, but route them through expanded tokens.

## Migration Plan

1. Tokenize foundations.
   - Add CSS variables/classes in `src/app/globals.css`.
   - Expand `ugc-mobile/lib/theme.ts`.

2. Create primitives.
   - Add or refactor shared primitives in `src/app/components`.
   - Keep API tiny: type role, surface tone, padding, accent, action size.

3. Migrate repeated shells first.
   - Start with `CreatorStudio.tsx`, `CreateImageClient.tsx`, `CreateVideoClient.tsx`, `CreateMotionClient.tsx`, `WorkflowCanvas*`, and `PricingClient.tsx`.

4. Replace arbitrary values.
   - Remove most `rounded-[...]`, `text-[...]`, `tracking-[...]`, `shadow-[...]`, and raw `bg-[...]`.
   - Allow exceptions only for media aspect ratios, canvas math, and rare complex backgrounds.

5. Verify visually.
   - Desktop and mobile browser pass.
   - Check text wrapping, buttons, modals, feed cards, workflow canvas, and empty/loading states.

## The North Star

UGC Copy should feel like a premium AI creator studio: dark, fast, media-led, and confident. Pinterest is the best model for feed/media density and design-system discipline. Shopify and Atlassian are the best models for token naming and migration. Material and Apple are the best reminders that type, icons, spacing, and adaptive layout must be system-level choices.
