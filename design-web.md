# UGC Copy Web UI/UX Guide

Audience: AI agents and engineers working in the Next.js web app.

Read this before editing `src/app/**` UI. The long research source is [docs/ui-consistency-research-2026-06-14.md](./docs/ui-consistency-research-2026-06-14.md).

## Product North Star

UGC Copy web is a premium dark AI creator studio. The first impression should be media-led, dense enough for serious creative work, and fast to move from idea to output. It should borrow Pinterest-level consistency and feed discipline without copying Pinterest's brand.

Use shared tokens and primitives first:

- Tokens/utilities live in `src/app/globals.css`.
- Web primitives live in `src/app/components/DesignSystem.tsx`.
- Existing creator surfaces live in `src/app/components/CreatorStudio.tsx` and `src/app/components/FeatureLandingPage.tsx`.

## Research Distilled For Web

Pinterest Gestalt:

- Consistency comes from reusable components, published tokens, layout primitives, and a named icon library.
- Use a 4px spacing base with 8px major rhythm.
- Rounding should come from a small scale, not one-off values.
- Feed and showcase pages can be rich, but the underlying system should be strict.

Shopify Polaris:

- Prefer semantic tokens such as card padding, panel gap, and text role over raw values.
- Route text through named roles instead of choosing a new size per screen.
- Component APIs are the enforcement layer.

Material 3:

- Keep typography role-based: display, headline/page title, title, body, label.
- Use 8px layout rhythm and 4px detail rhythm.
- Use semantic color roles and shape roles.

Apple HIG:

- Legibility wins over decoration.
- Icons should align visually with type weight and scale.
- Avoid tiny critical text.

Atlassian:

- Typography must be implemented in code, not only documented.
- Existing icons should be used before inventing custom metaphors.
- Avoid all-caps noise except for short metadata labels.

## Typography

Use Geist from `src/app/layout.tsx`. Use Geist Mono only for code, IDs, and technical metadata.

Web type roles:

- `display`: hero title, 48/56, 700.
- `pageTitle`: main page heading, 36/44, 650-700.
- `sectionTitle`: section headings, 28/36, 650.
- `cardTitle`: cards and panels, 20/28, 650.
- `body`: default readable text, 16/24, 400.
- `bodySm`: compact body, 14/22, 400.
- `label`: actions and form labels, 12/16, 650.
- `caption`: metadata only, 11/16, 500.
- `metric`: dashboard numbers, 36/40 or 40/44, 700.
- `code`: Geist Mono, 13/20.

Rules:

- Use `Text`, `Kicker`, and `SectionHeader` from `DesignSystem.tsx` for new work.
- Use `body` or `bodySm` for most explanatory copy.
- Keep uppercase labels short and route them through `Kicker`.
- Do not use negative letter spacing.
- Avoid arbitrary type classes such as `text-[1.2rem]`, `text-[1.65rem]`, `text-[3.85rem]`, and custom tracking values.

## Icons

Use `lucide-react` only. Do not add custom inline SVGs for standard actions.

Rules:

- Standard icon size: 16px for compact controls, 20px for normal controls, 24px for feature marks.
- Use icons inside buttons for common commands: create, save, download, open, close, search, filter, regenerate, expand, play.
- Pair unfamiliar icons with visible text or a tooltip.
- Keep icon stroke visually aligned with text weight. Avoid mixing filled emoji-style icons with Lucide.

## Spacing And Layout

Primitive spacing scale:

- `1`: 4px
- `2`: 8px
- `3`: 12px
- `4`: 16px
- `5`: 20px
- `6`: 24px
- `8`: 32px
- `10`: 40px
- `12`: 48px
- `16`: 64px
- `20`: 80px
- `24`: 96px

Semantic web spacing:

- Page shell inline padding: 16px mobile, 24-40px desktop via `studio-shell`.
- Section gap: 48px desktop, 32px mobile.
- Panel padding: 16px small, 20px medium, 24px large.
- Card internal gap: 12px or 16px.
- Button gap: 8px.
- Grid gap: 16px compact, 24px roomy.

Rules:

- New fixed-format UI must use stable dimensions with responsive constraints.
- Media grids should preserve aspect ratio to prevent layout shift.
- Do not put UI cards inside other decorative cards.
- Page sections should be full-width bands or unframed layouts; cards are for repeated items, tools, and modals.

