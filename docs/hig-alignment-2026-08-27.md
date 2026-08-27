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

- Captures: `xcrun simctl io booted screenshot <absolute path>` — a relative path fails with a bogus
  "volume is read only"; the Simulator MCP panel still doesn't attach on this Mac (memory
  `ios-simulator-panel-attach-fails`). **Driving iOS headless (settled in S5):** the Simulator MCP's
  `swipe` works without the panel, so scrolling and gestures are automatable; routes are reachable
  by deep link — `xcrun simctl openurl booted "magicbooklet:///(tabs)/showcase?filter=all"` (the
  app's own scheme, once the dev client has the bundle; the `exp+…` URL only loads Metro). Android
  mechanics: see *Android parity protocol*.
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
- **Where the work currently sits (2026-08-27):** Phases 1–2 are closed on the `hig-alignment`
  branch and **deliberately not merged** — `main` does not have F4, F6, N1, N2, N3 or S5. The user's
  call at the Phase 2 boundary was to keep accumulating on the branch, so branch from it rather than
  from `main`, and expect the merge question again at the next boundary. Phase 3 is under way: S5,
  S6 (+S6a/b/c), S9, S8, S11, S12, S10 and S4 are closed, and the next `todo` on the board is
  **S13/S14, profiles**, which closes Phase 3. Four things carry into it: the composer's 21 off-ramp
  icon sizes are the largest budget left in `hig-icon-size.test.ts`, with the home side menu's 11
  next; S11's iOS 26 gesture hazard is narrower than it was written — S12 verified that a **native**
  horizontal scroll view (a pager, a carousel) wins the full-screen back pan and needs nothing,
  while a **JS** `PanResponder` drag loses it and needs `fullScreenGestureEnabled: false` on its own
  route; **S13 inherits the creations grid** that S10's board row wrongly named, and the
  generation-titled-with-its-prompt data shape S12 handed on with it; and F3 now owns both halves of
  the bounce-disabled pair (`home-dashboard`, the alerts list) plus the 17 hidden scroll
  indicators.
- **Device mechanics learned in S6, for whoever drives them next:** the Simulator MCP's `tap` works
  headless on this Mac as well as `swipe`, so iOS is fully drivable; a surface is reachable by post
  id with `magicbooklet:///post/<id>`, and the live data has exactly one multi-media post
  (`181ca120…`, two items) and several single-video ones (`9cb3692f…`), which is faster than swiping
  a ranked feed looking for a case. The iOS Simulator does **not** enforce cross-app audio-session
  interruption — verified with a control that was required to interrupt and didn't — so any finding
  about stopping other apps' audio has to wait for a physical device. On Android the dev-launcher
  bubble owns the whole top-right corner including taps outside its visible circle; move the control
  under test, or unit-test it.
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
| DV7 | The three creation surfaces are full-screen modals in substance but declared a tab and two pushes | Modality | The create tab, `create/[tool]` and `post/new` are each full-screen, self-contained and closed rather than backed out of. The create tab cannot become a modal route — it is a tab (DV5) — so promoting one of the other two would split a family the same menu opens. What Modality asks for, an obvious way out, each of them has, and all three now draw the same `CloseGlyph`. Pinned by `post-new-screen.test.ts` | all three creation surfaces |
| DV9 | Tab switches cross-fade; iOS switches tabs instantly | Motion, Tab bars | Motion asks you to "generally avoid adding motion to UI interactions that occur frequently", and a tab switch is the app's most frequent. The bar is a custom component (DV3) on two platforms, where a shared cross-fade reads as one product rather than two; it is already routed through Reduce Motion, so the setting turns it off. Revisit in X1 with the rest of the motion inventory | all four tabs |
| DV8 | A `cancel`-styled alert button titled "Keep …" rather than "Cancel" | Alerts | Four alerts confirm cancelling something ("Cancel upload", "Cancel creation"), where a button titled "Cancel" would collide with the action's own name. The decline says what keeping means instead. The three that do *not* have that collision ("Not now" ×3) are a real miss → X3 | 4 of 7; the other 3 are open |

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
| S10 | Alerts (the `studio` route is the notifications inbox — see the S12/S10 log) | `app/(tabs)/studio.tsx`, `lib/notifications.ts`, `lib/notification-badge.ts` |
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
| F4 iconography/images | 1 | done | 1V/3D/4P | one stroke weight app-wide; share glyph per platform; size ramp on a ratchet (S5's four files are at zero) |
| F5 controls/input | 1 | partial | — | ≥44pt hit regions guarded via lib/hit-target.ts (PR #83); non-geometric rules open |
| F6 branding boundary | 1 | done | 1V/1D/3P | the product now spells its own name one way |
| N1 tab bar/toolbars/status bar | 2 | done | 3V/2D/5P | Alerts badge; one Back glyph per platform; every view title bounded and static |
| N2 modality map/sheets/alerts/gestures | 2 | done | 4V/4D/4P | one sheet grabber that actually drags; menus off `Alert`; one Close control |
| N3 side menus/shell motion | 2 | done | 1V/2D/4P | the menu has a visible way in on every screen that offers it, and closes the way it opened |
| S5 showcase feed | 3 | done | 2V/3D/7P | the grid holds still while you read it; the play badge means "not playing" |
| S6+S6a/b/c viewer & sheets | 3 | done | 3V/2D/3P | the clock survives the picture; the reel can be silenced without leaving it |
| S9 creation tool | 3 | done | 2V/2D/4P | every spend says its price; the wait says what it is doing and how long it has been |
| S8 create hub | 3 | done | 1V/1D/2P | a first creation is told what it costs; the icon ratchet can see a whole idiom it was blind to |
| S11 post composer | 3 | done | 3V/2D/3P | the reorder can be finished, seen, and reached; a removal can be taken back |
| S12 post details | 3 | done | 5V/2D/4P | a post that cannot load says so and offers a way on; copying says it copied, everywhere; a video says what it cost |
| S10 alerts | 3 | done | 3V/2D/4P | the screen answers to the name on the tab; an alert stops shouting over the app you are holding |
| S4 home | 3 | done | 3V/1D/4P | the front door stops introducing itself; four slides now say they are four |
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

### N2 modality map, sheets, alerts & gestures — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Modality (`modality`), Sheets (`sheets`), Action sheets (`action-sheets`),
Alerts (`alerts`), Menus (`menus`), Context menus (`context-menus`), Gestures (`gestures`).

Rules in checkable form: present modally only with a clear benefit, and always give an obvious way
out · confirm before closing a modal that would lose work, gesture or button · one modal at a time,
one alert ever · a grabber means the sheet resizes or dismisses by drag · support swiping to dismiss ·
Cancel/Close on the leading edge, Done on the trailing, and a Done button always paired with a Cancel
— Back is for a previous step, never for dismissing · an action sheet, not an alert, for choices that
follow an intentional action · destructive choices at the top in the destructive style, Cancel at the
bottom · alerts hold at most three buttons, a destructive one always beside a Cancel, and a cancelling
button is titled "Cancel" · don't explain the buttons in the message · use an alert to act, not to
inform · menu labels are verbs, title-case, articles dropped, icons for all of a group or none ·
context menus consistent app-wide, destructive last, every item also reachable in the main interface ·
respond to gestures as people expect, and never let a gesture be the only way to do something.

- [V][both] **Every swipe-to-dismiss in the app was dead, in three different ways.** Four sheets drew
  the grabber pill (comments, viewer actions, feed feedback, create menu) and three more drew a
  `GripHorizontal` handle (the creator's reference, model and parameter sheets); two more drew the
  pill inside the composer (visibility, resource editor). Of the nine, *none* dismissed on a swipe.
  Sheets: "Include a grabber in a resizable sheet — a grabber shows people that they can drag the
  sheet"; "Support swiping to dismiss a sheet. People expect to swipe vertically to dismiss a sheet
  instead of tapping a dismiss button." A pill with nothing behind it is worse than no pill: it
  promises a gesture the sheet does not answer, which is what Gestures warns about — "if you don't
  clearly communicate why a gesture doesn't work, people might think your app has frozen."
  → **fixed**: `components/sheet-chrome.tsx` — `useSheetDismissDrag` + `SheetGrabber`, adopted by all
  nine. Three separate causes, each found only on a device:
  - **The pill was decorative.** Five of the nine had no responder at all.
  - **`Pressable` silently eats spread pan handlers.** The creator sheets' `SheetDragHandle` was a
    `Pressable` with `{...panResponder.panHandlers}` spread on it. `Pressable` renders
    `{...restProps}` and *then* `{...eventHandlers}` from its own Pressability, so every responder
    prop was overwritten and the drag had never once fired. The primitive is a plain `View`; the
    guard sweeps for the pattern so it cannot come back.
  - **A React Native `Modal` never delivers the move phase to a view that declined the start.**
    Measured on the emulator with a temporary probe: on a Modal-hosted sheet
    `onStartShouldSetPanResponder` fired on touch-down and `onMoveShouldSetPanResponder` never fired
    at all, while the identical grabber hosted through `OverlayHost` received both. Four of the nine
    sheets are Modals, so claiming the drag on the first qualifying *move* — the ordinary way to write
    this — could never work there. The primitive claims the touch on **start** instead, which is safe
    because the grabber is a dedicated strip and a touch that turns out not to be a drag springs back.
  - Dragging is the only gesture on it. Tapping a grabber cycles detents on iOS and does not dismiss,
    so the three sheets that dismissed on tap lost that; each has a Close button beside it. The
    grabber is also `accessible={false}`: Gestures asks that a shortcut gesture never be the only way
    to perform an action, and every sheet already answers that with a labelled backdrop or a Close
    button — a second focus stop reading "Close model picker" next to the button that says so is
    noise, not access.
- [V][both] **Three menus were built out of `Alert`.** Comment options (`Delete` / `Remove from post` /
  `Report` / `Cancel`), the post visibility picker, and leaving the composer with unsaved work.
  Alerts: "Use an action sheet — not an alert — to offer choices related to an intentional action …
  an alert is usually unexpected, generally telling people about a problem"; and an alert holds "up to
  three buttons", which comment options could exceed. Leaving the composer is the case Action sheets
  names by example — "when people cancel the message they're editing in Mail … an action sheet
  provides two choices: delete the draft, or save the draft" — and Sheets repeats it for the dismiss
  gesture. → **fixed**: `lib/action-sheet.ts` (renderless: types, the presenter registry,
  `showActionSheet`, `orderActionSheetActions`) plus `components/action-sheet.tsx` (the surface,
  mounted once inside `OverlayHost`). Split the way `lib/notification-badge.ts` is, so a renderless
  module like `post-lifecycle` can present one without importing React.
  - Ordering is the primitive's job, not the caller's: destructive first, Cancel last, so no call site
    can get it backwards.
  - The visibility picker previously spent its way out on the current state — `Keep private` styled
    `cancel`, because Android caps an alert at three buttons and a fourth Cancel would only have
    appeared on iOS. As a sheet the current state is shown *as* state (dimmed, "Current") and Cancel
    is titled "Cancel", which Alerts requires.
  - The composer's alert also carried "Keep editing, save this draft on this device, or discard the
    changes" — a message whose only job was to explain the three buttons, against Alerts' "Avoid
    explaining alert buttons". Gone; the labels say it.
  - The comment report reason picker was a second sheet drawn *inside* the comments sheet
    (`position: absolute`, `zIndex: 10`). It is now an action sheet presented after the options sheet
    closes, which is the Modality rule ("let people dismiss a modal view before presenting another")
    and the same shape Mail uses.
- [V][both] **Two modal routes were dismissed with a Back chevron.** `auth` and `edit-profile` are
  both `presentation: 'modal'` — they slide up from the bottom — and the only way out of each was a
  `BackGlyph`. Sheets: "The Back button lets people navigate to a previous step in a multi-step flow
  or to a parent view in a hierarchy. It isn't intended to dismiss a sheet." `edit-profile` was the
  worse of the two: it has a **Save** (Done) button on the trailing edge, and "If you provide a Done
  button, always pair it with a Cancel button … Relying solely on the Done button implies that
  completing the task is the only way to exit the sheet" → **fixed**: both lead with `CloseGlyph`,
  `edit-profile`'s labelled "Cancel", so the sheet now reads Cancel-leading / Done-trailing exactly as
  the chapter asks. **Android counterpart**: not a no-op and not a dialect split — Close is the same
  mark on both platforms (SF `xmark`, Material `close`), so this one glyph is shared. Verified on both.
- [V][both] **Close was drawn at eight sizes across eleven modal surfaces.** Raw lucide `X` at
  15/17/18/20/21/22/28, the same contradiction N1 found in Back and from the same sentence — Toolbars:
  "Use the standard Back and Close buttons … ensure you consistently implement it throughout your
  app." → **fixed**: `CloseGlyph` joins `BackGlyph` and `ShareGlyph` in `lib/platform-glyphs.ts`, at
  one size (`appTheme.icon.feature`), adopted by the eleven controls that dismiss a modal surface. An
  `X` that removes a chip, clears a field or dismisses an inline banner is a different action wearing
  the same shape and keeps its own glyph. Side effect on F4's ratchet: five files shed off-ramp sizes
  (create menu 1→0, home side menu 12→11, unlock prompt 3→2, composer 22→21, creator screen 25→24).
  - `platform-glyphs` also stopped reading `Platform.OS` at module scope through a bare named import,
    which threw in any test whose react-native mock omits `Platform` — adopting a shared glyph should
    never force a test to widen its mock. Same guard as `lib/motion`.
- [D][both] **The modality map: three creation surfaces, three different declarations.** The create
  tab, `create/[tool]` and `post/new` are each full-screen, self-contained, and closed rather than
  backed out of — modals in substance — while being declared a tab, a push, and a push. Promoting
  `post/new` alone to `fullScreenModal` was tried and reverted: `post-new-screen.test.ts` pins it to
  "the same full-screen push presentation as the media creator", and the create tab cannot become a
  modal route at all, so the change would have split a family that one menu opens. What Modality
  actually asks for — an obvious way out — each of them has → **intentional (→ ledger DV7)**.
- [D][both] **A cancelling alert button that isn't titled "Cancel".** Seven alerts style a button
  `cancel` and title it something else. Four of them confirm cancelling something — "Keep uploading"
  beside "Cancel upload", "Keep creating" beside "Cancel creation" — where the required title would
  collide with the action's own name, and saying what *keeping* means serves the rule's purpose
  better → **intentional (→ ledger DV8)**. The other three ("Not now", beside "Open web" / "Get
  credits" / "Retry") have no such defence and are a real miss → **deferred to X3**, which owns button
  copy app-wide.
- [D][both] **Alert titles are sentence case; the chapter asks for title case on fragments.** Alerts:
  "If the title is a sentence fragment, use title-style capitalization." Every alert title in the app
  is sentence case ("Could not report content", "Report received"), consistently → **deferred to X3**,
  which the phase plan already gives casing to. Settling it in one place beats rewriting ~30 strings
  here and having X3 reverse them.
- [D][both] **The viewer's More sheet dims unavailable actions instead of hiding them.** Context menus:
  "Hide unavailable menu items, don't dim them." It is closer to a menu than a context menu — it is
  revealed on demand, and Menus says the opposite ("Show people when a menu item is unavailable") —
  and each dimmed row prints *why* it is unavailable, which hiding would throw away
  → **intentional**, no ledger row: it is one sheet, and the reason text is the point.
- [P][both] **No context menus anywhere.** Zero `onLongPress` in the tree. Context menus asks for
  consistency, and having none everywhere is consistent, so this is an opportunity rather than a
  violation — but the chapter's own examples (a feed card, a comment) are exactly this app's content.
  Deferred to the per-surface Phase 3 passes, where the item list can be drawn from what each surface
  already offers ("Always make context menu items available in the main interface, too").
- [P][both] Verified clean: **swipe-back is on everywhere it should be** — `gestureEnabled: true` in
  the root `screenOptions`, disabled on exactly two screens, `onboarding` and `update-required`, which
  are gates with nowhere to go back to. Gestures' "shortcut gestures supplement standard gestures, not
  replace them" holds: every screen also has a visible Back or Close.
- [P][both] Verified clean: **the workspace edge-swipe cannot fight the system back gesture.** The
  left-edge menu (`EDGE_SWIPE_START_WIDTH` 24pt) is mounted only on `showcase`, a tab root, where
  there is no swipe-back to conflict with.
- [P][both] Verified clean: **one alert at a time, and none at launch.** No path presents two, and the
  only startup-time modal is the version gate, which is a route rather than an alert — Alerts: "Avoid
  showing an alert when your app starts."
- [P][both] Noted for S15: **edit-profile now offers two cancels** — the header Close and a "Cancel"
  button at the foot of the form. Not a rule break (Sheets asks for the toolbar one, which it lacked),
  but the pair is redundant; the form-foot button is Phase 4's to settle.

Guard added: `__tests__/hig-modality.test.ts` (12 cases) — only `sheet-chrome` may draw a grabber;
every grabber has a drag and every drag moves its panel; no pan handlers spread onto a `Pressable`;
no alert over three buttons; no destructive alert action without a cancel; the action-sheet host is
mounted inside the overlay host; destructive-first ordering; every overlay-hosted surface claims
Android back; no raw `X` on a control labelled Close; the modal-route set is pinned so a new modal
route cannot be added without settling its dismiss control; and the three menus that were alerts stay
gone. `post-lifecycle.test.ts` and `comments-sheet.test.tsx` now assert against the action sheet
(including the no-host `Alert` fallback with Cancel last).

**AND-pass 2026-08-27** (mandatory: this unit touches navigation, gestures and sheets). Pixel_9a, dev
client on the worktree's Metro. Swipe-to-dismiss verified on both sheet hosts — the create menu (a
`Modal`) and the comments sheet (`OverlayHost`) — and it was the Android probe that produced the
Modal move-phase finding above. The visibility action sheet renders with the grabber, the current
state dimmed as "Current", and Cancel last; **hardware back dismisses the sheet rather than popping
the screen**, and returns to the surface underneath. Edit Profile shows Close-leading / Save-trailing
identically to iOS. Home→Showcase→viewer→comments→profile cycled with `logcat` clear of
`FATAL`/`SIGSEGV` (the historical BlurView-mid-tab-fade crash). Edge-to-edge and the status bar are
unchanged; nothing in this unit touches the keyboard.

**Open remainder**: the three "Not now" cancel titles and alert-title casing go to X3; context menus
go to the Phase 3 surface passes; edit-profile's duplicate cancel goes to S15.

### N3 side menus & shell motion — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Sidebars (`sidebars`), Motion (`motion`).

Rules in checkable form: a sidebar wants space, so on a phone prefer the tab bar and keep the sidebar
for what the bar cannot hold · let people hide and show it with the interactions the platform already
uses (on touch, the edge swipe) · avoid hiding it by default so it stays discoverable · no more than
two levels of hierarchy, and short group labels if there are two · familiar symbols for the rows ·
sidebar icon colours must serve a purpose · add motion purposefully and never for its own sake ·
make motion optional · feedback motion follows people's gestures and expectations — a view revealed
by sliding one way is not dismissed by sliding another · generally avoid adding motion to
interactions that occur frequently · let people cancel motion.

- [V][both] **On Showcase the edge swipe was the only way into the workspace menu.** One drawer, two
  hosts, and they disagreed completely: Home draws a hamburger in its top bar and has no edge swipe;
  Showcase mounts the edge-swipe layer and drew no control at all. Alerts and Profile offer neither.
  So the app's account, credits, unlocks, sales, settings and help lived behind an invisible 24pt
  gesture on the screen most likely to be someone's first. Gestures: "Use shortcut gestures to
  supplement standard gestures, not replace them … people also need simple, familiar ways to navigate
  and perform actions, even if it means an extra tap or two", and "not the only way to perform an
  important action in your app"; Sidebars: "Avoid hiding the sidebar by default to ensure that it
  remains discoverable" → **fixed**: the gesture layer now publishes its opener through context
  (`useWorkspaceSideMenu`) plus one glyph and one label (`WorkspaceSideMenuGlyph`,
  `WORKSPACE_SIDE_MENU_LABEL`), and Showcase renders the control on its leading edge, where Home's
  already sits. Home's raw `Menu` at 22 moved to the same glyph at `appTheme.icon.default`, so the two
  cannot drift — and its F4 budget came down with it (4→3).
  - **The edge swipe stays on Showcase only, deliberately.** Home's top card is a horizontally
    scrolling carousel, and the layer observes touches through `onTouchStart`/`onTouchEnd` rather than
    claiming them — so a rightward swipe beginning within 24pt of the left edge would both scroll the
    carousel and open the menu. A shortcut may exist on one screen and not another; what the chapter
    forbids is a gesture being the only way, and now it never is.
  - Alerts and Profile still offer no route to the menu. Left open for their Phase 3 passes (S10,
    S13) — Profile in particular duplicates much of the drawer's content, so "add the menu" may be
    the wrong answer there.
- [D][both] **The drawer opened by gesture and closed only by tap.** Motion: "Strive for realistic
  feedback motion that follows people's gestures and expectations … if someone reveals a view by
  sliding it down from the top, they don't expect to dismiss the view by sliding it to the side."
  You drag the drawer in from the left edge; nothing dragged it back → **fixed**: a leftward drag on
  the drawer panel dismisses it, at the same distance and velocity a sheet uses
  (`SHEET_DISMISS_DISTANCE` / `SHEET_DISMISS_VELOCITY`, imported rather than re-picked). The backdrop
  tap, the Close button and Android back all still work — this is the shortcut, not the only way.
  - It claims in the **capture** phase, which is the difference between this and the sheets: the
    drawer's body is a `ScrollView` that would otherwise own every move, and capture is what lets the
    panel take a horizontal drag back from it without touching vertical scrolling or taps.
  - **This also sharpens N2's Modal finding.** The drawer is a `Modal`, and claiming on *move* works
    here — where it could not in the create menu. The difference is what happens to the touch-down:
    in the create menu nothing consumed it, so the move phase never reached JS at all; here the
    ScrollView consumes it and the moves keep flowing. So the rule is not "a Modal never delivers
    moves" but "a Modal never delivers moves for a gesture nothing consumed". Verified on the
    emulator both ways.
- [D][both] **Tab switches cross-fade; iOS switches tabs instantly.** Motion: "generally avoid adding
  motion to UI interactions that occur frequently", and a tab switch is the most frequent interaction
  in the app; UIKit's own tab controller does not animate. The bar is custom on two platforms (DV3),
  the fade is what makes them read as one product, and it is already routed through Reduce Motion →
  **intentional (→ ledger DV9)**, with the caveat that this codebase has been bitten by that fade
  before (bottom-tabs detaching the focused scene mid-fade), so X1 should look again with the whole
  motion inventory in hand.
- [P][both] Verified clean, now guarded: **every shell transition asks the Reduce Motion preference
  first.** Both navigators name their animation as `reducedMotion ? 'none' : …`, with the single
  exception of `update-required`, which is `'none'` unconditionally. Motion: "Make motion optional."
- [P][both] Verified clean: **the drawer is one level deep.** Eleven rows, all of which navigate;
  nothing expands in place, so Sidebars' two-level ceiling is not approached and no group labels are
  needed. Guarded so a disclosure section cannot appear without the depth question being asked.
- [P][both] Verified clean: **familiar symbols on every row** — Crown for credits, Wallet for sales,
  Gift for invite, Layers for templates, PackageOpen for unlocks, Settings, CircleHelp — and icon
  colour is used sparingly and with meaning (coral for the brand rows, semantic colour on the two
  money rows), which is what Sidebars asks of sidebar icon colours.
- [P][both] Verified clean: **the drawer is dismissible three ways and traps focus.** Backdrop tap,
  Close button and Android hardware back all close it; `accessibilityViewIsModal` is set and the
  backdrop is hidden from the reader.
- [P][both] Noted, not fixed: **the drawer travels 40pt, not its own width.** It fades in from
  `translateX: -40` while a 280–360pt panel arrives — so it materialises rather than sliding in from
  the edge the gesture came from. Motion's "realistic feedback motion that follows people's gestures"
  argues for the full travel, but this is the shell's feel rather than a rule break, and the viewer's
  entrance was deliberately settled the same way (a plain fade beat a fancier one). Left for X1 to
  take with the rest of the motion inventory rather than changed here on one unit's judgement.

Guard added to `__tests__/hig-navigation-chrome.test.ts` (5 new cases, 24 total) — a screen that
mounts the gesture layer must also reach for `useWorkspaceSideMenu`, so the swipe can never again be
the only way in; the two openers must use the shared glyph and label; the drawer must claim a
leftward drag in the capture phase against the shared thresholds; the drawer must stay one level
deep; and every `animation:` in both navigators must be routed through `reducedMotion`.

**AND-pass 2026-08-27** (mandatory: this unit touches navigation and gestures). Pixel_9a, dev client
on the worktree's Metro (restarted via the new `metro-hig` entry in the worktree's
`.claude/launch.json`). The Showcase header renders the menu control on its leading edge exactly as
Home does; the drawer opens from it; a leftward drag from the middle of the drawer closes it, with
`logcat` clear of `FATAL`/`SIGSEGV`; hardware back still closes it; the edge swipe still opens it.
Same two checks on the iOS simulator, where the drag also closes the drawer. Nothing in this unit
touches the keyboard, blur or the tab bar itself.

**Open remainder**: Alerts and Profile still have no route to the workspace menu (S10, S13); the
drawer's 40pt entrance travel and the tab cross-fade both go to X1.

### S5 showcase feed — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Collections (`collections`), Image views (`image-views`), Playing video
(`playing-video`). Carrying N2's deferral of context menus to the surface passes.

Rules in checkable form: prefer the standard row or grid layout · a table, not a collection, for
text · adequate padding around images so nothing overlaps · tap to select, touch and hold to edit,
swipe to scroll are the defaults, add gestures only when the app needs them · consider animating
insertions, deletions and reorders · **avoid changing the layout while people are viewing and
interacting with it, unless it's in response to an explicit action** · take care overlaying text on
images: contrast well, and give the text a shadow or background layer · an image view displays,
a button displays an interactive image · a custom video experience must reference the behaviour and
interface of the system player, because a slight divergence leaves people unsure which habits still
apply · always display video at its original aspect ratio · never let audio from two sources mix.

- [V][both] **The feed resized itself under a stationary reader.** About a sixth of the live grid
  reaches the client with no media dimensions, so those cards are laid out at a hash-picked
  placeholder height from `[218, 248, 284]` and measured afterwards with `Image.loadAsync`. The
  measurement was applied the moment it landed, including to cards already on screen. Caught on the
  Pixel_9a by capturing the same resting scroll position twice a second apart: one card grew,
  another shrank ~80px, and both columns beneath them moved. The 50ms coalescing added earlier
  reduced the number of reflows but not the class — the code's own comment ("cards visibly jumping
  as you scrolled into them") is a record of the same thing.
  - **Corrected 2026-08-27, after this entry was first written.** The original text blamed legacy
    generation covers (`showcase-feed.ts`'s `width: null`) and counted 19 of them. That path is a
    *fallback*, reached only when the posts read returns null, so it is not normally in the feed at
    all. The real source is `buildLegacyPostMediaItems`: 8 public posts predate `post_media` and have
    no row there, 3 of them text (which the masonry drops), leaving **5 of the 29 media cards** — and
    every `post_media` row that does exist carries dimensions. Those 5 each have a generation with a
    ready preview, which `resolvePostRowsToFeedItems` grafts onto the cover; it grafts the preview
    *URL* but not the preview's dimensions, which is precisely the gap. Same defect, same fix, right
    mechanism.
  Collections, iOS: "Use caution when making dynamic layout changes … If possible, try to avoid
  changing the layout while people are viewing and interacting with it, unless it's in response to
  an explicit action." → **fixed**: `partitionAspectRatioUpdates` splits each flush into ratios that
  may land now and ratios whose card is on screen; the held ones are released the next time
  viewability reports the card has left. A third viewability pair
  (`SHOWCASE_ONSCREEN_VIEWABILITY`, threshold 1%) answers "any pixel visible" — the playback
  config's 55% would have missed a card scrolled almost out of the top, which is the one whose
  resize moves the most.
  - **Cost of the rule, stated plainly**: a card that resolves while on screen and never scrolls
    away keeps its placeholder height, so its media stays `cover`-cropped for that visit. A wrong
    crop is a smaller harm than a moving page, and the crop corrects itself the moment the card
    leaves the viewport.
  - The root cause is a payload gap, not a client bug: the graft has no dimensions to send because
    `generations` carries none. Filling them removes the measure step for the cards that still take
    it — **out of scope here** (a web/API change plus a backfill), taken up immediately afterwards on
    `feed-media-dimensions`. The client-side hold stays regardless: it is what protects any card
    whose measurement lands late, whatever the reason.
- [V][both] **The play badge stayed up while the video played.** `VideoCornerPlay` rendered on any
  video card, elected or not, so a tile running its muted looping preview still wore a filled
  triangle in a circle — the shape of the system's play control — inviting you to start something
  already running. Seen on both platforms before the fix (two cards mid-playback on the Pixel_9a,
  the same on the simulator).
  Playing video: "If your app truly requires a custom video player, reference the behavior and
  interface of the system video player … A custom experience that diverges slightly from the
  system-provided experience can cause frustration because people don't know which of their
  habitual interactions they can continue to use." → **fixed**: `isShowcaseCoverVideoStreaming`
  decides it, so the tile now reads badge (poster) → spinner (starting) → nothing (playing).
  - Election alone would have been the wrong test twice over: a card can win the autoplay slot and
    still show its poster forever when the server's `feedStreamUrl` is an explicit null
    (poster-only), and Reduce Motion turns every activation off without changing the election. Both
    keep the badge. Verified after the fix on **both** platforms by capturing the same tile twice —
    different video frames, no badge.
- [D][both] **One boolean locked the whole feed for any card's sideways drag.** A carousel's drag
  suspends the feed's vertical scrolling and the workspace edge-swipe. Two faults: a cell torn down
  mid-drag emitted the opening `true` and never its `false`, leaving the feed permanently unable to
  scroll; and one shared boolean meant card A's expiring momentum cleared the lock card B's finger
  was still holding. Gestures: "if you don't clearly communicate why a gesture doesn't work, people
  might think your app has frozen" — here it would not be a misunderstanding.
  → **fixed**: `useCarouselDragReporter` deduplicates each carousel's transitions (one drag reports
  `false` twice — at drag end and again when momentum expires — so a counted lock is only sound once
  transitions are deduplicated) and releases on unmount; the screen counts holders instead of
  assigning a boolean. **Not reproduced on device**: the tear-down needs a refetch or recycle to land
  under a finger, which the live feed did not offer. Pinned instead by two rendering cases that fire
  the handlers and unmount mid-drag, both verified to fail without the fix.
- [D][both] **Reduce Motion was asked once per card, on a private copy of the hook.**
  `showcase-media-preview` re-implemented `useReducedMotion` with its own `AccessibilityInfo`
  subscription, and the feed mounts one of those per visible card — a native listener each, each
  starting at `false` and resolving a tick later, so with the preference **on** a video could mount
  and start before the answer arrived. `home-side-menu` carried a second copy of the same hook.
  Motion: "Make motion optional." → **fixed**: both use `lib/motion`'s shared
  `useSyncExternalStore`, which holds one subscription for the process. Guarded by sweeping for the
  listener, which may now appear only in `lib/motion.ts`.
- [D][both] **The same placeholder plate was drawn four times, four ways.** The grid's video and
  image fallbacks, the media preview's pending plate and the video preview's posterless plate are
  one component's worth of markup at 46 and 48pt, over three background alphas and two border
  alphas, with glyphs at 19, 19, 21 and 22, white on two and the accent on the other two.
  Icons: "all interface icons in your app need to use a consistent size, level of detail, stroke
  thickness (or weight), and perspective"; Design principles/Familiarity → **fixed**:
  `components/feed-media-plate.tsx`. The glyph arrives as a component rather than an element, so a
  call site passes neither a size nor a weight — the same discipline `LucideProvider` applies to the
  stroke.
  - **This closes F4's ratchet for S5.** `hig-icon-size.test.ts` budgets for
    `app/(tabs)/showcase.tsx` (3), `showcase-media-preview.tsx` (2), `feed-video-preview.tsx` (1)
    and `feed-pagination-footer.tsx` (1) are all **0**: the plate took four of them, the refresh
    control moved to `icon.default` beside its row-mate, the pagination retry to `icon.sm` (the
    ramp's "16 next to `label`"), and the carousel counter to `icon.xs`.
- [P][both] **Two type overrides on the ramp, both removed.** The pin badge set `lineHeight: 12` on
  12pt `caption` — a line box the size of the glyphs, which clips descenders on Android — and the
  carousel counter set a raw `fontSize: 11`. Both now use `caption`, with `paddingVertical` reduced
  (5→3 and 4→1) so the pills keep the heights they had. Typography/Labels.
- [P][both] Verified clean, now guarded: **every mark the feed draws over media stays legible on the
  brightest media it can cover.** Composited against pure white, the pin badge chip
  (`rgba(5,5,7,0.78)`) carries every tool accent at 4.91:1 or better, the carousel counter reaches
  7.60:1, and the corner play badge clears the 3:1 graphical floor at 3.04:1. Image views: "ensure
  the text contrasts well with the image, and consider ways to make the text object stand out, like
  adding a text shadow or background layer" — the chip *is* that layer, and the guard now computes
  these rather than trusting them.
- [P][both] Verified clean: **the grid is a standard grid.** Collections asks for "the standard row
  or grid layout whenever possible" and warns off custom layouts that "draw undue attention"; a
  two-column masonry is the platform-common shape for a media feed and does not. Text-only posts are
  filtered out of it by `buildShowcaseMasonry`, which is Collections' "consider using a table
  instead of a collection for text" — they render at full width in the home feed instead.
- [P][both] Verified clean: **video plays at its own aspect ratio and cannot mix audio.** Each tile
  is sized from its poster's ratio rather than a fixed box, no letterbox padding is composited into
  the frame, and the player is created `muted`, at `volume = 0`, with `staysActiveInBackground`
  and `showNowPlayingNotification` off.
- [P][both] Noted, not fixed: **the filter row re-flows when you change filters.** The selected tab
  is drawn one weight heavier, so every tab shifts horizontally on a tap. It is the same
  don't-move-things instinct as the finding above, but Collections' rule carries its own escape —
  "unless it's in response to an explicit action" — and a filter tap is exactly that. Dropping the
  weight would also drop a selection signal. Left as is, deliberately.
- [P][both] Noted, deferred: **a removed card vanishes without animation.** Collections: "Consider
  using animations to provide feedback when people insert, delete, or reorder items." Hiding a post
  or a creator mutates the query cache and the card disappears between frames; only a VoiceOver
  announcement marks it. Layout animation over a recycling masonry is a known jank source and this
  is one instance of an app-wide question → **X4**, which owns feedback.
- [P][both] Noted, deferred: **still no context menus.** N2 left the decision to the surface passes,
  and Collections names touch-and-hold among a collection's default interactions. Every action the
  card offers is already reachable from its `⋮` control, and a real context menu needs a native
  module (RN has no `UIContextMenuInteraction`) and therefore a native build — an app-wide call, not
  one surface's → left for the phase that can make it once for every surface.
- [P][both] Noted for X5: the feed's accessibility labels are built from `card.title`, which falls
  back to the post's full prompt — so a card's label, and the `⋮` control's, can be a paragraph. The
  filter tabs are `accessibilityRole="button"` where the row is a tab list. Both are role/label
  questions the app answers in one place or not at all.

Guard added: `__tests__/hig-collections.test.ts` (19 cases) — a measured ratio may only be applied
to an off-screen card, and the screen's *only* two writes to that state must both go through the
merge; the on-screen viewability config must ask for any visible pixel, not the playback threshold;
the play badge is gated on real streaming, with the poster-only and Reduce Motion cases pinned; each
carousel must deduplicate its drag transitions and release on unmount, and the feed must count
holders; the reduce-motion listener may exist only in `lib/motion.ts`; and every overlay mark's
contrast is computed against white media rather than asserted. `showcase-media-preview.test.tsx`
gains the two rendering cases a sweep cannot see (one release per drag, and a release on unmount).

Also fixed here: `hig-icon-weight.test.ts`'s provider case was timing out under the full suite —
the first `import('lucide-react-native')` in a worker pulls ~1,600 icon modules through the
transform and overran vitest's 5s default whenever the other 146 files ran alongside it. It is a
pre-existing flake, not a regression, but a guard that goes red under load stops meaning anything,
so that one case now has room.

**AND-pass 2026-08-27** (mandatory: this unit touches gestures and video/animation). Pixel_9a, dev
client on the worktree's Metro. The play badge disappears once a tile is streaming and returns when
it is not — the same tile captured twice a second apart shows different video frames and no badge;
the pin badges and the carousel counter render at their new metrics with the pills unchanged in
height; the feed scrolls freely after repeated flings, so the media lock is not stuck; the Android
predictive-back gesture leaves Showcase for Home with no dead end; edge-to-edge and the status bar
are unchanged; `logcat` clear of `FATAL`/`SIGSEGV` across the pass (the historical
BlurView-mid-tab-fade crash). Same badge and metric checks on the iOS simulator, driven with the
Simulator MCP's swipe — which does work headless on this Mac, contrary to the earlier note, so later
units can drive iOS rather than only capturing it. Nothing in this unit touches the keyboard or the
tab bar.

**Open remainder**: card removal animation → X4; context menus → the phase that can settle a native
module for every surface; long prompt-derived accessibility labels and the filter row's `button`
role → X5; supplying preview dimensions from the API for the covers that predate `post_media`,
which removes the measure step for the cards that still take it → `feed-media-dimensions`.

### S6 + S6a/b/c immersive viewer & sheets — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Going full screen (`going-full-screen`), Playing video (`playing-video`), Playing audio
(`playing-audio`), Page controls (`page-controls`), Status bars (`status-bars`), Gestures (`gestures`),
Action sheets (`action-sheets`, re-read for what the destructive style is for). Carrying N2's rulings
on this surface: the More sheet is a menu, not an action sheet, and context menus wait for the phase
that can settle a native module.

Rules in checkable form: a full-screen experience continues to provide access to essential features
and controls, so people never have to leave it to do something ordinary · prioritise content by
hiding chrome, but let a familiar gesture bring it back · obscure content under the status bar, keep
it readable, and never hide it permanently · reference the system video player, because a slight
divergence leaves people unsure which habits still apply · always display video at its original
aspect ratio · choose an audio category that fits how the app uses sound, and don't stop other
apps' audio if you don't need to · a page control is centred near the bottom, is tapped or scrubbed,
and stops being the right control past about ten pages · handle gestures as responsively as possible,
with feedback that helps people predict the result · use the destructive style for buttons that
perform destructive actions.

- [V][both] **The reel put the system clock on the picture.** The viewer is the app's one full-bleed
  screen, and the strip behind the status bar is not the media — it is the `blurRadius: 24`, `cover`
  crop of the same image that `FeedMediaFrame` paints as a backdrop, at full brightness. Four
  screens already draw `TopScrim` for exactly this reason; the screen that actually needs it did not.
  Measured on the simulator at the rows the clock is drawn on (80–120px of a 1206×2622 capture,
  27–40pt), in a glyph-free column, on an ordinary indoor photo: **white-on-background 4.42:1** —
  under the 4.5:1 floor PR #83 set for body text, and unbounded downward, because a white product
  shot puts a white strip behind white glyphs.
  Status bars: "Obscure content under the status bar … Be sure to keep the status bar readable."
  → **fixed**: the viewer draws `TopScrim`, and `TopScrim` gained an `over="media"` variant.
  - The existing gradient was not enough on its own. `background → transparent` across the whole
    inset is already half-faded by the rows the glyphs occupy: adopting it as-is moved the same
    measurement from 4.42:1 to only **8.01:1**, and on white media it would still land near 2:1. The
    `media` variant holds full opacity to `MEDIA_SCRIM_HOLD` (0.6) of the inset and fades over the
    rest, which puts the glyph band on opaque ground: **18.46:1 on iOS, 20.14:1 on Android**, and
    those numbers no longer depend on the picture. Verified on Android against a white dinner plate.
  - **Not hidden instead**, though Status bars suggests that first ("Consider temporarily hiding the
    status bar when displaying full-screen media") — because the same chapter requires a way to bring
    it back, "a simple, discoverable gesture", and Photos' is a single tap. The reel has already spent
    that tap on play/pause and the double-tap on save. A third meaning for a tap here is exactly the
    divergence Playing video warns about, so the scrim is the option this surface can actually afford.
  - Cost, stated plainly: the top ~60% of the safe-area inset is now opaque over the media rather
    than showing a blurred sliver of it. On a full-bleed slide it reads as a vignette; on a
    letterboxed one it merges with the black ground.
- [V][both] **The two halves of the top strip were drawn on top of each other.** The reel's refresh
  spinner sat at `topInset + 24` and each slide's media counter at a flat `top: 68` with no safe area
  at all — different components, neither able to see the other's frame. On an iPhone 17 Pro
  (`topInset` 72) the spinner occupies 96–116pt and the chip 68–94pt, so a refetch on a multi-media
  post paints a spinner through the counter; on a short inset the chip rides into the status bar.
  Layout's safe-area rule, and Design principles/Familiarity for the two conventions.
  → **fixed**: `lib/viewer-chrome.ts` derives every offset in the strip from the resolved inset —
  Back leading and mute trailing on the control row, the spinner leading and the counter trailing on
  the badge row beneath it. The guard proves the rows cannot overlap at any inset from 0 to 62
  rather than trusting the arithmetic.
- [V][both] **The reel could not be silenced without leaving it.** The showcase grid autoplays muted
  at `volume = 0`; the viewer's player was constructed `muted = false, volume = 1.0`, so tapping a
  card was the moment sound started — and there was no mute control anywhere on the surface. The only
  ways to stop it were the hardware volume keys, pausing the video (which stops the thing you came
  for), or leaving. Going full screen: "Continue to provide access to essential features and controls
  so people can complete their task without exiting full-screen mode. For example, a full-screen
  media experience needs to make playback controls persistently available."
  → **fixed**: a mute toggle on the trailing edge of the control row, mirroring Back, shown on any
  slide whose post carries a video (`hasImmersiveAudibleMedia` — the cover can be an image while page
  three is the video, and the control has to be there before the reader swipes onto it, not appear
  under their thumb). State lives in `lib/viewer-audio.ts`, one `useSyncExternalStore` for the
  process in the same shape `lib/motion` uses, persisted through AsyncStorage so the choice outlives
  the visit. Verified end-to-end on **both** platforms including a full app restart.
  - **The default stays unmuted** — put to the user at the close of this unit and settled there.
    Adopting the control was the HIG requirement; the default is a product call, and sound is part of
    the content in a reel. Whoever wants silence taps once and the choice now persists, which is the
    part that was missing. Do not re-open this in X4 or Phase 6.
- [D][ios] **The two platforms disagreed about the audio session, silently, because of a library
  default.** expo-video's iOS `VideoPlayer.swift:18` defaults `audioMixingMode` to `.doNotMix`, and
  `VideoManager.swift:75–118` then removes `.mixWithOthers` from the category and calls
  `setActive(true)` whenever *any* player is playing — the muted feed previews included, since the
  override is keyed on the mode rather than on whether sound is coming out. Android's default is
  already `AUTO` (`VideoPlayer.kt:197`) and its `anyPlayerRequiresFocus` is
  `(!muted && playing && volume > 0) || mode == DO_NOT_MIX`, so a silent preview never takes focus
  there. Playing audio: "don't make people stop listening to music from another app if you don't
  need to." → **fixed**: `audioMixingMode = 'auto'` declared at all four player sites (viewer, feed
  preview, lightbox, media preview), which holds the session only while a player is actually
  outputting audio and makes the platforms agree explicitly instead of inheriting two defaults.
  **Android counterpart**: not a no-op and not a dialect split — it is Android's existing behaviour,
  written down so iOS matches it.
  - **Filed as a deviation, not a violation, because this Mac cannot demonstrate the user-visible
    half.** A 60s tone was served to the simulator's Safari from a local HTTP server, with a page
    that logs every `play`/`pause` to `localStorage` so the record survives being backgrounded. The
    silent feed previews did not pause it. Neither did the **control**: an unmuted, playing video in
    the immersive viewer, which is required to interrupt, also left Safari playing. The simulator
    does not enforce cross-app audio-session interruption at all, so the experiment can neither
    confirm nor refute the effect on a device, and the finding rests on the two libraries' source.
    The fix cannot regress anything either way. Re-check on a physical iPhone at the next store build.
- [D][both] **`Unsave` wore the destructive style.** Six actions were classed destructive; `unsave` is
  a one-tap toggle whose own row re-reads "Save" the moment it is used, and nothing is destroyed.
  Action sheets: "Use the destructive style for buttons that perform destructive actions." Spending
  the danger colour on the sheet's cheapest action devalues the rows that are genuinely dangerous
  (delete, block, report), which sit in the same sheet → **fixed**: dropped from
  `isDestructiveViewerAction`; `viewer-actions.test.ts` updated in the same commit.
- [P][both] **One play badge, three treatments.** Four inline copies in `viewer.tsx` — 72pt circle
  with a hairline border and without, glyph at 34 with an optical `marginLeft: 4` on one of them and
  no nudge on the rest, one on a white-alpha plate instead of black. Icons' consistency rule, the
  same one F4 applied to the icon set → **fixed**: `ViewerPlayBadge`, one treatment, glyph on the
  ramp at `icon.hero` (32) rather than the off-ramp 34, optically centred once.
- [P][both] **The counter lied under the finger, and the pill was off the type ramp.** It updated only
  on `onMomentumScrollEnd`, so a slow drag showed the page you were leaving until it landed, and it
  set a raw `fontSize: 11`. Gestures: "Handle gestures as responsively as possible … provide feedback
  that helps them predict its results" → **fixed**: a second index tracked from `onScroll` feeds the
  counter, while the settled index — which also gates video playback and the hardware-back
  interception — still moves only when a page lands. The chip moves to `type.caption` with
  `paddingVertical` 5→3 so its height is unchanged, the same trade S5 made on the feed's counter.
- [P][both] **The two Back buttons pressed differently.** The reel's used a literal `opacity: 0.7`
  where its twin in `ViewerShell` used `appTheme.opacity.pressed` (0.88) → **fixed**: both on the
  token.
- [P][both] Verified clean: **video plays at its own aspect ratio and the reel does not mix audio.**
  `FeedMediaFrame` renders `contentFit: 'contain'` over a blurred `cover` backdrop, so nothing is
  letterboxed into the frame itself, which is what Playing video's padding warning is about; and one
  player is elected at a time (`selectActiveImmersiveVideoId`), blocked while any sheet or the details
  page is open (`getImmersiveVideoBlockerId`), with `staysActiveInBackground` off.
- [P][both] Verified clean: **a counter rather than a page control is the right call here, and stays.**
  Page controls wants dots centred near the bottom, but it also says a page control "doesn't represent
  hierarchical or nonsequential page relationships" — and this pager is media pages *plus* a details
  page, which is exactly such a relationship. Nothing caps a post's media count either (the composer
  passes `allowsMultipleSelection` with no limit), and the chapter stops recommending dots past about
  ten. The counter counts only media and hides itself on the details page, which is the honest
  reading. Live data has one multi-media post, with two.
- [P][both] Noted, deferred: **the More sheet scrolls.** Action sheets: "Avoid letting an action sheet
  scroll … scrolling an action sheet can be hard to do without inadvertently tapping a button." It is
  `maxHeight: '62%'` over a `ScrollView`, and an owner's own post can fill five groups. N2 classified
  this surface as a menu rather than an action sheet — the rule quoted is an action-sheet rule and
  the classification is not being re-opened here — but the hazard it describes is real on the longest
  variant → X4, which owns what a surface does when its content outgrows it.
- [P][both] Noted for X4: **the viewer's loading state is a bare spinner** with an accessibility
  label and no visible text, and the reel's own refresh spinner carries no label at all.

Guard added: `__tests__/hig-full-screen.test.ts` (25 cases) — the viewer draws the `media` variant of
the scrim, in the one position in the tree that is after the scroller and before the sheets; the two
top-strip rows cannot overlap at any inset, and no element in the strip may be placed by a literal
again; the mute control is labelled both ways, is gated on `hasImmersiveAudibleMedia`, and the player
reads the shared store rather than a hard-coded `false`; the store notifies once per real change and
survives a rehydrate; every file that creates a video player declares a mixing mode, and no file
outside the known four may create one at all; the play badge is drawn from one component and the
glyph appears once; `unsave` is not destructive while delete/block/report still are; and the counter
reads the dragged index while the settled index keeps its own setter.

**AND-pass 2026-08-27** (mandatory: this unit touches gestures and media/audio). Pixel_9a, dev client
on the worktree's Metro. The scrim renders correctly under Android's forced edge-to-edge — measured
20.14:1 white-on-background at the status-bar rows over a white dinner plate, where iOS measures
18.46:1 — and the mute control, the counter and the two glyph swaps (`BackGlyph` → Material arrow,
`ShareGlyph` → Material share) all render at their intended positions. Horizontal paging still pages,
and the counter tracked 1/2 → 2/2 through an `adb input swipe`. Hardware back leaves the reel with no
dead end, and returned to the previous viewer instance with the mute state restored from storage.
`logcat` clear of `FATAL`/`SIGSEGV` across the pass. Nothing in this unit touches the keyboard, the
tab bar or blur.
- **The mute toggle needed a probe to tap.** The Expo dev-launcher bubble owns the top-right corner
  on the Android dev client and swallowed every `adb` tap aimed at the control, including taps
  outside its visible circle — the hazard `android-dev-launcher-bubble-blocks-top-right-taps`
  records, and dragging it away pulled the notification shade instead. The control was moved 300pt
  down for one run, tapped, confirmed to flip the glyph and to survive a force-stop and relaunch,
  and then moved back; its production position is verified by capture in the same pass.

**Open remainder**: the More sheet's scrolling and the unlabelled spinners → X4; "Comments" as a menu
label where Menus asks for verbs → X3, which already owns button copy; re-checking the audio-session
interruption on a physical iPhone, which no simulator on this Mac can show → next store build.
The one question this unit put to the user — whether the reel should start muted — was answered
**unmuted**, and is recorded above rather than left open.

### S9 creation tool — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Generative AI (`generative-ai`), Entering data (`entering-data`), Progress indicators
(`progress-indicators`), Undo and redo (`undo-and-redo`), Machine learning (`machine-learning`).
Drag and drop is attached to "S9/S11" in the coverage matrix but belongs wholly to **S11**: the
creation screen imports `PanResponder` and never uses it, and the only reorder drag in the app is in
`app/post/new.tsx`.

Rules in checkable form: get permission before irreversible or costly actions, and ask for
confirmation before doing something significant on someone's behalf · make it easy to refine, revert
or retry generated results, with the controls *near* the generated content · give specific feedback
during generation — "instead of 'Processing…', say 'Finding substitutions for ingredients'" · factor
processing time into the design · offer curated example inputs for an open-ended prompt · coach
people when a request is blocked · let people give feedback on outputs, voluntarily · avoid vague
progress terms like *loading*, because they seldom add value · prefer a determinate indicator,
because it lets people "decide whether to do something else while waiting … restart the task at a
different time, or abandon the task" · halt processing where feasible, and say when halting costs
something · be clear about the data you need, and keep the action unavailable until it is there.

- [V][both] **One of the four ways to spend credits didn't say so.** The composer's button has always
  read `Generate · 8 credits`. The workspace's failure panel offered a button labelled `Retry` — and
  `onRetry` is `() => void generate()`, a full new paid generation. Same money, same model, same
  draft, no price. Generative AI: "Consider consequences and get permission before performing
  irreversible or potentially problematic tasks … Generally, ask for confirmation before performing a
  significant action on someone's behalf" — and a button that states the price *is* that
  confirmation, which is why the composer states it. → **fixed**: `lib/generation-action-label.ts`,
  and both the composer and the workspace price their action through it. It also fixes an
  off-by-plural: the old inline template produced "1 credits".
- [V][both] **The hero wait could not be judged.** The app's longest, most expensive interaction
  showed a sparkle, an indeterminate spinner, and one of two strings — `Preparing your image` before
  the provider reported anything, `Generating` after. No phase, no elapsed time, nothing that changed
  while you watched. Progress indicators names the failure twice: "avoid vague terms like *loading* …
  they seldom add value", and a determinate indicator earns its place because it "can help people
  decide whether to do something else while waiting for the task to complete, restart the task at a
  different time, or abandon the task". Generative AI says the same thing in its own words.
  → **fixed**: `lib/generation-wait.ts` — the title separates the two states the provider actually
  reports (`Queued with the model` / `Making your image`), and the line beneath carries the phase plus
  a running clock (`Waiting for the model to pick it up. Running for 0:44.`). The clock is also the
  progressbar's `accessibilityValue` and a polite live region, replacing the raw provider status.
  - **Not made determinate, and the reason matters.** The provider reports `waiting` → `processing`
    and no percentage; `GenerationStatusResponse` has no progress field and the catalog carries no
    expected duration. A determinate bar would have to be invented, and Progress indicators is
    explicit that a fabricated pace is worse than none: "Showing 90 percent completion in five
    seconds and the last 10 percent in 5 minutes … can even feel deceptive." Elapsed time is the
    honest substitute — it answers the question the rule is really asking.
  - The clock is stamped in `generate()`, not when the modal appears, so minimizing the wait and
    coming back does not restart it. Verified live on the emulator: a queued run read 0:38 and 0:44
    across a six-second gap.
- [D][both] **The result had no way to run it again.** The success panel offered *Post to feed*,
  *Create another* and *Open Alerts*. Generative AI: "Make it easy for people to refine or revert
  generated results … surfacing controls like Edit, Undo, Retry, or Adjust near generated content
  preserves people's agency." The nearest thing was *Create another*, which closes the workspace and
  leaves you in the composer with the draft intact — an adjust path, named as though it were a reset.
  → **fixed**: a `Generate again · 8 credits` control on the result itself, priced by the same helper
  as everything else that spends. Verified end-to-end on the emulator: tapping it started a second
  run of the same draft.
- [D][both] **The same action had two names.** Closing the workspace and keeping the draft was
  *Create another* on the success panel and *Back to creator* on the failure panel — identical
  handlers, and now sitting one row apart from the new *Generate again*, where two synonyms would
  have been actively confusing. Design principles/Familiarity: "once you establish a behavior or
  appearance for an element, apply it throughout" → **fixed**: *Back to creator* on both.
- [P][both] **One requirement, two voices.** With an empty prompt the blocker read `Prompt is
  required.`; pressing Generate replaced it with `Add a prompt before generating.` — the same
  condition stated as a fact before the press and as an instruction after it, because only the press
  path went through `promptValidationMessage`. Entering data: "Be clear about the data you need."
  → **fixed**: the blocker routes through the same mapper. Errors it does not map (an unknown
  `@handle`, for instance) still pass through verbatim, which the Android pass confirmed.
- [P][both] Verified clean: **the action is unavailable until the data is there.** `generateDisabled`
  includes `validation.errors.length > 0`, and the amber blocker above the bar prints the reason, so
  Entering data's "make the button available only after people enter the data you require" holds
  along with the feedback that keeps a disabled control from being a mystery.
- [P][both] Verified clean: **curated example inputs exist.** `GUIDED_PROMPTS` supplies three worked
  prompts per tool through `GuidedPromptChips`, which is Generative AI's "offer diverse, predefined
  example inputs that hint at what's possible" and Machine learning's *Limitations* pattern
  ("demonstrate how to get the best results"). The prompt field's placeholder does the same job —
  "Describe the subject, setting, lighting, composition, and style…".
- [P][both] Noted, deferred: **a running generation cannot be cancelled, but a template run can.**
  Progress indicators: "When it's feasible, let people halt processing … Let people know when halting
  a process has a negative consequence." `api.cancelTemplateRun` exists and S19 offers *Cancel
  creation* behind a confirm; there is no `cancelGeneration`, so S9 has no equivalent. Feasibility is
  the open question and it is not a client one — it needs an API route, a provider cancel, and
  settled refund semantics in the credit ledger → **backend, not this programme**. Logged so the
  inconsistency is not mistaken for an oversight.
- [P][both] Noted, deferred: **there is no feedback control on a generated result, and no way to keep
  one.** Generative AI asks that people can "share feedback on outputs … a quick and easy way to give
  positive and negative feedback"; the only route today is *Report AI output* in the viewer's More
  sheet, on an already-posted item, which is moderation rather than quality. Saving a result to the
  camera roll is absent app-wide — `expo-media-library` is not a dependency, so it needs a new
  permission string and a native build → both are product calls sized well beyond a surface pass.
- [P][both] Noted for X3/backend: **failure copy is passed through, not coached.** The panel says
  "We couldn't create this {medium}" and prints the server's message, with the draft preserved and a
  now-priced retry — which satisfies the recovery half. Generative AI's other half, "help people
  improve requests when blocked … coaching people how to be more successful next time", depends on
  what the API sends for a content-policy rejection, which this unit could not trigger without
  deliberately generating blocked content.

Guard added: `__tests__/hig-generative-creation.test.ts` (16 cases) — credits are counted in words
with the singular right; an unsettled quote yields the bare verb rather than an invented price; both
workspace controls that spend are priced and the bare `Retry` cannot come back; the composer button
uses the same helper and no longer builds its own string; the wait separates queued from running,
formats an uncapped clock, leaves no vague status behind, announces the detail rather than the raw
provider status, runs the clock only while the run is live and from when it started, and receives a
start time at both call sites; the result carries the retry control; and the blocker goes through the
prompt mapper at both sites. The suite slices declarations by name rather than reading to end-of-file,
after a first draft silently swept the whole tail of a 5,800-line file.
`media-creation-screen.test.tsx` updated for the three renamed controls, in the same commit.

**AND-pass 2026-08-27** (mandatory: this unit touches input and the app's hero wait). Pixel_9a, dev
client on the worktree's Metro. A live generation showed `Queued with the model` with the clock
advancing 0:38 → 0:44 across a six-second gap; `Generate again · 8 credits` started a second run of
the same draft; the result panel reads identically to iOS; hardware back closed the workspace onto
the composer with the draft intact and the bar switched to *View result*, no dead end. The blocker
carried an unmapped validation error (`Unknown element mention: @…`) through verbatim, which is the
regression the mapper change could have caused. `logcat` clear of `FATAL`/`SIGSEGV`. Nothing in this
unit touches the tab bar, blur or gestures.
- **Cost of the pass, stated plainly:** four real image generations were run against the production
  account (two per platform, 8 credits each, 32 of ~26,800). The wait, the result panel and the new
  retry control cannot be observed any other way.
- **The `running` phase was not seen on device.** Both platforms went `waiting` → `succeeded` without
  the provider ever reporting `processing` for a fast image model, so `Making your image` is covered
  by unit test only; it should appear on a video run.
- **The failure panel was not reached on device** either — `Try again · 8 credits` is covered by the
  rendering test that drives the real component with a mocked failed status.

**Open remainder**: generation cancel → backend; output feedback and save-to-library → product;
blocked-request coaching → X3 and the API's error copy; the unreachable third layout below →
spun out as its own change.

- [P][both] **The screen's third layout is unreachable.** `MediaCreationScreen` branches
  `if (activeTool !== 'image')` (line 1400, returns) then `if (activeTool === 'image')` (1634,
  returns), and `CreatorToolId` is exactly `image | video | motion` — so the function's tail `return`
  at 1867 can never run, along with `FloatingGenerateReviewBar` and the "Ready check" section only it
  renders. Not a HIG defect, but it is an audit hazard: it cost this unit a false finding ("the app
  has two competing generate bars") before the branch structure was checked, and a source-sweeping
  guard that matched it would mean nothing. Left in place deliberately — deleting ~140 lines of JSX
  plus its exclusive components from the app's largest file is a change that deserves its own diff
  rather than riding inside a HIG commit → spun out.

### S8 create hub — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Menus (`menus`). Carried from this programme's own earlier units rather than re-fetched:
Generative AI and Machine learning (S9, same day), Collections (S5), Tab bars and Toolbars (N1),
Modality and Sheets (N2).

**What this surface turned out to be.** `app/(tabs)/creator.tsx` is a 35-line wrapper that renders
`MediaCreationScreen` with `insideTab`, and `insideTab` now changes only two padding numbers: the
three things that were meant to make the tab a *hub* rather than the tool — a Templates catalog
entry, a floating review bar, a status-bar cover — all live below `MediaCreationScreen`'s unreachable
tail return (S9's last finding). So the create hub is the creation tool plus one menu, and this unit
is correspondingly short. Two things follow from that, and only one of them is a loss:
- **Nothing is missing from Templates.** The dead `TemplateCatalogEntry` duplicates an entry point
  the live composers already draw — a `Templates` button in each of the three compact composers, plus
  a row in the home side menu. Recorded because it was the second false finding the dead branch
  nearly produced (the first was "two competing generate bars", in S9).
- **Something *is* missing from the first run.** See the violation below.

Rules in checkable form, from Menus: label a menu item with a verb or verb phrase · title-style
capitalization, articles removed · list important or frequently used items first · provide icons for
all items in a group or none of them · show when an item is unavailable · append an ellipsis when the
action needs more information before it can complete · be mindful of menu length.

- [V][both] **The app's first creation is told nothing about what it costs.** Onboarding's last act is
  `router.replace('/(tabs)/creator', { tool: goal, guided: '1' })` — so the guided creator is the
  first screen of the app's actual job for every new account. The section written for that moment,
  `GuidedCreatorIntro`, carries the sentence that matters most to someone who has just been given
  credits — *"Nothing runs or spends credits until you press Generate"* — plus two tips on what a good
  prompt contains. It renders at line 1889, inside the unreachable tail. What actually arrives is a
  row of starter pills, clipped to their first third. Confirmed on the simulator before the fix:
  `Premium product photo on a cl…` / `Bold social campai…`, and nothing else.
  Generative AI: "Set clear expectations about what your AI-powered feature can and can't do … If your
  feature has known limitations, let people know up front, show them how to get good results";
  Machine learning/Limitations asks the same, and names placeholder text and worked examples as the
  ways to do it. → **fixed**: `GuidedCreatorHint`, mounted on both *live* composer branches, using the
  existing `SlimCreatorBanner` primitive — the cost promise and one sentence on what to describe.
  - **Not the whole dead section restored.** Its three large starter buttons would duplicate the live
    chips, which already do that job. Only the part that was actually lost is back.
- [D][both] **F4's icon ratchet had never seen an entire rendering idiom.** `hig-icon-size.test.ts`
  collects the names imported from `lucide-react-native` and then matches on the *tag* — so an icon
  rendered through a local stand-in (`const Icon = isCreate ? Sparkles : FilePlus2`, `const Icon =
  item.icon`, `const SlotIcon = kind === 'video' ? Video : ImageIcon`) was invisible to it. Twelve
  places in the tree render icons that way, and they were hiding **five off-ramp sizes**: 26 here,
  21 twice in `studio.tsx`, 42 and 34 in `media-template-screens.tsx`. This programme's own session
  rules say a rule that is not guarded is not adopted; a guard that cannot see a violation is the
  same failure one level down. → **fixed**: `aliasedIconNames` widens the sweep, with two cases
  pinning both alias shapes; S8's own icon moved 26 → `appTheme.icon.feature`; and the four newly
  visible sizes are written into the budgets they belong to (`studio.tsx` 2→4, `media-template-
  screens.tsx` 6→8) so **S10 and S19 ratchet them down in their own passes**. The ratchet still only
  turns one way — these are pre-existing sizes becoming countable, not new ones being permitted.
- [P][both] **A starter showed a third of a starter.** `GuidedPromptChips` clamps to
  `numberOfLines={1}` in a 230pt pill, so "Premium product photo on a clean studio set with soft
  natural shadows" arrived as "Premium product photo on a cl…". Generative AI asks for "diverse,
  predefined example inputs that hint at what's possible"; a clipped example hints at its own
  beginning → **fixed**: two lines. Verified on both platforms — Android shows the first starter
  whole, iOS all but the last word.
- [P][both] Verified clean: **the create menu is a menu, and reads like one.** Two items, `Create`
  then `Post` — bare verbs, title case, no articles, most important first, an icon on both (Menus:
  "provide icons for all menu items in a group, or none of them"), each with a body that says where
  it goes. Neither is ever unavailable. Length is not a concern at two.
- [P][both] Verified clean: **the ledger's two entries for this surface hold.** DV5 — the tab bar
  hides on the Create tab — and DV6 — the raised centre control opens a menu rather than switching
  tabs. Closing the Create tab lands on Home with the bar back, so the tab that presents as a modal
  still has the way out Modality requires. Hardware back dismisses the menu on Android without
  popping the screen behind it.
- **Considered and declined: the ellipsis.** Menus asks you to "append an ellipsis to a menu item's
  label when the action requires more information before it can complete", and both items qualify —
  each opens a view where you must supply a prompt or a post. `Create…` and `Post…` were not adopted:
  the convention belongs to compact list-style menu items, and these are 148pt cards that already
  carry a full descriptive subtitle ("Image, Video, and Motion" / "Share finished media"), which
  signals *this continues elsewhere* far more strongly than three dots could. Recorded so a later
  pass does not re-litigate it.

Guard added: `__tests__/hig-create-hub.test.ts` (8 cases) — the menu's two labels stay bare verbs
with no articles, in priority order, pointing at the surfaces their bodies promise; both items keep an
icon, on the ramp; the ways out N2 gave the menu (grabber drag, Close button, Android back) stay;
onboarding still lands on the guided creator; the cost promise renders on both live composer branches
and sits beside the starters rather than replacing them; and a starter is no longer clamped to one
line. `hig-icon-size.test.ts` gains the two alias cases and the widened sweep.

**AND-pass 2026-08-27**. Pixel_9a, dev client on the worktree's Metro. The guided creator shows the
`YOUR FIRST CREATION` banner with its full body over two lines and the first starter chip whole; the
create menu renders with both icons at the new size, the grabber, the Close button and a dimmed
backdrop; hardware back dismisses the menu and leaves Home underneath. `logcat` clear of
`FATAL`/`SIGSEGV`. Nothing in this unit touches the keyboard, gestures or blur.
- The tab bar's raised control needed two attempts to hit by `adb`: the first tap, computed from a
  stale capture, landed on the feed card behind it and opened the viewer. Locate it from a fresh
  crop of the bar, not from an earlier screenshot of the same screen.

**Open remainder**: the unreachable tail is still there and now has one more reason to go —
`GuidedCreatorIntro` is redundant as of this unit; the spun-out change covers it. Menu label casing
and the `Create` control opening a menu whose first item is also `Create` → X3, which owns copy.

### S11 post composer — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Drag and drop (`drag-and-drop`), Undo and redo (`undo-and-redo`), Entering data
(`entering-data`). Drag and drop was attached to "S9/S11" in the coverage matrix and S9 assigned it
wholly here; this is where it lands.

Rules in checkable form: offer alternative ways to accomplish drag-and-drop actions, including
accessibility APIs that identify sources and destinations · provide clear and continuous feedback
throughout the drag · show whether a destination can accept the content — an insertion point, a
highlighted container · scroll the contents of a destination when necessary · prefer letting people
undo a drag-and-drop operation · help people predict the result of an undo, and show the result so
they do not think it did nothing · let people undo multiple times · provide undo and redo buttons
only when necessary · be clear about the data you need · validate dynamically · make a Next button
available only after the required data is there.

- [V][ios] **Dragging a card to the right dismissed the composer.** iOS 26 turned the navigator's
  back gesture into a *full-screen* pan — `fullScreenGestureEnabled` now defaults to `true` from that
  OS "to match new native behavior" — and a native recognizer outranks the JS `PanResponder` the
  reorder runs on. Instrumented on the simulator: `drag armed` → **one** `pan move` → the responder
  was terminated and `{"type":"POP","payload":{"count":1},"source":"post/new-…"}` was dispatched. So
  half the reorder never existed: leftward drags worked, every rightward drag closed the screen.
  Worse, the composer's leave-guard could not save it — the pop had already committed, so the sheet
  N2 built appeared *over Home*, and its Cancel had nothing to cancel. The draft survived only
  because it auto-persists. Gestures and Drag and drop both assume a drag that starts is a drag that
  finishes → **fixed**: `fullScreenGestureEnabled: false` on the `post/new` route.
  - **`gestureEnabled: false` does not cover this**, which cost this unit two rounds. Verified on
    iOS 26.4 with it set: a mid-screen drag *and* a plain left-edge swipe both still popped. Only
    `fullScreenGestureEnabled` governs the new gesture. Recorded so nobody re-tries the obvious one.
  - **A per-drag lock was tried first and abandoned.** `lib/use-navigation-gesture-lock.ts` set the
    option through `navigation.setOptions` while a card was held, which would have kept iOS 26's
    gesture everywhere else on the screen. It does not propagate: with the hook live the screen still
    popped, because expo-router re-applies the layout's declarative `<Stack.Screen options>` on the
    navigator re-render that `setOptions` itself triggers. The file was deleted rather than shipped
    looking like it worked. The screen keeps its **edge** swipe, so the way out Modality requires is
    intact — only the full-screen variant is off, and only here.
  - **Android counterpart: a deliberate no-op.** The navigator has no swipe-back to suspend there;
    Android's back is the hardware/predictive key, which `usePreventRemove` already guards. Verified
    in the pass below — and verified working *better* than iOS's was: hardware back raised the leave
    sheet **over** the composer, with Cancel returning to it intact. The drag worked in both
    directions on Android before this fix and after it, which is what first localised the bug.
- [V][both] **The drag showed nothing about where the card would land.** The dragged card followed
  the finger; every other card held still; on release the order changed by `Math.round(dx / step)`.
  Drag and drop: "it's crucial to provide clear and continuous feedback throughout … show people
  whether a destination can accept dragged content … display an insertion point or highlight a
  containing view." → **fixed**: the drag moved out of the card and into the row
  (`UploadContent`), which now shifts every card between the origin and the destination by one slot
  while the finger is down, and renames the held card to the slot it would take. Captured mid-drag on
  the emulator: with `76.png` lifted from slot 2 and held over slot 3, `75.png` had already stepped
  left into slot 2 and the held card read `Media 3`.
- [V][both] **The far end of a full row could not be reached at all.** One slot costs 142pt of
  finger travel and a phone offers about 370; slot 4 from slot 0 needs 568. The row is a horizontal
  `ScrollView` that the pick-up *disables* (the Android fix that hands the gesture to JS), so the
  destination could not come to the finger either. Drag and drop: "scroll the contents of a
  destination when necessary … this behavior makes it easy for people to find the right place to drop
  the item." → **fixed**: held within 56pt of either edge, the row scrolls itself at ~375pt/s and the
  drop index is computed in the row's content space, so the scrolled distance counts. Verified on the
  emulator: the cover was dragged to the last slot in a single gesture.
  - The first pace, 12pt per 16ms tick (~750pt/s), crossed two cards before a finger could lift.
    Halved to 6 after watching it on both platforms.
- [D][both] **Nothing removed from the draft could be put back.** Six controls removed part of the
  draft instantly and finally; the media one costs the most, because the file is already uploaded by
  the time its card appears and removing it also strips that media from every resource card it was
  attached to — links no amount of re-picking restores. Undo and redo exists for exactly this
  ("reverse many types of actions … explore and experiment safely"), and Drag and drop repeats it for
  the reorder ("prefer letting people undo a drag-and-drop operation") → **fixed**:
  `lib/composer-undo.ts` plus a `ComposerUndoBar` above the footer. It names what comes back
  (`Removed Cover`, and `Undo removing Cover` to a screen reader) rather than reporting after the
  fact, appears only when there is something to undo — "provide undo and redo buttons only when
  necessary" — and restores the scroll position the removal happened at, because the chapter is
  explicit that a result nobody sees reads as an undo that did nothing.
  - **Deliberately one step, not a stack.** Undo and redo asks for multiple undos. A draft-wide
    snapshot only stays truthful while the screen is idle — uploads, the resource editor and the
    publish mutation all run against the live draft — so a stack would hand back stale state. One
    step, offered for eight seconds, is the reversal that can be kept honest; a real stack is a
    draft-model change, not a screen change. Written into the module's header so the gap is a
    decision on the record rather than an oversight.
  - **Where the boundary is drawn.** The three removals that edit the draft (media, resource card,
    made-with row) all record one, so the consistency rule holds. The attachment removal inside the
    resource editor sheet does not, and does not need to: that sheet edits a copy and already
    confirms a dirty discard on close, so it is reversible by leaving it.
- [D][both] **The Next button is always available, where the app's other primary action is not.**
  Entering data: "if you include a Next or Continue button after a set of text fields, make the
  button available only after people enter the data you require." S9's Generate button does exactly
  that — disabled, with an amber line naming the blocker. The composer's `Review & publish` is always
  pressable and validates on press, then scrolls to and focuses the first invalid field.
  → **intentional, and not moved to the ledger as a divergence**: the rule's stated purpose is that
  "people understand that they must provide the required data before they can proceed", and this
  surface meets it another way — `Required` sits beside every field label before anything is pressed,
  and the press produces a specific error *plus* focus in the field that needs it, which a disabled
  button cannot do. Recorded rather than changed because the two surfaces reading differently is a
  real inconsistency; X3 owns the copy sweep and can settle which one the app adopts.
- [P][both] Verified clean: **the drag already had a route that needs no drag.** Every card carries
  `increment`/`decrement` accessibility actions labelled *Move right* / *Move left*, which is Drag
  and drop's "offer alternative ways to accomplish drag-and-drop actions … use accessibility APIs to
  identify sources and destinations." Kept and guarded. The card's label was conditional on being
  draggable, so a lone media item had a hint and no name — that is now unconditional.
- [P][both] Verified clean: **the upload says how long it will take and can be stopped.** Picking
  five images showed `Uploading media · 79%` with `3 of 5 complete · 8.1 MB of 10 MB` and a
  `Cancel upload` control — Drag and drop's "provide feedback when dropped content needs time to
  transfer … display a progress indicator" and Progress indicators' halt rule, both already met.
- [P][both] Noted, not chased: **five of the composer's 39 components are never rendered.**
  `TitleSection`, `ProofSection`, `StorySection`, `UnlockSection`, `PublishSection` and
  `SecondaryPickButton` appear in no JSX in the file. This is the third unit to trip over dead code
  in this tree (S9's unreachable tail, S8's `TemplateCatalogEntry`), and it cost this one a false
  finding — `onRemoveSection` looked like a sixth un-undoable removal until the component that
  renders it turned out not to exist. Folded into the spun-out dead-code change, not this diff.

Guard added: `__tests__/hig-post-composer.test.ts` (29 cases) — the composer route turns off the
full-screen back gesture and keeps the edge swipe, and no other route is touched; the drop index
takes a slot at the halfway mark and cannot leave the row; neighbours between origin and destination
shift by exactly one slot and nothing else moves; a full row needs more travel than a phone has,
which is why the row auto-scrolls, stopping exactly at each end and never on a row that fits; the row
owns the drag, reads its landing slot from the gesture rather than render state, and releases the
auto-scroll on unmount; the held card announces its target slot and wears its target name; the
move-left/move-right actions survive; every card is named whether or not it can be dragged; the undo
offer names what comes back, renders only when there is something to undo, sits outside the scroll
it would otherwise ride away with, is recorded by every removal that edits the draft, and returns to
where the removal happened. `post-new-screen.test.tsx` gains `NavigationContext` in its
`@react-navigation/native` mock, in the same commit.

**AND-pass 2026-08-27** (mandatory: this unit is gestures and input). Pixel_9a, Android 16, dev
client on the worktree's Metro. Reorder verified in both directions with `input motionevent`
press-hold-drag; the mid-drag capture shows the neighbour already stepped into the vacated slot and
the held card renamed to its target; the cover reached the last slot of a five-card row in one
gesture via auto-scroll; removing a card raised `Removed Media 2 · Undo`, and Undo restored both the
card and the order. Hardware back raised the leave sheet over the composer and Cancel returned to it
with the draft intact. `logcat` clear of `FATAL`/`SIGSEGV`. Edge-to-edge and keyboard insets are
untouched by this unit.
- **Cost of the pass, stated plainly:** ten images were uploaded to production storage (five per
  platform) to have something to reorder. They belong to no post — the composer uploads at pick
  time, which is also what makes the missing undo expensive enough to fix.
- **Timing note for whoever drives iOS next:** the round trip between two tool calls here is
  routinely longer than an eight-second window, so a transient control cannot be caught by
  "act, then screenshot". Either start a screenshot burst in the background *before* acting, or use
  Android, where `adb` input and `screencap` run in the same shell command and the timing is exact.
  Two device rounds were lost to this before the undo bar was confirmed to render at all.

**Open remainder**: a multi-step undo stack → draft-model change, out of a surface pass; the Next-
button inconsistency with S9 → X3; the five dead components → the spun-out dead-code change; and one
hazard for the units after this — **any screen that grows a horizontal drag inherits the iOS 26
gesture conflict**, and the only thing that stops it is that route's own
`fullScreenGestureEnabled: false`.

### S12 post details — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Text views (`text-views`), Labels (`labels`), Image views (`image-views`),
Page controls (`page-controls`), Loading (`loading`), Feedback (`feedback`), Gestures (`gestures`),
Layout (`layout`).

The surface is two screens wearing one name: `app/post/[id].tsx` — a written post read as a page,
with its comments inline and a swipe-left second page — and `components/post-details-page.tsx`, which
is *also* the reel's swipe-left page, so every fix here lands twice. Media posts never reach the
first of those: this route is the canonical resolver for a shared link and redirects anything that
isn't prose to the viewer, which is what makes its unloadable state matter more than it looks.

- [V][both] **A post that could not load said one sentence and offered nothing.** "This post could
  not be loaded.", centred, grey, on black — no back control (the arrow lived in the loaded branch
  only), no retry, and no account of what had happened, while `refetchPost` sat unused three lines
  above. The loading state was a bare spinner on the same empty screen. This is where a link to a
  deleted or private post lands. Feedback: "show people when a command can't be carried out and help
  them understand why"; Loading: "show something as soon as possible … if you make people wait for
  loading to complete before displaying anything, they can interpret the lack of content as a
  problem with your app" → **fixed**: both states keep the screen's own back control, and the
  failure names itself ("This post isn't available"), says what probably happened, and offers
  **Try again**, which is the refetch that was already in hand.
- [V][both] **Copying confirmed itself with a haptic and nothing else.** The app has four copy
  controls: the invite screen shows a "Link copied" notice *and* announces it; the details page
  fired `Haptics.selectionAsync()` and changed nothing on screen; the marketplace asset and unlock
  screens did neither. Feedback is explicit that this is the wrong number of channels — "when you
  provide feedback using color, text, sound, and haptics, people can receive it whether they silence
  their device, look away from the screen, or use VoiceOver" — and Design principles' Familiarity
  says a behaviour established once applies throughout → **fixed** in the shared layer, not on this
  screen: `lib/copy-to-clipboard.ts` writes, taps and announces, and the `ResourceAction` pill that
  all three resource surfaces share takes a `confirmLabel` and wears "✓ Copied" for 1.8s. The invite
  screen keeps its notice and gains the haptic. Four controls, one behaviour.
  - Captured on both platforms: the pill green-tinted and reading *Copied* a frame after the tap,
    and back to *Copy* three seconds later. Android draws its own system clipboard preview alongside
    ours; iOS draws nothing of its own, which is the platform this most needed fixing on.
- [V][both] **That way out could also be a control that answers a press by not moving.** The arrow
  called `router.back()` unconditionally, and on an empty stack that does nothing — which is the
  stack a cold launch from a shared link can produce, on the surface that exists to receive shared
  links. → **fixed**: one `leavePost` (`canGoBack() ? back() : replace('/(tabs)/showcase')`) serves
  the arrow *and* the post-deleted exit, which had the same bug. Stated plainly: the empty-stack
  case could not be exercised here — a cold launch on a dev client opens the Expo launcher, not the
  deep link — so this adopts the fallback `leaveViewer` already settled on rather than repairing an
  observed failure.
- [V][both] **The only visible way off the text post was the last thing a screen reader reached.**
  The floating back arrow was the final child of the root view, after the pager that holds the post
  *and its entire comment thread*; VoiceOver reads a screen in view-hierarchy order, so "Go back"
  came after every comment → **fixed**: it is now the first child and stays on top by `zIndex`
  rather than by being painted last. Verified on the Android emulator that z-order alone keeps it
  above the pager (it does — `zIndex` reorders the ViewGroup there too), and on iOS that tapping it
  still leaves the screen.
  - **Stated plainly:** the ordering was reasoned from React Native's hierarchy rule and is pinned
    structurally, not observed through VoiceOver — the simulator can't be driven for it here, and
    the VoiceOver walkthrough of every surface is X5's pass.
- [V][both] **A title that was a whole prompt buried the page.** `details.title` was unbounded at
  `pageTitle` (30/36). For a creation whose title falls back to its prompt, that meant fifteen lines
  of display type before the creator, the facts, the primary action or anything else — and the same
  text printed again, in full, in the Prompt section directly beneath. Layout: "make essential
  information easy to find by giving it sufficient space … don't obscure it by crowding it with
  nonessential details. You can make secondary information available in other parts of the window"
  → **fixed**: bounded to six lines. Six because a composed title is capped at `TITLE_MAX_LENGTH`
  (100 characters ≈ five lines), so the bound cannot touch a real title — it only catches a prompt
  wearing the slot. Captured before and after: the page now opens on title, byline, facts and every
  action.
- [D][both] **A creation's cost was hidden exactly where it was largest.** The stat row was
  `Model` plus `duration ? 'Duration' : 'Cost'` — a video always has a duration, so a video never
  said what it cost, and the cost an image did show was a bare `8` where Studio calls the same
  number "8 credits". S9 settled that every spend says its price → **fixed**: `buildGenerationStats`
  in the view model emits a tile per fact that exists, formatted through `formatCreditAmount` with
  its unit, dropping zeroes the way `buildPostDetailsMeta` drops "0 saves"; the row wraps rather
  than squeezing three tiles into a phone. Captured on iOS: `MODEL kling-3.0/video` · `DURATION 11s`
  on the first row, `COST 220 credits` full-width on the second — 220 credits that were invisible
  before.
- [D][ios] **This screen's full-screen back gesture is off, and the pager is why.** Verified on
  iOS 26.4: from the details page a rightward mid-screen drag pages back to the post; from the post
  page the same drag does nothing; the left-edge swipe still pops the screen. The paging `FlatList`
  is a native scroll view, and its recognizer outranks iOS 26's full-screen back pan with no option
  set → **intentional, and not laid in the ledger**: the position is the one `post/new` chose
  deliberately (edge swipe intact, full-screen variant gone), the labelled `Details` control means
  the second page never depended on the gesture, and the drag that is consumed does rubber-band, so
  Gestures' "indicate when a gesture isn't available" is met. Android counterpart: no swipe-back to
  lose — hardware back runs through `useHardwareBack`, details → post then post → out, verified in
  the pass below.
  - **The mechanism, for the units after this one.** S11 left a hazard: "any screen that grows a
    horizontal drag inherits the iOS 26 gesture conflict." Narrow it — S11's drag was a JS
    `PanResponder`, which *loses* to the native back pan and needs
    `fullScreenGestureEnabled: false`; a native horizontal scroll view *wins* it and needs nothing.
    Pagers and carousels are safe; JS-driven drags are not.
- [P][both] **An avatar with a photo showed an empty disc until the photo landed.** `CreatorAvatar`
  drew its initial *instead of* the image rather than behind it, so the post page opened on a blank
  circle where a face was about to be — caught on the very first capture of this unit, and gone a
  second later once the details page warmed the cache. Images asks a placeholder to stand in while
  content loads → **fixed in the primitive**: the initial is always drawn and the photo covers it,
  which repairs every avatar in the app rather than this screen's.
- [P][both] **Icon ratchet: the unit's three files went 9 → 0.** `app/post/[id].tsx` 4→0 (a 17 and
  three 19s to `icon.compact`, which is the 18 the showcase card's overflow settled on in S5),
  `post-details-page.tsx` 2→0, `post-resource-references.tsx` 3→0. Two blacks on one button went the
  same way: the primary's label used `textInverse` while its glyph used `#050505`. The remaining raw
  hexes in these files (`#000` for an empty details page, `#ff8a9a` for an error line) moved onto
  `colors.app` and `semantic.danger`.
- [P][both] **One title, set two ways.** The text post page drew its title at 25/31 — a step the
  ramp does not have — while the details page drew the same post's title at `pageTitle`. Both are
  `pageTitle` now.
- [P][both] Verified clean: **everything worth taking away is selectable.** Title, body, prompt,
  caption, resource text and error lines all carry `selectable`, which is what Text views and Labels
  both ask for ("if a label contains useful information … consider letting people select and copy
  it").
- [P][both] Verified clean: **the second page is reachable without knowing the gesture.** A labelled
  `Details` control sits in the action row and in the action sheet, so the swipe is Gestures'
  "shortcut gesture to supplement standard gestures, not replace them". No page control, and none
  wanted: Page controls describes "an ordered list of pages" of peers, which a post and its
  provenance are not, and the control names its destination in a way dots cannot.

Guard added: `__tests__/hig-post-details.test.ts` (20 cases) — the states that show no post keep the
back control, and the error names itself, explains, and offers the retry it already had; one back
control serves every state and has somewhere to go when there is nothing to go back to; it precedes the pager it floats over and stays on top by z-order; every
clipboard write in `app/` and `components/` goes through the one helper, which reaches touch, sound
and the screen reader; the pill wears its result and every copy control asks for one, and the
confirmation clears itself and drops its timer with the pill; a video reports its cost as well as
its length, spelled with its unit and pluralised, with absent facts left out; the page renders
whatever the model produced instead of choosing between two, and the tiles wrap; the title is
bounded above any composed title's length; one title style across the screen's two pages; the avatar
draws its initial whether or not a photo is coming. `post-details-navigation.test.ts` and
`post-resource-bundle-content.test.tsx` are updated in the same commit (the arrow's new shape, and
`Check` in the icon mock).

**AND-pass 2026-08-27** (mandatory: this unit moves a navigation control and changes feedback).
Pixel_9a, Android 16, dev client on the worktree's Metro. Text post, details page, error state and
an owner creation all captured. Hardware back from the details page returns to the post with the
post intact; hardware back from the error state leaves the screen — no dead end. The back arrow
still paints above the pager from first position in the tree. `COST 8 credits` on an image creation,
where a bare `8` used to be. Copy confirmed and reverted on schedule. Edge-to-edge unchanged:
content sits below the status bar in every state. `logcat` clear of `FATAL`/`SIGSEGV`, the app
process alive throughout. The comment composer's keyboard is untouched by this unit and stays
S6b's — the emulator answered the tap with Gboard's floating toolbar rather than a docked keyboard,
so that box is *not* ticked here.

**Device mechanic worth keeping — how to catch a transient control on iOS.** S11 recorded that a
1.8s window cannot be caught by "act, then screenshot", because a tool round trip outlasts the
window, and sent that work to Android. There is an iOS way: start a *paced* background burst
(14 frames at 0.8s), fire the tap, then crop the same region out of every frame with
`sips -c … --cropOffset` and `md5` the crops. The odd hashes out are the frames inside the window —
here, 7 and 8 of 14 — and only those need reading. No image decoding, no OCR, two frames read
instead of fourteen.

**Open remainder**: a generation whose title is its prompt is a Studio-side data shape, not a
rendering one → **S10**; `feed-card-shell.tsx` still carries a 17pt overflow glyph the ramp does not
have, and it is the last file with that literal → whichever unit owns the feed card next; and the
details page hides its vertical scroll indicator (`showsVerticalScrollIndicator={false}`) on a page
that can run several screens, which is Scroll views' business and F3's to settle app-wide rather
than one screen's to flip.

### S10 alerts — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Managing notifications (`managing-notifications`), Notifications (`notifications`),
Toggles (`toggles`), Scroll views (`scroll-views`); Feedback and Loading were read earlier the same
day for S12 and are reused rather than refetched.

**The board was wrong about what this unit is.** The inventory called S10 "Studio —
`app/(tabs)/studio.tsx`, `studio-feed-view-model`". The route named `studio` renders the
**notifications inbox**, which the tab bar labels *Alerts*; the creations grid it was named for has
moved to the profile tab (S13). `lib/studio-feed-view-model.ts` — the masonry builder for that grid —
is imported by nothing but its own test: **dead code, deleted here with its test**. That is the
fourth dead-code find in this tree (S9's unreachable tail, S8's `TemplateCatalogEntry`, S11's five
never-rendered components), and the first that was load-bearing in the *plan* rather than the code.
The inventory row now names the surface that exists.

- [V][both] **The screen and the tab that opens it called the destination two different things.**
  The tab bar's label, the navigator's `title` and the badge's screen-reader announcement
  ("Alerts, 3 unread") all say *Alerts*; the screen titled itself **Notifications** and named four of
  its controls to match ("Refresh notifications", "Mark all notifications read", "Could not load
  notifications", "That notification change did not save"). Design principles' Familiarity: "once
  you establish a behavior or appearance for an element, apply it throughout" — F6 applied exactly
  this rule to the product's own name → **fixed**: the screen and its controls say *Alerts*. One
  string deliberately keeps the platform's word — "Notifications are disabled for this device.
  Re-enable them in system settings" points at iOS Settings ▸ Notifications, and has to name what
  the reader will find there.
- [V][both] **An arriving alert shouted over the app you were already holding — including over the
  list it was about to join.** `setNotificationHandler` returned the background presentation
  verbatim: `shouldShowBanner: true, shouldPlaySound: true`, unconditionally. Notifications is
  explicit, and gives the exact case: "Handle notifications gracefully when your app is in the
  foreground … present the information in a way that's discoverable but not distracting or
  invasive … when a new message arrives in a mailbox that people are currently viewing, Mail simply
  adds it to the list of unread messages because sending a notification about it would be
  unnecessary and distracting." → **fixed**: `resolveForegroundPresentation` never plays a sound
  over the foregrounded app, and drops the banner only while the Alerts screen is the one on screen
  (the screen reports itself in and out of view through `useFocusEffect`). Everywhere else the
  banner stays — a finished render is worth surfacing — and the alert always joins Notification
  Center for when the phone is put down.
  - **Suppressing a banner is only honest if the app shows the alert itself**, and nothing listened
    for an arrival: the tab badge learned about one on its next poll, up to a minute later. A
    received-listener now refreshes the badge and the list the moment one lands. That is the second
    half of the chapter's sentence — "subtly inserting new data into the current view" — and it is
    what makes the first half safe.
- [V][both] **Two live rows sent the reader to the screen they were already on.** "New follower"
  carries `deep_link: '/studio'` in production (2 of this account's 47 rows), and the screen's
  fallback for an unresolvable link was `router.push('/studio')` — the same route. Notifications:
  "When people tap a notification … they expect your app to display related content"; a follow
  notification landing on the notification list displays none. → **fixed** on the client:
  `deepLinkTargetsAlertsScreen` recognises a link pointing back at this screen, and such a row is
  marked read and left at that; the fallback is gone. Verified on the emulator by tapping the
  `@hello-athul followed you.` row: the list did not move. The root layout keeps its own `/studio`
  fallback, and should — a tap from outside the app has to land somewhere.
  - The other half is the server's: a follow's destination should be the follower's profile. → S26.
- [D][both] **The screen kept its own clock, and it got worse exactly where the shared one gets
  better.** `formatNotificationTime` stopped at days, so alerts read "51d ago", "57d ago", "78d ago";
  `formatRelativeTime` — the feed, post details and every card — continues into weeks and then an
  absolute date. Below seven days the two produce identical strings, so adopting the shared one
  changes nothing recent and turns the tail into "Jul 7 · Jul 1 · Jun 10". Captured before and after
  → **fixed**.
- [D][both] **The list hides its own scroll indicator, and its bounce.** 47 rows in a `ScrollView`
  with `showsVerticalScrollIndicator={false}`, `bounces={false}` and `overScrollMode="never"`. Scroll
  views: the indicator exists to show "whether the currently visible content is near the beginning,
  middle, or end", and "if you build custom scrolling for a view, make sure your scroll indicators
  use the elastic behavior that people expect" → **deferred to F3, deliberately, with counts**: the
  hidden indicator is app-wide (17 call sites) and the disabled bounce is two files (this screen and
  `home-dashboard`). A bounce policy that differs per screen is exactly what the program's own
  ordering rule says to settle once in the system layer rather than screen by screen.
- [P][both] **Icon ratchet: 4 → 0.** The same toggle was drawn at 34pt in the push card and 32pt in
  the preference rows — one control, two sizes on one screen; both are `icon.hero` now. The two 21pt
  category glyphs moved to `icon.default`. The toggle's "on" green was a one-off `#6ee7b7` where the
  palette has `colors.success`.
- [P][both] Verified clean: **the permission ask explains itself before the system asks.** The push
  card names what the reader would get ("Get finished renders, creator activity, and unlock updates
  as native alerts") and only then triggers the OS prompt, and the denied state routes to Settings
  rather than re-prompting — the pre-permission pattern Managing notifications and Privacy both ask
  for.
- [P][both] Verified clean: **settings are changeable in the app.** Managing notifications:
  "you must also provide an in-app settings screen that lets people change their choice." The Alert
  types card does, per category, and each row is a `switch` with `accessibilityState`.
- [P][both] Verified clean: **the toggles carry state in shape as well as colour.** Toggles: "Avoid
  relying solely on different colors to communicate state" — the Lucide glyph moves its knob too.
- [P][both] Noted, not chased: **the category palette is private to this screen.** Four raw hexes
  (`#a78bfa`, `#fb7185`, `#fbbf24`, `#67e8f9`) in a design system that already has accent tokens —
  three map cleanly (`motion`, `commerce`, `info`) and the fourth, for creator activity, has no
  token at all. Changing three and leaving one would make the screen *less* internally consistent
  than it is → **F2**, with that mapping.

Guard added: `__tests__/hig-alerts-screen.test.ts` (16 cases) — the screen is titled the way the tab
that opens it is labelled and names its own controls the same, while the copy that points at the
platform keeps the platform's word; a foreground alert never plays a sound and drops its banner only
where it would repeat what is on screen, still filing itself in Notification Center; the screen
reports itself in and out of view, and the badge and list refresh the moment an alert lands; a link
that points back at this screen is recognised (with or without a query, trailing slash, or the
`(tabs)` prefix) and every other destination is left alone; such a row is marked read and nothing is
pushed; the root layout keeps the fallback that is still right; times read through the shared
formatter; the toggles carry state in shape, at one size, in the app's own green.

**AND-pass 2026-08-27** (mandatory: this unit changes navigation behaviour and notification
presentation). Pixel_9a, Android 16, dev client on the worktree's Metro after a forced reload. The
screen reads *Alerts*; a row with a real destination still opens the viewer and hardware back
returns to the list intact; the `@hello-athul followed you.` row was tapped and the list did not
move. Edge-to-edge unchanged. `logcat` clear of `FATAL`/`SIGSEGV`, app process alive throughout.

**Hand-offs to S26 (server-side, deliberately not on this mobile branch):**
- **Neither platform's per-category delivery control exists.** iOS: the Expo payload sets a
  transport `priority` but no `interruptionLevel`, where Managing notifications says "you need to
  specify a system-defined interruption level for each noncommunication notification you send" —
  the app's three categories map to it directly (generation and commerce *active*, social
  *passive*). Android: `lib/notifications.ts` registers exactly one channel, named "Default", so a
  user cannot silence creator activity in system settings without silencing finished renders, even
  though the in-app card already models those three categories. The channel half is client-side but
  pointless until the server sends a `channelId`, so both halves belong to one change.
- **Row bodies describe the app's policy instead of the event.** Every social row reads "Creator
  activity is grouped here to keep your phone quiet" — the same sentence under "Someone remixed your
  post" and "Someone saved your post", where the chapter asks for "concise, informative"
  content and the row has room to say *which* post. "Your image is ready / Open it in your mobile
  history" is the other shape the chapter warns about: "avoid sending a notification that tells
  people to perform specific tasks within your app". → X3 owns the words, S26 the payload.

### S4 home — audited 2026-08-27 · AND-pass: 2026-08-27
Chapters read: Toolbars (`toolbars`), Branding (`branding`), Motion (`motion`); Page controls,
Scroll views, Loading, Feedback and Layout were read earlier the same day for S12 and S10 and are
reused rather than refetched.

Home is a 1,400-line screen: a top bar, an auto-rotating rail of four slides, an onboarding resume
card, three feed lanes, and the community feed with its own paging, telemetry and moderation sheets.
Most of it is already careful — the findings are concentrated in the chrome above the feed.

- [V][both] **The top bar titled the view with the app's name.** A coral dot and the wordmark
  *Magicbooklet* sat in the title slot of every visit to the app's front door. Toolbars is verbatim:
  "Don't title windows with your app name. Your app's name doesn't provide useful information about
  your content hierarchy or any window or area in your app, so it doesn't work well as a title."
  Branding says the same from the other side — "people seldom need to be reminded which app they're
  using, and it's usually better to use the space to give people valuable information and controls",
  and "ensure branding always defers to content" → **fixed**: the slot is empty, which Toolbars
  explicitly allows ("if titling a toolbar seems redundant, you can leave the title area empty"),
  and the tab bar below already names the screen.
  - **This is the one finding in the unit that is a brand decision as much as a HIG one**, so it is
    flagged rather than buried: D2 settled "keep the brand", and this removes the wordmark from the
    one screen that showed it as chrome. What it does *not* do is remove the brand — the wordmark
    still opens the app on onboarding and sign-in, which is exactly the placement Branding endorses
    ("a welcome or onboarding screen that incorporates your branding content at the beginning of
    your experience"). If the product wants it back on Home, it belongs in the divergence ledger
    with a rationale that answers both chapters; it is a five-line revert either way.
- [V][both] **The bell announced a screen the app no longer has.** Its accessibility label read
  "Open studio activity" — a third name for the destination S10 renamed to *Alerts*, which is what
  the tab, the screen title and the badge all say now. A screen-reader user heard one name and
  landed on another → **fixed**: "Open alerts".
- [V][both] **A four-slide carousel said nothing about being four slides.** The rail snaps
  page-by-page, loops endlessly, and hides its scroll indicator; the only evidence that more existed
  was a sliver of the next card. Scroll views: "Consider showing a page control when a scroll view
  is in page-by-page mode … If you show a page control with a scroll view, don't show the scrolling
  indicator on the same axis" (the indicator was already off) → **fixed**: a four-dot page control,
  centred under the rail, current dot separated by contrast rather than hue (Page controls: "avoid
  coloring indicator images … custom colors can reduce the contrast that differentiates the
  current-page indicator"), announcing "Slide 2 of 4" to a screen reader, and drawing nothing at all
  below two slides.
  - **It earns its place most where nothing moves.** The rotation already stops for Reduce Motion,
    for a blur and for a touch, so with that setting on there was previously *no* signal that the
    rail had more in it. Motion asks exactly this: "make motion optional … avoid using it as the
    only way to communicate important information."
  - The timer's index stays a ref and the dots got their own state, so the dots never land in the
    interval effect's dependencies and can never restart the rotation mid-cycle. All three things
    that move the rail — the tick, a settled swipe, and the jump into the middle pass on load —
    update it, or the dots would lie.
- [D][both] **Icon ratchet: 3 → 0 on the dashboard, 2 → 0 on the feed card.** The crown at 15, the
  bell at 21 and the workspace wand at 17 moved onto the ramp; the feed card's action row went to
  one size, which is the same `icon.compact` row S12 settled for the identical actions on the post
  page. The crown's hardcoded `#fbbf24` became `colors.commerce`, the token that already holds that
  amber.
- [P][both] Verified clean: **the feed answers for itself in every state.** First load draws a
  skeleton, a failed load names itself with a Retry, an empty lane offers "Share the first post",
  paging shows a footer spinner and a load-more error footer with its own retry, and the list has
  pull-to-refresh. Loading ("show something as soon as possible … consider showing placeholder
  text, graphics") and Feedback ("show people when a command can't be carried out and help them
  understand why") are both met without changes.
- [P][both] Verified clean: **the rotation can be stopped and is already optional.** Motion's "let
  people cancel motion" and "make motion optional" are satisfied by
  `shouldAutoAdvanceHomeSlides`, which halts for Reduce Motion, for a blur, for a touch and for a
  single slide — pinned in `home-feed-view-model.test.ts`, so it is cited here rather than
  re-verified on device.
- [P][both] Noted for **Phase 6**: **two controls on one screen open Alerts, and only one of them
  counts.** The top bar's bell and the Alerts tab are both visible on Home; the tab carries the
  unread badge (N1) and the bell carries nothing. Badging a second control six inches from the
  first would be worse, so the question is whether the bell earns its place at all — a consistency
  call for the close-out walk rather than a fix to make mid-phase.
- [P][both] Noted, not chased: **`home-side-menu.tsx` still carries 11 off-ramp icon sizes** — the
  largest budget in the ratchet after the composer's 21. The menu is N3's surface and closed; the
  sizes are pre-existing. Whichever unit next opens that file should take it down.

Guard added: `__tests__/hig-home.test.ts` (11 cases) — the top bar does not title the view with the
app name while the wordmark stays where the chapter endorses it; the bell names the destination the
way the app names it; the rail shows a page control and keeps its scroll indicator off the same
axis; there are few enough dots to count at a glance; the control draws nothing below two slides,
separates the current dot by contrast rather than hue, and announces its position; the index follows
the tick, the settle and the load, and the interval's dependencies are unchanged so the dots cannot
restart it; the rotation stays gated on Reduce Motion.

**AND-pass 2026-08-27.** Pixel_9a, Android 16, dev client on this session's Metro. The empty title
slot, the four dots and the dot tracking a swipe were all captured; the auto-advance tracking was
captured on iOS. Edge-to-edge unchanged. `logcat` clear of `FATAL`/`SIGSEGV`, app process alive.

**Mechanic worth keeping:** the Metro this session inherited from another chat died mid-unit, which
looks like a device failure ("No development servers found", then `ECONNREFUSED 10.0.2.2:8081`) and
is not one. Check `lsof -nP -iTCP:8081 -sTCP:LISTEN` before debugging the app. Restarting it from
this session via `preview_start metro-hig` also buys `preview_logs`, which an inherited server does
not offer. Android reconnects with a force-stop and
`am start -a android.intent.action.VIEW -d "exp+magicbooklet-mobile://expo-development-client/?url=http://10.0.2.2:8081"`;
the plain `exp://10.0.2.2:8081` form does not resolve.
