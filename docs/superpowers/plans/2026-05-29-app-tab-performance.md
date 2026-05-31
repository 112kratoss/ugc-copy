# App Tab Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce global tab-loading cost and improve perceived responsiveness across the main app tabs.

**Architecture:** Use build-manifest and browser evidence to find shared JS and route-transition costs. First split global Supabase and Framer Motion work into deferred client islands, then add route loading states and targeted tab/data improvements as evidence identifies them.

**Tech Stack:** Next.js 16 App Router, React 19, Vitest, Testing Library, Browser/Playwright validation.

---

### Task 1: Defer Global Shell Islands

**Files:**
- Create: `src/app/components/AppShellAccount.tsx`
- Create: `src/app/components/DeferredAppShellAccount.tsx`
- Create: `src/app/components/DeferredGenerationNotifications.tsx`
- Create: `src/__tests__/deferred-app-shell-islands.test.tsx`
- Modify: `src/app/components/AppShellClient.tsx`
- Modify: `src/app/layout.tsx`

- [x] **Step 1: Write failing tests**

Add tests that mock `next/dynamic`, capture `requestIdleCallback`, render the deferred account and notifications wrappers, assert their dynamic children are absent before idle, then flush idle and assert they render.

- [x] **Step 2: Verify red**

Run: `npm test -- src/__tests__/deferred-app-shell-islands.test.tsx`

Expected: FAIL because the deferred wrapper components do not exist.

- [x] **Step 3: Implement deferred islands**

Move Supabase session/profile/account menu logic from `AppShellClient.tsx` into `AppShellAccount.tsx`. Add tiny wrappers that load `AppShellAccount` and `GenerationNotifications` after `requestIdleCallback` or a timeout fallback. Keep the app shell nav and page content immediately renderable.

- [x] **Step 4: Verify green**

Run: `npm test -- src/__tests__/deferred-app-shell-islands.test.tsx`

Expected: PASS.

- [x] **Step 5: Compare build evidence**

Run: `npm run build`, then inspect `.next/server/app/page_client-reference-manifest.js`.

Expected: `src/app/layout` no longer includes the Supabase-heavy `068059...` chunk or Framer-heavy `6d837...` chunk.

### Task 2: Add Route-Level Loading Feedback

**Files:**
- Create: `src/app/create/loading.tsx`
- Create: `src/app/creations/loading.tsx`
- Create: `src/app/showcase/loading.tsx`
- Create: `src/app/marketplace/loading.tsx`
- Create: `src/app/profile/loading.tsx`
- Create: `src/app/create-workflow/loading.tsx`

- [x] **Step 1: Implement loading shells**

Use existing dark creator-studio classes and skeleton blocks to show immediate, stable UI for the main bottom/sidebar tabs while each server segment resolves.

- [x] **Step 2: Verify build**

Run: `npm run build`

Expected: build remains green and routes list the new loading segments without runtime errors.

### Task 3: Browser Profile Main Tabs

**Files:**
- Modify only files identified by the browser/profile evidence.

- [x] **Step 1: Start production server**

Run: `npm run start` after a successful build.

- [x] **Step 2: Browser smoke test**

Test the flow: app loads -> navigate Home, Create, Studio, Showcase, Marketplace, Profile, Workflow -> first meaningful content or loading shell renders without console errors.

- [x] **Step 3: Fix next evidence-backed bottleneck**

If the browser evidence shows a remaining slow tab, add one focused failing test or measurable check before the next production change, then implement the narrow fix and rerun build/browser checks.

### Completed Analysis

The route-manifest audit showed three main first-load problems:

- Global shell UI pulled authenticated account/notification work into every route.
- Authenticated tabs imported Supabase browser client in first-load paths where the layout/session state was already enough.
- Studio and Showcase paid for Framer Motion on initial tab load for simple opacity/slide wrappers and modal transitions.

Implemented changes:

- Deferred app-shell account and generation notification islands until idle.
- Added route-level loading shells for Create, Studio, Showcase, Marketplace, Profile, and Workflow Canvas.
- Deferred the home showcase preview grid until idle.
- Lazy-loaded the browser Supabase client inside `AuthProvider`.
- Removed direct Supabase session refreshes from Studio and publish-modal first-load paths.
- Deferred the heavy Profile editor behind a small profile fallback.
- Replaced first-load Framer Motion usage in Studio, Showcase, and shared preview/publish modals with CSS/static markup.

Final app-tab client-reference payloads from the optimized production build:

| Tab | Final upfront JS |
| --- | ---: |
| Home | 61.6 KiB |
| Create | 63.4 KiB |
| Studio | 151.8 KiB |
| Showcase | 126.8 KiB |
| Marketplace | 101.4 KiB |
| Profile | 81.3 KiB |
| Workflow Canvas | 63.6 KiB |

Largest measured reductions during this pass:

| Tab / surface | Before | After |
| --- | ---: | ---: |
| Studio | 482.5 KiB | 151.8 KiB |
| Showcase | 257.3 KiB | 126.8 KiB |
| Profile | 274.0 KiB | 81.3 KiB |
| Create | 232.0 KiB | 63.4 KiB |
| Workflow Canvas | 232.0 KiB | 63.6 KiB |
| Marketplace | 270.0 KiB | 101.4 KiB |

Verification record:

- `npm run build`
- `npm test`
- `npm run lint`
- Production browser smoke across Home, Create, Studio, Showcase, Marketplace, Profile, and Workflow Canvas
