# Magicbooklet Design System Index

Use this file as the first stop for UI and UX work. Open the platform guide that matches the surface you are changing, then use the long research note when you need the reasoning behind the rules.

- [Web UI/UX guide](./design-web.md): Next.js, Tailwind v4, Geist, Lucide, the public/signed-in CSS split, the app shell, the feed, Explore, post pages, creator pages, marketing pages, and web primitives.
- [Mobile UI/UX guide](./design-mobile.md): Expo, React Native, both schemes, `appTheme`, `components/ui.tsx`, the tests that enforce the HIG floors, the dock, overlays, feeds, the reel, and touch controls.
- [Research source](./ui-consistency-research-2026-06-14.md): Pinterest Gestalt, Material 3, Apple HIG, Shopify Polaris, Atlassian, and the June 2026 Magicbooklet audit.

Shared north star: Magicbooklet should feel like a premium AI creator studio — dark on the web, and on mobile the phone's own light or dark (the reel stays dark in both; `design-mobile.md` → Color). The product is media-led, fast to output, and consistent through shared tokens, Lucide icons, strict spacing, stable type roles, and reusable primitives.

Both guides were rewritten against the code on 2026-09-24. Where a guide and the code disagree, the code wins. A PR that changes a token, a primitive or a page pattern a guide describes updates that guide in the same commit, so the two stay in step.

Do not duplicate full design rules here. Keep this file as an index so future agents know where to look.