## Color And Surfaces

Core tokens:

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

- Image: sky `#38bdf8`
- Video: rose `#fb7185`
- Motion: violet `#a78bfa`
- Workflow: emerald `#34d399`
- Commerce: amber `#f59e0b`
- Danger: rose `#fb7185`

Rules:

- Surfaces should be dark, low-noise, and layered by border and alpha, not random shadows.
- Gradients are allowed for media preview fills and accent washes only.
- Avoid decorative orbs, bokeh blobs, and purely atmospheric backgrounds.
- Keep media visible and inspectable.

## Radius And Elevation

Radius scale:

- `sm`: 8px
- `md`: 12px
- `lg`: 16px
- `xl`: 20px
- `2xl`: 24px
- `pill`: 999px

Rules:

- Cards and panels should normally use 20px or 24px.
- Buttons and pills use `pill`.
- Media frames use 16px or 20px.
- Modals use 24px.
- Avoid arbitrary `rounded-[...]` values.
- Use tokenized shadows only. Most surfaces need no shadow.

## Components

Use these primitives for new or migrated UI:

- `Text`: semantic typography role.
- `Kicker`: short uppercase metadata.
- `SectionHeader`: section heading, body, optional action.
- `Surface`: reusable panel/card shell.
- `Button`: primary, secondary, ghost, or accent action.
- `IconButton`: icon-only action with required accessible label.
- `Pill`: compact metadata and filters.
- `MediaFrame`: image/video/aspect-ratio wrapper.
- `StatusCallout`: empty, success, warning, and error messages.

Buttons:

- Primary CTA: white or accent fill, high contrast.
- Secondary CTA: bordered dark surface.
- Ghost CTA: transparent hover surface for toolbars.
- Minimum height: 40px compact, 44px default, 48px major CTA.
- Include Lucide icons where the action benefits from recognition.

Cards:

- Use `Surface` or `.ui-card`.
- Keep one clear visual hierarchy: media, title, summary, action.
- Do not invent a new card background for each feature.

Panels:

- Use `.ui-surface` or `.ui-surface-soft`.
- Panel title should use `sectionTitle` or `cardTitle`, not hero type.

Modals:

- Modal panel uses 24px radius, strong border, high z-index, and stable internal spacing.
- Primary and dismiss actions must be reachable by keyboard.

## Page Patterns

Home:

- First viewport should show creator paths immediately.
- Keep the hero compact; no marketing-only hero before the tool choices.
- Use media previews in creator cards whenever available.

Create launchpad:

- Page title, short body, tool pills, then creator cards.
- Quick-start recipe cards use `Pill`, `Surface`, and consistent card title/body roles.

Creator Studio:

- Use the same section header, card, button, and media frame rules across image, video, motion, workflow, and commerce.
- Avoid local accent maps unless they call shared accent utilities.
- Generator controls should feel like a focused workspace, not a landing page.

Feature landing pages:

- H1 should state the feature or literal offer.
- CTA pair should use shared `Button`.
- Benefit and step cards should use shared `Surface`.
- Avoid split decorative hero cards that hide the actual product context.

Showcase and feed:

- Media comes first.
- Masonry or grid layout must use consistent gutters.
- Save/open/view actions should use Lucide icon controls with visible labels where helpful.

Workflow chrome:

- Persistent app shell, side nav, command/search, bottom nav, and headers use shared panel tokens.
- Avoid one-off nav item sizes and hover surfaces.

## Avoid Checklist

Do not add these in new UI:

- Arbitrary text classes: `text-[...]`.
- Arbitrary radii: `rounded-[...]`.
- Arbitrary tracking: `tracking-[...]`.
- Raw border alpha repeats: `border-white/10`, `border-white/8`, unless inside a shared primitive.
- Raw surface repeats: `bg-white/[0.03]`, `bg-white/5`, unless inside a shared primitive.
- Raw gradients for buttons/cards.
- Random shadows such as `shadow-[...]` outside shared utilities.
- One-off CTA, pill, and card class bundles.
- Inline SVGs when a Lucide icon exists.
- Hero-scale type inside compact panels or cards.

## Migration Rule

When touching a file, migrate the touched surface toward shared primitives. Do not attempt a full redesign unless requested. Consistency should improve incrementally without changing product behavior.
