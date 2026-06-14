# UGC Copy Mobile UI/UX Guide

Audience: AI agents and engineers working in the Expo/React Native mobile app.

Read this before editing `ugc-mobile/**` UI. The long research source is [docs/ui-consistency-research-2026-06-14.md](./docs/ui-consistency-research-2026-06-14.md).

## Product North Star

UGC Copy mobile is the pocket version of a premium dark AI creator studio. It should feel fast, media-led, touch-friendly, and calm. Mobile should share the same product logic as web while respecting safe areas, tabs, thumb reach, and native text scaling.

Use shared mobile tokens and primitives first:

- Tokens live in `ugc-mobile/lib/theme.ts`.
- Primitives live in `ugc-mobile/components/ui.tsx`.
- Use `lucide-react-native` for icons.

## Research Distilled For Mobile

Pinterest Gestalt:

- A media-led feed still needs strict spacing, tokenized color, shared card shapes, and consistent actions.
- Use components as the enforcement layer.

Material 3:

- Mobile layout should use 8dp rhythm for major spacing and 4dp rhythm for details.
- Use semantic color, type, shape, and motion roles.

Apple HIG:

- Respect safe areas and Dynamic Type.
- Keep controls easy to hit.
- Icons and text must align visually and scale cleanly.

Shopify Polaris:

- Name repeated spacing and component roles instead of scattering raw numbers.
- Use semantic text roles and consistent card padding.

Atlassian:

- Avoid tiny critical labels.
- Use existing icons and accessible text.
- Put typography rules in shared components so scale migration is possible.

## Theme Tokens

`appTheme` is the single source for mobile UI values. Keep backward-compatible aliases when expanding it.

Color:

- Background: `#09090b`
- App background/deep black: `#050506`
- Panel: `#111215`
- Panel soft: `#17181d`
- Surface raised: low-alpha white on dark
- Border subtle/default/strong: white alpha at 0.08, 0.10, 0.18
- Text primary: `#fafafa`
- Text secondary: `#d4d4d8`
- Muted: `#a1a1aa`
- Faint: `#71717a`
- Image: `#38bdf8`
- Video/danger: `#fb7185`
- Motion: `#a78bfa`
- Workflow/success: `#34d399`
- Commerce/amber: `#f59e0b`

Spacing:

- `screen`: 16
- `compact`: 8
- `gap`: 12
- `card`: 16
- `panel`: 20
- `section`: 32
- `page`: 48

This means screen padding is 16, compact gaps are 8 or 12, card padding is 16, and section spacing is 32.

Radius:

- `xs`: 8
- `sm`: 12
- `md`: 16
- `lg`: 20
- `xl`: 24
- `pill`: 999

Typography:

- `display`: 34/40, 800
- `pageTitle`: 30/36, 800
- `sectionTitle`: 22/28, 800
- `cardTitle`: 18/24, 800
- `body`: 16/24, 400
- `bodySm`: 14/21, 400
- `label`: 12/16, 700
- `caption`: 11/15, 600
- `button`: 15/20, 800

Use native scalable text unless a very specific visual element is decorative. Critical labels should never be tiny.

## Icons

Use `lucide-react-native` only for standard product actions.

Rules:

- Standard icon size: 18 for compact actions, 20 for normal buttons, 24 for feature marks.
- Icon-only buttons need an accessible label.
- Do not mix custom inline SVG icon styles with Lucide.
- Use familiar symbols for save, open, close, play, download, filter, search, regenerate, expand, and share.

## Touch And Accessibility

Controls:

- Minimum touch target should be around 44-48px.
- Primary buttons use 48px minimum height.
- Icon buttons use 44px minimum width and height.
- Viewer controls must be reachable without precision tapping.

Text:

- Use scalable text.
- Body copy should be 14-16px with readable line height.
- Avoid 10px or 11px labels for anything the user must understand to act.
- Keep contrast readable on media overlays.

Safe areas:

- Use `Screen` and safe-area helpers.
- Main tabs must reserve bottom padding from `getMagicTabBarMetrics`.
- Full-screen viewer controls must account for top and bottom safe insets.

## Components

Use these primitives for new or migrated mobile UI:

- `Screen`: safe-area-aware screen shell with 16px horizontal padding and 32px section gap.
- `AppText`: semantic text role.
- `Kicker`: short uppercase metadata.
- `SectionHeader` and `SectionTitle`: section hierarchy.
- `Card`: default, soft, or interactive surface.
- `PrimaryButton`: main action, 48px minimum.
- `SecondaryButton`: lower-emphasis action.
- `AppTextInput`: labeled input with token radius and border.
- `Pill`: compact label, filter, status, or accent.
- `IconButton`: touch-friendly icon-only action.
- `MediaFrame`: consistent media wrapper.
- `StatusBlock`: empty, success, or error state.
- `Row`: compact horizontal layout.

## Mobile Surface Rules

Main tabs:

- Use `Screen` with `insideTab`.
- Avoid custom per-tab page padding.
- Keep tab content grouped by `SectionHeader` plus cards or feed blocks.

Create flow:

- First screen should show creator paths and quick actions, not a marketing hero.
- Use `Card` for mode choices and prompt panels.
- Use `PrimaryButton` for generation and `SecondaryButton` for supporting actions.
- Keep prompt controls in a stable vertical rhythm.

Showcase/feed:

- Media is the first visual signal.
- Use consistent media frame radius and aspect ratio.
- Feed cards should use 16px padding, 12px internal gaps, and shared action rows.
- Save/view/share actions should use touch-friendly controls.

Viewer:

- Overlay actions need readable contrast on media.
- Keep close, save, share, and download controls in predictable safe-area positions.
- Do not place tiny critical text on top of busy media.

Media frames:

- Use `MediaFrame`.
- Keep aspect ratio stable before media loads.
- Use consistent radius and border.
- Avoid nested decorative cards around media.

Profile/dashboard:

- Metrics use the `metric` or `sectionTitle` role, not arbitrary large text.
- Repeated stats use cards with the same padding and gap.
- Empty states use `StatusBlock`.

Tab surfaces:

- Tab backgrounds and active states come from `appTheme`.
- Do not create a different tab style per screen.

## Avoid Checklist

Do not add these in new mobile UI:

- Raw spacing values that break the 4/8 rhythm, especially 18px screen or section gaps.
- One-off card padding or random border alpha.
- Tiny critical labels below 12px.
- Touch targets below 44px.
- Custom SVGs when a Lucide icon exists.
- Different media frame radius per feed.
- Text over media without contrast protection.
- Decorative gradients or backgrounds that make content harder to scan.

## Migration Rule

When touching a mobile screen, migrate the touched surface to `appTheme` and `components/ui.tsx`. Preserve behavior and navigation. Mobile should share the web design logic, but layout decisions must stay native: safe areas, touch targets, tabs, and scalable text come first.
