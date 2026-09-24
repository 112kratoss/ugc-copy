# Magicbooklet Design System Index

Use this file as the first stop for UI and UX work. Open the platform guide that matches the surface you are changing, then use the long research note when you need the reasoning behind the rules.

- [Web UI/UX guide](./design-web.md): Next.js, Tailwind, Geist, Lucide, landing pages, creator workflows, feed/showcase, modals, and web primitives.
- [Mobile UI/UX guide](./design-mobile.md): Expo, React Native, both schemes, `appTheme`, `components/ui.tsx`, the tests that enforce the HIG floors, the dock, overlays, feeds, the reel, and touch controls.
- [Research source](./ui-consistency-research-2026-06-14.md): Pinterest Gestalt, Material 3, Apple HIG, Shopify Polaris, Atlassian, and the June 2026 Magicbooklet audit.

Shared north star: Magicbooklet should feel like a premium AI creator studio — dark on the web, and on mobile the phone's own light or dark (the reel stays dark in both; `design-mobile.md` → Color). The product is media-led, fast to output, and consistent through shared tokens, Lucide icons, strict spacing, stable type roles, and reusable primitives.

Known gap: the web guide predates the July 2026 community overhaul — Reddit-style feed, threaded comments, text posts, the post overlay, the feed-first home, and the `/admin` console. Trust its tokens and primitives, and verify page patterns against the current code until it is rewritten. The mobile guide was rewritten against the code on 2026-09-24.

Do not duplicate full design rules here. Keep this file as an index so future agents know where to look.
