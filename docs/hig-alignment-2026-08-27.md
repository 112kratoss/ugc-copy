# HIG Alignment Program — started 2026-08-27

Living tracker for auditing **every surface of the mobile app** (`ugc-mobile/`) against Apple's
[Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) and landing
the fixes — visuals, layout, text, motion, haptics, transitions, and states. Update the status board and
finding log in the same commit as the fixes (same convention as `scaling-audit.md`).

Companion lenses when fixing (not auditing): the `emil-design-eng` skill, `design-mobile.md`
(tokens/primitives only — page patterns are stale), and the token system in `ugc-mobile/lib/theme.ts`.

## How to read the HIG (verified mechanism)

The HIG website is a JS SPA — plain fetches of page URLs return nothing. The content backend works:

```
https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json
```

`<slug>` is the kebab-case page title (`motion`, `tab-bars`, `in-app-purchase`, …). Returns the full,
current guidance text (verified 2026-08-27; pages carry Liquid Glass-era updates from Sept 2025).
Category indexes for enumerating children: `foundations`, `patterns`, `components` (then `content`,
`layout-and-organization`, `menus-and-actions`, `navigation-and-search`, `presentation`,
`selection-and-input`, `status`, `system-experiences`), `inputs`, `technologies`.

**Rule: never audit from memory.** Each work session starts by fetching the chapters attached to the
unit being audited and distilling their concrete, checkable rules into the finding log entry.

## Method

- **Unit of work** = one *system track* (F/X, app-wide) or one *surface* (S, a screen or overlay).
- **Per-unit loop**: ① fetch & distill the attached HIG chapters → ② capture the surface in the iOS
  Simulator in every state (checklist below) → ③ file findings → ④ fix (systemic fixes land in the
  token/primitive layer, never as per-screen overrides) → ⑤ re-capture + run mobile tests → ⑥ update
  status board.
- **Finding severity**: `V` violation (breaks a HIG rule with real user impact — must fix),
  `D` deviation (differs from platform convention — verdict `fix` or `intentional`; intentional ones
  move to the Divergence ledger with rationale), `P` polish (opportunity, optional).
- **Order**: foundations before screens (a token fix repairs 25 screens at once; per-screen fixes
  before the system is set produce drift), shell before content, core journey before long tail,
  cross-cutting passes last (they need settled screens to sweep).
- **One conversation per phase**, sequential, in the primary checkout (same as scaling work).
- **Android must not fall behind**: parity is a per-unit exit gate, not an afterthought — see the
  *Android parity protocol* below. A unit is not `done` until its Android pass is logged.

### State-capture checklist (step ②)

Capture each that applies: default (signed-in) · guest/anonymous · loading · empty · error ·
keyboard open · long/overflow content (long titles, 0 and 4-digit counts) · Dynamic Type at
XL and AX3 · VoiceOver focus order · Reduce Motion on · Reduce Transparency on · status bar &
home-indicator treatment · interrupted transition (navigate mid-animation) · Android pass per the
*Android parity protocol* (mandatory, not a spot-check, for shell/motion/input changes).

### Mechanics

- Captures: `xcrun simctl io booted screenshot <file>` (the Simulator MCP panel doesn't attach on this
  Mac — memory `ios-simulator-panel-attach-fails`); drive interactions by hand or MCP tap if it works
  headless. Android mechanics: see *Android parity protocol*.
- Settings toggles: `xcrun simctl ui booted appearance …` is N/A (app is dark-only); Dynamic Type via
  Settings app in simulator, or `simctl status_bar` for bar states.
- Many behaviors are pinned by vitest (`__tests__/motion.test.tsx`, `magic-tab-bar*`, showcase cadence
  strings, `tab-navbar-overlap-layout`…). Changing them deliberately = update the test in the same
  commit. Always run `npm test` + `npm run typecheck` in `ugc-mobile/`.
- **Shipping**: HIG fixes reach phones only via a `mobile-store-release` dispatch + store review
  (memory: mobile ships separately). Land phases on `main` continuously; ship in batches (e.g. after
  Phases 1–2, after 3, after 4–6). EAS cloud credits return 2026-09-01; `eas build --local` works now.

## Session workflow (multi-session operation — settled 2026-08-27)

The program runs across many small chat sessions — one phase (or unit) per session — inside a
dedicated worktree, so context stays lean and `main` stays clean. Each session reads only: this doc →
the unit's files → the unit's HIG chapters (JSON fetch). CLAUDE.md already carries the standing HIG
bar (the "Mobile UI is held to Apple's HIG" convention) and auto-loads in every session — never
re-read the codebase broadly or ask for past-chat context.

- **Worktree**: `ugc-app/.claude/worktrees/hig-alignment`, branch `hig-alignment`, based on local
  `main` — which already carries PR #83 (keyboard avoidance + 44pt tap targets + guard tests).
  Future sessions enter it with EnterWorktree **by path** (never let the tool create one itself —
  it bases on origin/main). Commit fixes and this doc's updates together on the branch.
- **Kickoff prompt** — paste this to start every session:
  > Continue the HIG alignment program: enter the worktree at
  > "/Users/athuls/UGC copy/ugc-app/.claude/worktrees/hig-alignment" (EnterWorktree by path), read
  > docs/hig-alignment-2026-08-27.md, and execute the next `todo` unit(s) on the status board
  > following the doc's method and session rules. Verify on both the iOS simulator and the Android
  > emulator before marking anything done.
- **Token discipline**: no subagent fan-outs (they multiply context); fetch only the unit's chapters;
  read only the unit's files plus what their imports force; end every session by updating the status
  board + finding log and committing, so the next session needs zero memory of this one.
