---
paths:
  - "**/src/app/**"
  - "**/src/components/**"
  - "**/src/**/*.css"
  - "**/src/proxy.ts"
  - "**/next.config.ts"
---

# Web styling and routing

Moved unchanged from `AGENTS.md` on 2026-10-18 so it loads only where it applies; the core file keeps a summary and points here.

- **CSS split**: `globals.css` is the stylesheet for every route a signed-out visitor can land on (marketing, blog, models, post/creator/referral landings, templates, login/auth); signed-in surfaces add `non-public-utilities.css` via their route layouts. CSS is inlined via `experimental.inlineCss`, which duplicates the sheet per response, so a public route must never import the supplement. The supplement loads later and shares the utilities layer, so a utility it emits outranks every rule of `globals.css` of the same weight, whatever order Tailwind gave the two: its `.hidden` hid the top bar's "New creation" (`md:inline-flex` lived only in `globals.css`), and its `h-8` beat the reel's `lg:h-px` on the profile, with some forty hover and breakpoint rules like it across the shell and the shared components. So the supplement scans everything its routes can draw, the components they share with the public routes and the root layout's shell included: that makes it complete for those routes, and its own order decides. `route-style-readiness.test.ts` pins which directories belong to which sheet and holds each sheet's source list to its import closure, file for file (a public folder's file that a signed-in route draws is named one by one, and a bracketed folder such as `[id]` is written `*`, because the glob that reads `@source` takes brackets for a set of letters and the line would match nothing). `route-style-two-sheet-order.test.ts` compiles both sheets and fails on any pair of classes where the supplement overrules a rule it does not hold. The `.app-shell-*` and `.home-*` named classes in `globals.css` are the earlier fix for the same fault and stay.
- **Rewrites defeat route interception**: the signed-in `/` is served through a rewrite to `/home` in `src/proxy.ts` (nothing in `next.config.ts`; `/feed`, `/showcase` and `/marketplace` are ordinary routes), and Next route interception (the post-overlay pattern) never fires on a rewritten path — plan overlay UX accordingly.