- **Guard tests are the enforcement mechanism** (pattern set by PR #83): any adopted HIG rule that
  can be expressed numerically/structurally gets encoded into the guard suites —
  `__tests__/hig-type-and-contrast.test.ts`, `hit-target.test.ts` (geometry in `lib/hit-target.ts`),
  `keyboard-avoidance-coverage.test.ts`, `app-text-truncation.test.tsx` — or a new sibling, so every
  later screen inherits it. A red guard is a real violation: fix the control, never the threshold.
  A rule fixed on one screen but not guarded is not "adopted".
- **One design session at a time.** A parallel ui-ux worktree (`.claude/worktrees/work-2026-08-26`)
  has landed mobile UI work on main before. Concurrent mobile-UI sessions in different worktrees
  will conflict — run design sessions sequentially.
- **Metro & simulators from the worktree**: the installed dev clients need no native rebuild — they
  connect to whatever Metro serves :8081. Start `metro-hig` via preview_start (entry in the
  top-level `.claude/launch.json`); only one Metro at a time — stop `metro`/`metro-ui-ux` first.
  iOS simulator connects via localhost, the Android emulator via 10.0.2.2 (env.ts rewrites); both
  platforms verify against the same Metro, per the parity protocol below. The worktree's
  `ugc-mobile/` has `.env.local` copied and `npm install` run; if "Cannot find module" ever appears
  inside packages there, run `npm ci` (corrupt worktree copy).
- **Merging**: at phase boundaries, after `npm test` + `npm run typecheck` pass in the worktree's
  `ugc-mobile/`, ask the user before merging `hig-alignment` → `main` (and never push to `main`
  during an in-flight mobile store release). Store delivery rides the next release train
  (`mobile/version-0.1.1` or successor) via `mobile-store-release`.

## Android parity protocol (D1 — settled 2026-08-27)

Requirement from the user: **Android must not fall behind while this program runs.** One codebase
makes parity the default; these rules protect it at the places it actually breaks:

1. **Parity by construction.** Token/primitive fixes (Phase 1) and screen fixes ship to both
   platforms from the same source. The foundations largely agree across HIG and Material anyway
   (touch floor: HIG 44pt / Material 48dp — our 48 tokens satisfy both; WCAG contrast; OS font
   scaling), so most of the program is platform-neutral by nature.
2. **Dialect tagging.** Every finding carries a platform tag: `both` (default), `ios`, or `and`.
   An `ios`-tagged fix must state its Android counterpart in the same entry — the equivalent
   behavior (e.g. hardware/gesture back where iOS gets swipe-back) or an explicit
   "no-op on Android because <reason>". Guard with `Platform.select`; never let an iOS idiom leak
   (system `Alert` keeps button order native on each platform — custom dialogs would not).
3. **Material 3 as counterpart reference, not a second audit.** Platform-*behavioral* fixes consult
   the matching page on m3.material.io so the Android dialect is deliberate. No parallel full
   Material audit: HIG principles (hierarchy, feedback, restraint, a11y) are platform-neutral and
   the brand carries the visuals on both platforms.
4. **Per-unit Android pass (the gate).** Before a unit is `done`, its changed surfaces are checked on
   the Pixel_9a emulator and logged as `AND-pass <date>` in the finding entry. Checklist:
   edge-to-edge / status-bar bleed (API 35+ forces edge-to-edge; `translucent={false}` is ignored) ·
   keyboard insets (an RN `Modal` on Android reports no keyboard height — input sheets go through
   OverlayHost) · hardware/gesture back works on every screen, no dead ends
   (`lib/use-hardware-back.ts`) · gesture conflicts (Android ScrollView intercepts natively —
   PanResponder needs `scrollEnabled` toggling) · font rendering (single-weight faces fake-bold —
   the `fontWeight:'400'` rule in theme.ts) · no native jank/crashes from animation changes
   (history: mounting BlurView mid tab-fade SIGSEGVs hwui — never mount blur during transitions) ·
   haptic mapping feels right.
   **Mandatory (never skipped) for changes touching:** navigation/transitions, blur/materials,
   keyboard/input, gestures, tab bar — exactly where Android has bitten this codebase before.
5. **X7 Android dialect sweep (Phase 5).** One dedicated full-app emulator pass: back behavior on
   every screen, edge-to-edge/insets everywhere, keyboard on every input surface, notification
   channels and permission flow, haptics, press feedback feel, share sheet. Android's own platform
   rules (edge-to-edge, predictive back) play the role here that the HIG plays on iOS.
6. **Distribution honesty.** Code parity ≠ user parity: iOS is live; Play production access is in
   review (reapplied 2026-08-24) and no production submit path is wired in `mobile-store-release`.
   Wiring Play submission once access lands is tracked on the status board — "not behind" must
   include users' hands, not just the repo.

Emulator mechanics: boot with `-dns-server 8.8.8.8,1.1.1.1`; launch the dev client by force-stop then
deep-link `exp+magicbooklet-mobile://` at `10.0.2.2:8081` (no adb reverse needed); verify gestures via
`adb shell input` (`motionevent` for press-hold-drag, `swipe` for flings; density scale 2.625);
terminal builds need `JAVA_HOME` pointed at Android Studio's JBR (JDK 21); avoid automated taps near
the top-right corner (the dev-launcher bubble swallows them — unit-test those controls instead).

## Decisions (settle before Phase 1 fixes; audit can start meanwhile)

| # | Question | Recommendation | Status |
|---|---|---|---|
| D1 | **Platform scope** — audit is iOS/HIG-first; what does Android get? | One design language everywhere; Android kept current via the **Android parity protocol** above (dialect tags, per-unit Android gate, X7 sweep, Material 3 counterpart checks). No Material redesign. | **settled 2026-08-27** |
| D2 | **Brand vs native** — adopt stock-iOS look, or keep the Obsidian Studio identity and adopt HIG *behaviors & standards*? | Keep the brand (HIG's Branding chapter explicitly endorses this). Adopt system components where the OS is better: share sheet (already used), system context menus, system alerts for destructive confirms. Custom keeps: tab bar, sheets, buttons — audited against the matching chapter's rules. | **settled 2026-08-27** |
| D2a | Iconography — Lucide vs SF Symbols | Keep Lucide app-wide (cross-platform consistency, already systematized); allow SF Symbols only where a glyph carries OS meaning (share, AirPlay). | **settled 2026-08-27** |
| D3 | **Dark-only** — `userInterfaceStyle: dark` is declared; HIG prefers supporting both. | Keep dark-only as an intentional divergence (media-first canvas app); audit the dark palette itself against the Dark Mode chapter (elevation, contrast, materials). | **settled 2026-08-27** |
| D4 | **iPhone-portrait-only** — declared in app.json (`orientation: portrait`, `supportsTablet: false`). | Keep; makes iPad/multitasking/orientation chapters N/A by declaration. Revisit only as a product decision. | **settled 2026-08-27** |

## Divergence ledger (intentional non-conformance)

Every `D` finding whose verdict is `intentional` gets a row. Consistency rule: a divergence must be
applied everywhere or it's a bug, not a choice.

| ID | Divergence | HIG chapter | Rationale | Applied consistently? |
|---|---|---|---|---|
| DV1 | Dark-only appearance (`userInterfaceStyle: dark`) | Dark Mode | Media-first canvas app; the dark palette itself is audited for correctness in F2 (elevation, contrast, materials) | app-wide |
| DV2 | iPhone-only, portrait-only | Layout, Multitasking | Declared in app.json; product decision, revisit only if iPad/rotation becomes a goal | app-wide |
| DV3 | Custom-branded components (tab bar, sheets, buttons) instead of stock controls | Branding + each component chapter | Branding chapter endorses identity; every custom component is still audited against its chapter's *behavior* rules; system surfaces adopted where the OS is better (share sheet, context menus, destructive-confirm alerts) | verify in Phase 6 |
| DV4 | Lucide iconography instead of SF Symbols | SF Symbols, Icons | Cross-platform consistency (D1); glyphs that carry OS meaning (e.g. Share) may borrow the SF shape | app-wide |
| DV5 | The tab bar hides on the Create tab | Tab bars | `creator` is a tab that presents as a modal — full-screen, self-contained, a standard Close rather than a back control — which is the exception Tab bars names ("a modal is temporary and self-contained") | only tab that hides the bar; verify in Phase 6 |
| DV6 | The raised centre control opens a menu instead of switching tabs | Tab bars | "Use a tab bar to support navigation, not to provide actions" — both menu entries navigate to sections (create tab, post composer), so it is navigation via a menu, in the platform-common shape for a creation affordance | single control, app-wide |

## HIG coverage matrix

Every page of the HIG, accounted for: attached to units below, or N/A with a reason.
N/A classes: **[os]** other-platform-only (visionOS/watchOS/tvOS/macOS), **[hw]** hardware the app
doesn't target, **[feat]** feature the app doesn't have (revisit if built), **[decl]** excluded by a
declared scope decision (D4).

**Foundations (18)** — Accessibility→X5 · App icons→S0 · Branding→F6 · Color→F2 · Dark Mode→F2 ·
Icons→F4 · Images→F4 · Immersive experiences [os] · Inclusion→X3/X5 · Layout→F3 · Materials→F2 ·
Motion→X1 · Privacy→X6 · Right to left [feat: no RTL locales shipped — revisit at localization] ·
SF Symbols→F4 (D2a) · Spatial layout [os] · Typography→F1 · Writing→X3.

**Patterns (25)** — Charting data→S20 · Collaboration and sharing→X6 (share paths in viewer, posts,
invite) · Drag and drop→S9/S11 (media reorder) · Entering data→F5 + S9/S11/S15 · Feedback→X4 ·
File management [feat: no document model] · Going full screen→S6 · Launching→S0 · Live-viewing apps
[feat] · Loading→X4 · Managing accounts→S2/S24/S27 · Managing notifications→S26 · Modality→N2 ·
Multitasking [decl D4] · Offering help→S22 · Onboarding→S3 · Playing audio→S6 (video audio: mute,
interruption, background) · Playing haptics→X2 · Playing video→S5/S6 · Printing [feat] ·
Ratings and reviews→S17a · Searching [feat: no search surface today — backlog] · Settings→S16 ·
Undo and redo→S9/S11 (destructive edits) · Workouts [os].

**Components / Content (4)** — Charts→S20 · Image views→F4 + S5/S6/S12 · Text views→F1 + S12 ·
Web views [feat: none embedded].

**Components / Layout & organization (10)** — Boxes [os] · Collections→S5/S8/S10/S21 · Column views
[os] · Disclosure controls→F5 (expanders if any) · Labels→F1 · Lists and tables→S16 + settings-style
screens · Lockups [os] · Outline views [os] · Split views [decl D4] · Tab views→N1.

**Components / Menus & actions (12)** — Activity views→X6 · Buttons→F5 · Context menus→N2 (long-press
on cards/posts — likely gap) · Dock menus [os] · Edit menus→F5 (text selection defaults) ·
Home Screen quick actions→backlog · Menus→N2 (create menu, overflow menus) · Ornaments [os] ·
Pop-up buttons→F5 (model picker idiom) · Pull-down buttons→F5 · The menu bar [os] · Toolbars→N1
(header/nav-bar rules live here in the current HIG — navigation bars were folded into Toolbars).

**Components / Navigation & search (5)** — Path controls [os] · Search fields [feat: backlog] ·
Sidebars→N3 (home/workspace side menus) · Tab bars→N1 · Token fields [os].

**Components / Presentation (8)** — Action sheets→N2 (viewer-action-sheet) · Alerts→N2 (system
`Alert.` used in several files — audit copy & button order) · Page controls→S6 (multi-slide posts) ·
Panels [os] · Popovers [decl D4: iPad idiom] · Scroll views→F3 (indicators, insets, bounce,
keyboard avoidance) · Sheets→N2 (comments, feedback, action sheets: detents, grabber, dismissal) ·
Windows [os].

**Components / Selection & input (11)** — Color wells [feat] · Combo boxes [os] · Digit entry views
[feat] · Image wells [os] · Pickers→F5 + S9 (model/aspect pickers) · Segmented controls→F5 ·
Sliders→F5 (if any params use them) · Steppers [feat] · Text fields→F5 + forms · Toggles→F5 + S16 ·
Virtual keyboards→F5 (types, return keys, avoidance).

**Components / Status (4)** — Activity rings [os] · Gauges [feat] · Progress indicators→X4 +
S9/S10/S21 (generation progress is the app's hero wait) · Rating indicators [feat].

**Components / System experiences (10)** — App Shortcuts→backlog · Complications [os] · Controls→
backlog · Live Activities→backlog (generation progress is a natural fit) · Notifications→S26 ·
Snippets→backlog · Status bars→N1/S6 · Top Shelf [os] · Watch faces [os] · Widgets→backlog.

**Inputs (13)** — Action button→backlog · Apple Pencil and Scribble [decl D4] · Camera Control→
backlog [hw] · Digital Crown [os] · Eyes [os] · Focus and selection [os] · Game controls [feat] ·
Gestures→N2 + S6 (swipe-back integrity, double-tap, dismiss gestures, edge conflicts) · Gyroscope and
accelerometer [feat] · Keyboards→F5 (hardware kb [decl]) · Nearby interactions [feat] · Pointing
devices [decl D4] · Remotes [os].

**Technologies (29)** — relevant: Generative AI→S9/X3 (expectation-setting, provenance, failure UX) ·
In-app purchase→S17/S18/S19 · Machine learning→S9 · Sign in with Apple→S2 · Siri→backlog ·
VoiceOver→X5 · Live Photos [feat] · Photo editing [feat: no system editing extension] ·
Apple Pay [feat: IAP only]. N/A [feat/os]: AirPlay (revisit if video casting), Always On, App Clips,
Augmented reality, CareKit, CarPlay, Game Center, HealthKit, HomeKit, iCloud, ID Verifier, iMessage
apps and stickers, Mac Catalyst, Maps, NFC, ResearchKit, SharePlay (revisit for co-creation),
ShazamKit, Tap to Pay, Wallet.

Also read once in Phase 0: **Getting started · Design principles · Designing for iOS** (orientation
for the whole program).

## Surface inventory

Shell: `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `components/magic-tab-bar.tsx`,
`components/magic-create-menu.tsx`, `components/home-side-menu.tsx`,
`components/workspace-side-menu-gesture-layer.tsx`, `lib/tab-bar-layout.ts`, `lib/safe-area.ts`.

| ID | Surface | Entry points |
|---|---|---|
| S0 | Icon → splash → first frame → update gate | app icon assets, splash config, `lib/startup-readiness.ts`, `app/update-required.tsx` |
| S1 | Not-found / deep-link recovery | `app/+not-found.tsx`, `app/r/[code].tsx` |
| S2 | Auth | `app/auth.tsx`, apple/google auth libs |
| S3 | Onboarding | `app/onboarding.tsx`, `onboarding-booklet/-welcome/-resume-card` |
| S4 | Home | `app/(tabs)/index.tsx`, `home-dashboard`, `home-feed-card`, side menu |
| S5 | Showcase feed | `app/(tabs)/showcase.tsx`, `showcase-media-preview`, `feed-*`, `save-heart` |
| S6 | Immersive viewer | `app/showcase/[id].tsx`, `app/viewer.tsx`, `top-scrim`, `double-tap-pressable`, `reel-overlay`, `media-lightbox` |
| S6a | Viewer action sheet | `components/viewer-action-sheet.tsx` |
| S6b | Comments sheet | `components/comments-sheet.tsx` |
| S6c | Feed feedback sheet | `components/feed-feedback-sheet.tsx` |
| S7 | Unlock screen + remix prompt | `app/unlock/[unlockId].tsx`, `app/unlocks.tsx`, `unlock-remix-prompt` |
| S8 | Create hub | `app/(tabs)/creator.tsx`, `magic-create-menu` |
| S9 | Creation tool | `app/create/[tool].tsx`, `media-creation-screen`, `media-preview`, `composer-media-lightbox` |
| S10 | Studio | `app/(tabs)/studio.tsx`, `studio-feed-view-model` |
| S11 | Post composer | `app/post/new.tsx` |
| S12 | Post details | `app/post/[id].tsx`, `post-details-page`, `post-text-block`, `post-resource-*` |
| S13 | Profile tab | `app/(tabs)/profile.tsx`, `profile-dashboard`, `profile-feed-card`, `app/profile-media-feed.tsx` |
| S14 | Creator profile | `app/creators/[username].tsx`, `creator-profile-screen` |
| S15 | Edit profile | `app/edit-profile.tsx`, `edit-profile-screen` |
| S16 | Settings + help | `app/settings.tsx`, `app/help.tsx` |
| S17 | Pricing / credits | `app/(tabs)/pricing.tsx`, `pricing-view-model`, IAP libs |
| S17a | Ratings prompt policy | (whenever review requests exist/are added) |
| S18 | Marketplace asset | `app/marketplace/[assetId].tsx` |
| S19 | Templates | `app/templates/index.tsx`, `[slug].tsx`, `app/template-runs/[runId].tsx`, `media-template-screens` |
| S20 | Seller dashboard | `app/seller-dashboard.tsx` |
| S21 | Invite / referral | `app/invite.tsx` |
| S22 | Help content | `app/help.tsx` |
| S24 | Delete account | `app/delete-account.tsx` |
| S26 | Notifications & badging | `lib/notifications.ts`, permission prompt flow |
| S27 | Guest merge banner | `components/guest-merge-banner.tsx` |

## Phases

### Phase 0 — Orientation & baseline (no fixes)
1. Read Getting started, Design principles, Designing for iOS. 2. Baseline capture: walk every surface
in the simulator, screenshot default+one alternate state each (keep in session scratchpad; findings are
recorded textually so nothing depends on stale images). 3. Settle D1–D4 with the user. 4. Seed the
finding log with freebies already visible (e.g. splash `#09090b` vs app ground `#000000/#070708` —
launch-to-home color jump; `Alert.` copy/button-order audit list).

### Phase 1 — Foundations (system tracks; fixes land in tokens/primitives)
| Track | Scope | Chapters |
|---|---|---|
| F1 | Type ramp, Dynamic Type strategy (fixed px + fixed lineHeights today; decide scaling policy), truncation, min sizes | Typography, Labels, Text views |
| F2 | Palette vs Dark Mode rules (elevation, contrast ratios, vibrancy), scrims/blur vs Materials, splash/ground mismatch | Color, Dark Mode, Materials |
| F3 | Safe areas, margins, grid, scroll behavior (insets, indicators, keyboard avoidance) | Layout, Scroll views |
| F4 | Icon usage, sizes, weights, image handling (aspect, placeholders, alt) | Icons, SF Symbols, Images, Image views |
| F5 | Control inventory vs component rules: buttons, text fields, toggles, pickers, segmented controls, keyboards (types/return keys), edit menus, touch targets (44pt HIG floor vs our 48pt tokens — verify *usage*, not just tokens) | Buttons, Text fields, Toggles, Pickers, Segmented controls, Sliders, Virtual keyboards, Keyboards, Edit menus, Pop-up/Pull-down buttons, Entering data |
| F6 | Where brand may/must-not override system (per D2) | Branding, Design principles |

**Already landed on main (PR #83, 2026-08-27, before this program's Phase 1):** keyboard avoidance
rebuilt app-wide, hit targets brought to ≥44pt (`lib/hit-target.ts`), 11pt type floor, 4.5:1 body
contrast, truncation checks — all pinned by guard tests. F1/F2/F3/F5 therefore start by **verifying
and extending** those guards against the full chapter text, not by redoing the work. Still open
there: Dynamic Type scaling policy (F1), materials/scrims (F2), safe-area/grid sweep (F3), the
non-geometric control rules (F5: keyboard types, return keys, edit menus, picker idioms).

### Phase 2 — Navigation shell & modality
| Track | Scope | Chapters |
|---|---|---|
| N1 | Tab bar (magic-tab-bar): items, labels, badging, reselect-scroll-top, create-button idiom; headers/toolbars; status bar & home indicator | Tab bars, Tab views, Toolbars, Status bars |
| N2 | **Modality map**: classify every route/overlay as push / sheet / full-screen / overlay and justify against Modality rules; sheet anatomy (detents, grabber, swipe-dismiss, background dim); alerts & action sheets (copy, button order, destructive placement); menus; context-menu gaps; gesture integrity (swipe-back everywhere, conflicts in viewer/side-menu) | Modality, Sheets, Action sheets, Alerts, Menus, Context menus, Gestures |
| N3 | Side menus (home + workspace edge-swipe) vs Sidebars guidance; transition motion of the shell (tab cross-fade, push timing) | Sidebars, Motion |

### Phase 3 — Core journey surfaces (audit+fix per surface)
Order: S5 → S6/S6a/S6b/S6c → S9 → S8 → S11 → S12 → S10 → S4 → S13/S14. Each uses its chapter set
from the coverage matrix. S6 is the deepest: full-screen rules, video (controls, audio interruption,
mute state), page controls, gestures, scrims/legibility, share.

### Phase 4 — Account, commerce & long tail
S2 (Sign in with Apple button rules!), S3, S15, S16, S17 (In-app purchase chapter: pricing clarity,
restore, receipts), S7, S18, S19, S20, S21, S22, S24 (deletion flow rules), S26 (notification
permission timing, copy, badge hygiene), S0, S1, S27.

### Phase 5 — Cross-cutting passes (whole app, one dimension at a time)
| Pass | Scope | Chapters |
|---|---|---|
| X1 | Motion inventory: every transition/animation vs purpose/brevity/interruptibility; Reduce Motion parity (`lib/motion.ts` covers presses — verify navigation & custom animations too) | Motion |
| X2 | Haptic vocabulary audit (`lib/haptics.ts` semantics are good — verify coverage & restraint at call sites) | Playing haptics |
| X3 | Writing: every user-facing string — tone, casing (sentence-case UI), buttons say what they do, error copy says what to do next; Generative AI language rules | Writing, Inclusion, Generative AI |
| X4 | Feedback & waiting: loading (skeleton vs spinner vs progress), empty, error, offline, success states everywhere; generation progress as the hero wait | Feedback, Loading, Progress indicators |
| X5 | Accessibility: VoiceOver walkthrough of every surface (labels, traits, order, announcements), Dynamic Type AX sizes, contrast audit, Reduce Transparency, touch-target sweep | Accessibility, VoiceOver, Inclusion |
| X6 | System integration: share sheets everywhere sharing exists, privacy strings, permission prompt timing, Settings deep-links | Collaboration and sharing, Activity views, Privacy |
| X7 | **Android dialect sweep**: full-app emulator pass per parity protocol item 5 | Material 3 counterparts; Android edge-to-edge & predictive-back platform rules |

### Phase 6 — Consistency close-out
Re-walk every surface with the divergence ledger in hand: every intentional divergence applied
consistently; no orphaned pre-alignment patterns; before/after gallery; final store-release batch.

## Native opportunity backlog (from N/A-adjacent chapters; product decisions, not audit debt)
Live Activity for generation progress · Widgets (latest creations / credit balance) · App Shortcuts &
Siri · Home Screen quick actions (New creation) · Control Center control · Search surface (Searching
chapter) · SharePlay co-creation · push-to-start Live Activity for template runs.

## Status board

| Unit | Phase | Status | Findings (V/D/P) | Notes |
|---|---|---|---|---|
| Phase 0 orientation | 0 | done | — | chapters read; baseline walk folded into the per-unit loop (see log) |
| D1–D4 decisions | 0 | done | — | all four settled 2026-08-27 in the Decisions table |
| F1 typography | 1 | partial | — | 11pt floor + truncation guarded (PR #83); Dynamic Type policy open |
| F2 color/dark/materials | 1 | partial | — | 4.5:1 body contrast guarded (PR #83); materials/elevation open |
| F3 layout/safe areas | 1 | partial | — | keyboard avoidance rebuilt + guarded (PR #83); safe-area/grid sweep open |
| F4 iconography/images | 1 | done | 1V/3D/4P | one stroke weight app-wide; share glyph per platform; size ramp on a ratchet |
| F5 controls/input | 1 | partial | — | ≥44pt hit regions guarded via lib/hit-target.ts (PR #83); non-geometric rules open |
| F6 branding boundary | 1 | done | 1V/1D/3P | the product now spells its own name one way |
| N1 tab bar/toolbars/status bar | 2 | done | 3V/2D/5P | Alerts badge; one Back glyph per platform; every view title bounded and static |
| N2 modality map/sheets/alerts/gestures | 2 | todo | — | |
| N3 side menus/shell motion | 2 | todo | — | |
| S5 showcase feed | 3 | todo | — | |
| S6+S6a/b/c viewer & sheets | 3 | todo | — | |
| S9 creation tool | 3 | todo | — | |
| S8 create hub | 3 | todo | — | |
| S11 post composer | 3 | todo | — | |
| S12 post details | 3 | todo | — | |
| S10 studio | 3 | todo | — | |
| S4 home | 3 | todo | — | |
| S13/S14 profiles | 3 | todo | — | |
| S2 auth | 4 | todo | — | |
| S3 onboarding | 4 | todo | — | |
| S15 edit profile | 4 | todo | — | |
| S16 settings/help | 4 | todo | — | |
| S17(+a) pricing/IAP/ratings | 4 | todo | — | |
| S7 unlocks | 4 | todo | — | |
| S18 marketplace | 4 | todo | — | |
| S19 templates | 4 | todo | — | |
| S20 seller dashboard | 4 | todo | — | |
| S21 invite | 4 | todo | — | |
| S24 delete account | 4 | todo | — | |
| S26 notifications | 4 | todo | — | |
| S0/S1/S27 launch/notfound/guest banner | 4 | todo | — | |
| X1 motion pass | 5 | todo | — | |
| X2 haptics pass | 5 | todo | — | |
| X3 writing pass | 5 | todo | — | |
| X4 feedback/loading pass | 5 | todo | — | |
| X5 accessibility pass | 5 | todo | — | |
| X6 system integration pass | 5 | todo | — | |
| X7 android dialect sweep | 5 | todo | — | |
| Play submit path in mobile-store-release | — | blocked | — | release-eng, not HIG; unblocks when Play production access approves |
| Phase 6 close-out | 6 | todo | — | |

## Finding log

Append per unit as audited. Format:

```
### <Unit> — audited YYYY-MM-DD · AND-pass: <date or pending>
Chapters read: <list, with slugs>
- [V|D|P][both|ios|and] <finding> — <HIG rule it maps to> → <fix | intentional (→ ledger) | deferred>
  (ios-tagged fixes: state the Android counterpart or an explicit no-op + reason)
```

### Seed observations (pre-audit, verify in Phase 0)
- [P] Splash background `#09090b` ≠ app ground (`#000000`/`#070708`) — visible color jump at launch —
  Launching/Color → candidate F2.
- [D] System `Alert.` usage in ~6 files — audit copy, button order (default action on the right,
  destructive marked), and whether each belongs as an alert vs sheet — Alerts → N2.
- [D] Fixed `fontSize`/`lineHeight` px ramp in `lib/theme.ts` with no Dynamic Type policy — Typography/
  Accessibility → F1 (decide: scale with `PixelRatio.getFontScale` caps vs opt-out — an explicit call).
- [P] No context menus on content cards (long-press) — Context menus → N2 opportunity list.

### Phase 0 orientation — audited 2026-08-27 · AND-pass: n/a (no code change)
Chapters read: Getting started (`getting-started`), Design principles (`design-principles`),
Designing for iOS (`designing-for-ios`).

The three orientation chapters set the bar the rest of the program measures against. The ones that
bite this app hardest: **Agency** ("help people recover from mistakes" → N2's destructive confirms,
the undo story in S9/S11), **Familiarity** ("once you establish a behavior or appearance for an
element, apply it throughout" → the consistency rule this program is mostly enforcing), **Simplicity**
("establish hierarchy"), and iOS's own "adapt seamlessly to appearance changes — like device
orientation, Dark Mode, and Dynamic Type", which is the open F1 question. Design principles was
reintroduced to the HIG on 8 June 2026, so it is new material, not a re-read.

- [P][both] **Baseline walk deliberately narrowed.** Phase 0 step 2 called for a screenshot walk of
  all 28 surfaces before any fix. Skipped as written: the per-unit loop's step ② captures each
  surface at the moment it is audited, against the code as it stands then, so a pre-walk produces
  images that are stale before they are read — and the method already records findings textually so
  nothing downstream depends on them. What ran instead: Home, Showcase, Settings and the immersive
  viewer captured on **both** platforms while auditing F4/F6. Cost of the shortcut: freebies visible
  only on surfaces no unit has reached yet (S3, S7, S17–S24) surface later than they would have.
  Re-open this if Phase 3 keeps finding things a walk would have caught early.

### F4 iconography & images — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Icons (`icons`), SF Symbols (`sf-symbols`), Images (`images`), Image views
(`image-views`).

Rules taken from them, in checkable form: one consistent size, level of detail, stroke thickness and
perspective across the whole icon set · icon weight matches adjacent text weight · a selected-state
icon only when necessary · alternative text labels on every interface icon · vector format for
interface icons · the published table of standard symbols for common actions (Share, More, Delete,
Add, Close, Search…) · @2x/@3x for bitmaps, vector for flat art · take care overlaying text on
images (contrast, shadow or background layer).

- [V][both] **The icon set rendered at eleven different stroke weights.** 300 lucide icons: 194
  carried no `strokeWidth` at all (Lucide's default 2), 106 carried one of ten hand-picked values
  between 2 and 3. Same nominal size, different weights — six of them at 18pt alone — and because
  Lucide scales stroke with size, apparent weight ran from 1.20pt to 3.40pt across the app.
  Icons: "all interface icons in your app need to use a consistent size, level of detail, stroke
  thickness (or weight), and perspective" → **fixed**: `appTheme.icon.stroke` (2.2, the weight the
  shipped `IconButton`/`Pill` primitives had already chosen), supplied once by a `LucideProvider` at
  the root of `app/_layout.tsx`; every per-site weight deleted. Guarded by
  `__tests__/hig-icon-weight.test.tsx`, which renders a real icon under the provider and asserts the
  weight it resolves, then sweeps the source for any element setting its own.
  - Note: lucide-react-native 1.14.0 re-exports a `LucideProvider` that its context module never
    defines, so the import lands `undefined`. `patches/lucide-react-native+1.14.0.patch` restores it
    (~10 lines, both builds). The guard's second test asserts an un-provided icon still renders at
    lucide's own default of 2 — lose the patch and that is what the first test would silently see, so
    the patch failing to apply turns the suite red instead of quietly reverting the app's icon weight.
- [D][both] **Selection was being said a fourth time, in stroke weight.** The tab bar drew the active
  item at 2.5 against 2.1, and the pricing plan row at 2.5 against 2 — on top of a colour change, a
  scale spring, an indicator bar (tab bar) and a `Circle`→`CheckCircle2` glyph swap (pricing).
  Icons: "Provide a selected-state version of an interface icon only if necessary … the system
  updates the visual appearance of the selected state automatically" → **fixed**: the weight signal
  dropped, the three signals that already carried it kept.
- [D][ios] **Share wore Material's glyph on iOS.** All seven share affordances used lucide's
  `Share2`, the node graph. The Icons chapter's standard-symbol table gives Share as
  `square.and.arrow.up` → **fixed**: `lib/platform-glyphs.ts` exports one `ShareGlyph` that resolves
  to lucide `Share` (the tray with the rising arrow) on iOS. **Android counterpart**: not a no-op —
  Android keeps `Share2`, which *is* Material's share shape, so each platform now shows its own
  dialect from one call site. Verified on both. Consistent with D2a, which allows borrowing the SF
  shape exactly where a glyph carries OS meaning, and names Share as the case.
- [D][both] **25 distinct icon sizes between 11 and 44pt**, against a three-value token scale used at
  3 of 300 call sites. Icons (consistent size) → **partially fixed** (user's call, 2026-08-27):
  `appTheme.icon` now publishes a ramp stepped to the type ramp — 14 `xs` / 16 `sm` / 18 `compact` /
  20 `default` / 24 `feature` / 32 `hero`. Snapping all ~290 call sites in one commit would shift
  icon rhythm on 25 screens at once with no designer in the loop, so adoption is a ratchet instead:
  `__tests__/hig-icon-size.test.ts` records each file's current off-ramp count (180 across 33 files)
  as its budget and fails on any increase. Each surface snaps to the ramp when Phase 3 audits it, and
  its budget comes down with it. **This unit is `done` with a live remainder** — F4 is not fully
  closed until those budgets reach zero in Phase 3.
- [P][both] Verified clean, now guarded: **every icon-only control already carries an
  `accessibilityLabel`** — 41 of 41 (Icons: "Provide alternative text labels for custom interface
  icons"). The `IconButton` primitive makes the label a required prop, which is why.
- [P][both] Verified clean: **interface icons are already vector** (lucide draws through
  react-native-svg), so Images' @2x/@3x rule doesn't reach them. The seven bitmap assets are single
  high-resolution PNG/JPG that RN downscales; no scale-factor set is missing.
- [P][both] Verified clean: the viewer's `IconShadow` — a darker, thicker copy of a glyph drawn a
  pixel behind it — is a legibility layer over media, which is what Image views asks for ("consider
  ways to make the text object stand out, like adding a text shadow or background layer"), not a
  second icon weight. It now derives its thickness from the token rather than a hardcoded 2.
- [P][both] Standard-symbol table spot-check: More (`MoreHorizontal`/`MoreVertical` → `ellipsis`),
  Add (`Plus` → `plus`), Delete (`Trash2` → `trash`), Close (`X` → `xmark`), Copy, Check all already
  match the published shapes. Share was the only miss.

**AND-pass 2026-08-27** (mandatory: this unit touches the tab bar). Pixel_9a, dev client on the
worktree's Metro. Tab bar icons render at the single weight, tab switching between Home/Showcase/
Alerts fires no `FATAL`/`SIGSEGV` in logcat (the historical BlurView-mid-fade crash), the immersive
viewer's action rail keeps its halo legible over bright media, the share glyph correctly stays
Material's node graph, edge-to-edge and status bar unchanged, hardware back from Settings returns to
Home with no dead end. Nothing in this unit touches keyboard, gestures or fonts.

### F6 branding boundary — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Branding (`branding`), plus Design principles (`design-principles`) from Phase 0.

Rules in checkable form: brand voice and tone in all written communication · an accent colour ·
a custom font that stays legible at all sizes, with the system font for body and captions ·
branding always defers to content · standard patterns in expected locations · no logo scattered
through the app · the launch screen is not a branding opportunity · no Apple trademarks in the name
or images.

- [V][both] **The product spelled its own name three ways.** The wordmark and ~35 strings said
  *Magicbooklet*; ~12 strings said *Magic Booklet*; `app.json`'s store name says *Magic Booklet*; the
  website's `siteConfig` says lowercase *magicbooklet*. `app/auth.tsx` shipped both spellings on one
  screen — the wordmark at the top, "the Magic Booklet terms" in the consent line beneath it.
  Branding: "Use your brand's unique voice and tone in all the written communication you display";
  Design principles/Familiarity: "Once you establish a behavior or appearance for an element, apply
  it throughout your design" → **fixed**: *Magicbooklet* everywhere in mobile copy (user's call,
  2026-08-27), 12 strings rewritten across 7 files. Guarded by `__tests__/hig-branding.test.ts`.
  `app.json`'s `name` deliberately stays "Magic Booklet": that string is the App Store listing and
  the Home Screen label, and it changes through the store, not through a build. **Open**: the same
  three spellings exist on the web app (`src/lib/seo.ts` uses lowercase) — out of this program's
  scope, worth a separate pass.
- [D][both] **Launch screen colour step.** The splash shows the app icon on `#09090b` while the app
  ground is `#000000`. Branding's "avoid using a launch screen as a branding opportunity" is
  *satisfied* — it is a startup-minimising splash, not a brand moment — but the colour step is a
  visible jump at launch → **deferred to F2**, where the seed observation already sits.
- [P][both] Verified clean: **no logo asset is rendered anywhere in the app.** Branding's "resist the
  temptation to display your logo throughout your app" holds. The wordmark appears as *text* in three
  shell surfaces (home header, side menu, onboarding), which is orientation, not decoration.
- [P][both] Verified clean: **the custom face is used exactly as Branding recommends** — Bricolage
  Grotesque carries display/title/metric roles, while body, `bodySm`, label, caption and button stay
  on the system font ("it can work well to use a custom font for headlines and subheadings while
  using a system font for body copy and captions").
- [P][both] Verified clean: one accent colour. `colors.primary` (`#ff7a59`) is the single brand action
  colour, always a solid fill, with semantic colours deliberately distinct from it. React Native gets
  no system accent-colour hook, so the token *is* the accent; nothing to adopt.

### N1 tab bar, toolbars & status bar — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Tab bars (`tab-bars`), Tab views (`tab-views`), Toolbars (`toolbars`),
Status bars (`status-bars`).

Rules in checkable form: a tab bar navigates, it does not act · the bar stays visible when people
move between sections, except under a modal · no overflow/More tab · never disable or hide an
individual tab button · single-word tab labels · a badge is a red oval with white text carrying a
number or an exclamation point, reserved for information that warrants attention · prefer a
monochromatic bar over colourful content · use the standard Back and Close symbols, with no "Back"
text label, and implement a custom one consistently everywhere · a view title is a word or short
phrase, under 15 characters, never the app's name · one primary action, on the trailing side ·
obscure content under the status bar (prefer a scroll edge effect) · never permanently hide the
status bar. **Tab views is N/A** — the chapter is macOS/watchOS only ("Not supported in iOS"); its
iOS pointer is Tab bars, already covered.

- [V][both] **Nothing told you an alert had arrived.** The Studio screen fetched `unreadCount` and
  printed it in its own header; the tab that leads there drew a bare bell, so from Home, Showcase or
  Profile a new notification was invisible. There was no app-icon badge either.
  Tab bars: "Use a badge to indicate that critical information is available … to indicate that
  there's new or updated information in the section that warrants a person's attention" →
  **fixed**: `lib/notification-badge.ts` (pure: cache key, `formatBadgeCount`, `publishUnreadCount`)
  plus `lib/use-notification-badge.ts` (the hook), rendered by `TabBadge` in the tab bar as the
  specified red oval with white text, capped at `99+`. Split in two the way `lib/*-view-model.ts`
  modules are, because reaching `useAuth` drags expo-constants in and the sweep test has no business
  booting Expo. The badge polls `limit: 1` on a 60s `staleTime` rather than sharing Studio's 50-item
  query — the bar is mounted for the whole session, and re-fetching 50 rows from every tab for one
  integer is exactly the idle egress this backend cannot spend (memory:
  `supabase-egress-is-the-scaling-wall`); Studio pushes its own fresher count across on load and
  after every mark-read, so the number drops while the user watches instead of a minute later.
  - `appTheme.colors.badge` (`#ff3b30`) / `onBadge` are the one pair in the palette the platform
    chooses rather than the brand: the badge only reads as a badge in the system's red, and drawing
    it in coral would also make it vanish against the active tab, which is already coral. The app's
    own `danger` (`#ff7c8b`) is too pale to carry white.
  - The count is repeated in the tab's `accessibilityLabel` ("Alerts, 3 unread") and the oval itself
    is hidden from the reader — a second focus stop reading a bare number says nothing.
  - Placement was wrong on first render and caught only on device: inside the scaled icon wrapper the
    oval grew with the selected-state spring, and its percentage offset resolved against the whole
    tab slot, parking it between Alerts and Profile. It is now a sibling of the content column,
    centred like the indicator bar and walked right by one icon width.
- [V][both] **Back was drawn three different ways in one session.** The native stack header renders
  the system chevron on 13 screens (`headerBackButtonDisplayMode: 'minimal'`); seven screens draw
  their own header, and those used lucide `ArrowLeft` at 20/21/22/24/30 on six of them and
  `ChevronLeft` at 26 on the seventh. On iOS 26 the native back button is a chevron in a glass
  circle, so a full arrow on the next screen contradicts it directly.
  Toolbars: "Use the standard Back and Close buttons … If you create a custom version of either,
  make sure it still looks the same … and ensure you consistently implement it throughout your app"
  → **fixed**: `BackGlyph` joins `ShareGlyph` in `lib/platform-glyphs.ts`, at one size
  (`appTheme.icon.feature`). **Android counterpart**: not a no-op — `ArrowLeft` *is* Material's back
  glyph, so Android keeps the arrow while iOS gets the chevron, one call site, each platform's own
  dialect. Verified on both (iOS chevron / Android arrow in the immersive viewer).
  - Side effect on F4's ratchet: five files shed off-ramp icon sizes, so their budgets in
    `hig-icon-size.test.ts` came down with them (viewer 16→14, post/new 23→22, auth 4→3,
    edit-profile 3→2, post-details 3→2).
- [V][both] **Six view titles broke the Toolbars title rules, and three had no length bound at all.**
  Static offenders: "Magicbooklet invite" (19 chars, and the app's own name — Toolbars forbids both),
  "Template creation" (17), "Seller Dashboard" (16), "Not found" (sentence case among twelve
  title-case siblings). Worse, three screens set their title at runtime from content:
  `` `@${data.profile.username}` `` on the creator profile, and `template?.name` on both the template
  detail and the template run — catalog and user strings with no length bound whatsoever.
  Toolbars: "keep the title under 15 characters long so you leave enough room for other controls";
  "Don't title windows with your app name" → **fixed**: "Your Invite", "Template Run", "Your Sales",
  "Not Found", and the three dynamic titles made static ("Creator", "Template", "Template Run"). Each
  of those screens already prints the entity's name as a `pageTitle` in its own body, so the bar now
  says what the view *is* while the content says what it *contains* — and the title no longer
  flickers from "Creator" to "@username" as the query lands.
  - "Seller Dashboard" was also the label on the two affordances that lead there (side menu, profile
    wallet card) and the screen's own eyebrow; all four moved to "Your Sales" together, which also
    puts it beside "Your Unlocks" in the same menu. A destination whose title disagrees with the row
    that opened it is the Familiarity problem in miniature.
- [D][both] **The tab bar hides itself on the Create tab.** Tab bars: "Make sure the tab bar is
  visible when people navigate to different sections … The exception is when a modal view covers the
  tab bar, because a modal is temporary and self-contained." `creator` is a real tab, but it presents
  as a modal: full-screen, self-contained, with a standard Close (X) rather than a back control, and
  no way to wander deeper. The exception is satisfied in substance → **intentional (→ ledger DV5)**.
  Note for N2: the same screen is *animated* as `simple_push` while wearing a Close button; push-vs-
  modal wants settling in the modality map, not here.
- [D][both] **The create control is an action in a navigation bar.** Tab bars: "Use a tab bar to
  support navigation, not to provide actions." The raised centre button opens a menu rather than
  switching tabs. Its two entries both navigate to sections (the create tab, the post composer), so
  what it provides is navigation via a menu, in the platform-common shape for a creation affordance →
  **intentional (→ ledger DV6)**.
- [P][both] Verified clean: **four single-word tab labels** (Home, Showcase, Alerts, Profile), no
  overflow/More tab possible at any supported width, and no tab button is ever disabled or hidden
  individually. Now guarded, so a fifth tab fails the suite rather than silently creating a More tab.
- [P][both] Verified clean: **reselect scrolls to top on every tab.** All four visible tabs mount
  `useScrollToTop` (`home-dashboard`, `showcase`, `studio`, `profile-dashboard`), and the bar emits a
  cancellable `tabPress` before navigating.
- [P][both] Verified clean: **the bar is monochromatic against colourful content** — white/coral on a
  glass or blurred surface, which is what Tab bars asks for when "your app already has bright,
  colorful content in the content layer".
- [P][both] Verified clean: **status bar treatment.** The four tab screens scroll content to the top
  of the window and each renders `TopScrim`, which fades the strip back to the app ground — the
  custom equivalent of the scroll edge effect the chapter asks for; pushed screens get the system's
  own. Nothing hides the status bar anywhere, permanently or otherwise, so "avoid permanently hiding"
  holds by construction. Both are now guarded.
- [P][both] Verified clean: the native header carries no "Back" text label
  (`headerBackButtonDisplayMode: 'minimal'`), which Toolbars asks for explicitly.

Guard added: `__tests__/hig-navigation-chrome.test.ts` (19 cases) — title length, app-name, casing
and the no-dynamic-titles rule swept across **every** `options={{ … }}` in the tree, not just the
root layout (sweeping only the layout is exactly how a title bound to a catalog name survived);
`BackGlyph` as the only back control and its single size; tab labels, count and badge rules; the
status-bar scrim and no-hidden-status-bar rules. `magic-tab-bar.test.tsx` gains the two rendering
cases the sweep cannot see (oval present/absent, and the count reaching the accessibility label).

**AND-pass 2026-08-27** (mandatory: this unit touches the tab bar and navigation). Pixel_9a, dev
client on the worktree's Metro. Badge renders identically to iOS at the bell's top-right corner; the
back control correctly resolves to Material's arrow where iOS draws the chevron; Home→Showcase→
Alerts→Profile cycled six times with `logcat` clear of `FATAL`/`SIGSEGV` (the historical
BlurView-mid-tab-fade crash); hardware back from the immersive viewer returns through Showcase to
Home with no dead end; edge-to-edge and the status bar are unchanged; the blurred bar surface still
samples the media behind it. Nothing in this unit touches keyboard or gestures.

**Open remainder**: no app-icon badge (`setBadgeCountAsync`) — Tab bars only governs the in-app
oval, and the icon badge belongs with the notification permission and badge-hygiene work in S26.
