# Create Media Page Critique

Date: 2026-06-20
Scope: Mobile app Create media page, image mode, local Android emulator.

## Evidence

- `01-top-metrics-before-rearrange.png` - user-provided earlier state showing credits/cost near the top.
- `02-live-emulator-current.png` - prompt editing state with keyboard open.
- `05-live-create-reopened.png` - center create entry chooser.
- `06-live-create-top.png` - current Create page with Prompt, References, and Essentials ordering.
- `07-live-create-lower.png` - lower settings and first view of Generate.
- `08-live-create-generate.png` - Generate readiness and blockers.
- `09-live-create-generate-button.png` - credits, cost, and Generate button.

Evidence limits: this review covers the local emulator in image mode only. I did not test the native image picker, uploaded reference preview state with real files, video mode, motion mode, screen reader output, or dynamic type scaling.

## Overall Read

The page is moving in the right direction. Prompt, references, settings, and generate now form a sensible creation path, and moving credits/cost near Generate is the right product decision. The biggest remaining UX problem is density: the page still feels like a series of heavy cards, and the final action is too far down for something the user needs to trust quickly.

## What Works

- The new order is clearer: prompt first, references close to the prompt, settings after that, review and generate at the end.
- Reference media is now treated as part of the creative input instead of a late advanced option.
- Credits and cost are now contextual to the final action, which is much better than showing them near the top.
- The readiness cards explain why Generate is blocked, which reduces mystery.
- Collapsing Advanced is correct. Most users should not have to parse JPG, search, seed, or style controls on every run.

## Critique Findings

1. Entry chooser adds a modal step before creation.
   - Screenshot: `05-live-create-reopened.png`
   - Health: Mixed
   - The Create/Post chooser is understandable, but it delays the user by one tap every time. It also uses two very large actions with little hierarchy beyond color. This is okay if Post and Create are truly equal-frequency actions, but if media creation is the primary use of the plus button, Create should feel faster.

2. The first viewport is still partially lost to vertical ceremony.
   - Screenshot: `06-live-create-top.png`
   - Health: Needs attention
   - The prompt card is partly offscreen, then References and Essentials follow as full bordered cards. The user can understand the sequence, but the screen does not yet feel quick. A compact header and shorter cards would let Prompt plus References fit with more breathing room.

3. References are in the right place, but the empty state needs sharper language.
   - Screenshot: `06-live-create-top.png`
   - Health: Mixed
   - "Reference images (0/1..." truncates, and "Upload from your phone" is generic. Since references are optional in image mode, the UI should say that plainly and should explain the benefit: "Add a reference image for style, pose, product, or face consistency." The add button can be more direct: "Add reference".

4. Essentials is too heavyweight for common settings.
   - Screenshots: `06-live-create-top.png`, `07-live-create-lower.png`
   - Health: Mixed
   - The selected model card is attractive, but it consumes a lot of vertical space for a default choice. Aspect ratio and resolution chips are practical, but the overall section still feels like a settings panel rather than a fast creation step. Rename "Essentials" to "Settings" and compress the selected model into a row with a "Change" action.

5. Bottom navigation competes with the page task.
   - Screenshots: `07-live-create-lower.png`, `08-live-create-generate.png`, `09-live-create-generate-button.png`
   - Health: Needs attention
   - The floating tab bar and center plus button cover or visually crowd the lower Create flow. This is most noticeable when the Generate card comes into view. On a creation page, persistent app navigation should either hide, shrink, or the content should reserve enough bottom padding so the final button never feels buried.

6. Generate is clear, but too redundant.
   - Screenshots: `08-live-create-generate.png`, `09-live-create-generate-button.png`
   - Health: Mixed
   - The page shows readiness rows, then a separate "Generation checks" panel, then credits/cost, then the disabled Generate button. The user gets the message, but the blockers are repeated. A single "Review" stack would be cleaner: blockers first, then credits/cost, then action.

7. The cost/credit placement is now correct, but the action should be easier to reach.
   - Screenshot: `09-live-create-generate-button.png`
   - Health: Good direction, needs polish
   - Credits 6 and Cost 8 are exactly where they should be: beside the run button. The next improvement is to make this a sticky review bar above the tab bar, so users do not have to scroll to discover whether they can generate.

8. Prompt mention behavior needs a clearer recovery path.
   - Screenshots: `08-live-create-generate.png`, `09-live-create-generate-button.png`
   - Health: Needs attention
   - The prompt contains `@26`, and the UI reports "Unknown element mention: @26." That validation is useful, but the recovery action is unclear. The error should offer one direct fix: remove mention, create a named reference, or choose from known references.

9. Keyboard state makes the page feel cramped.
   - Screenshot: `02-live-emulator-current.png`
   - Health: Needs attention
   - While editing the prompt, the keyboard and floating controls reduce context. The page should actively scroll the prompt into a comfortable editing position and keep the next action visible. This matters because prompt editing is the main creative work.

## Improvement Plan

### Phase 1 - Tighten The First Viewport

- Make the top Create header compact and less card-like.
- Keep tool switching visible, but reduce the header height.
- Rename "Essentials" to "Settings".
- Shorten prompt helper copy so the first screen quickly communicates: what am I making, what do I need to provide, what can I optionally add?

### Phase 2 - Make References Feel Useful, Not Administrative

- Change empty state copy to explain why references help.
- Avoid truncating the media count. Use a compact badge like `0 / 1`.
- Rename "Add images" to "Add reference".
- Keep tap-to-preview.
- Keep reference names, but consider an edit affordance instead of always-visible text inputs if rows become tall after upload.

### Phase 3 - Compress Settings

- Convert the selected model card into a compact selected row.
- Move full model description/details into the model picker sheet.
- Keep aspect ratio and resolution chips visible, since those are high-confidence creation controls.
- Keep Advanced collapsed by default.

### Phase 4 - Redesign Generate As A Review Bar

- Put credits, cost, blockers count, and Generate into one sticky bottom review area above the app tab bar.
- Keep detailed checks in an expandable panel called "Review issues".
- Remove duplication between readiness rows and the Generation checks panel.
- Give blocker rows direct actions, for example "Fix mention" or "Add credits".

### Phase 5 - Handle Tool-Specific Order

- Image: Prompt, References, Settings, Generate.
- Video: Prompt, references or start frame, model/duration/sound, Generate.
- Motion: Required source media first, optional prompt second, Settings, Generate.

### Phase 6 - Accessibility And QA

- Verify bottom padding on small Android screens so Generate is never covered by the tab bar.
- Verify keyboard-aware scroll when prompt editing.
- Check truncation for reference count, model names, and blocker text.
- Add screen reader labels for readiness state, cost, credits, disabled Generate reason, and reference preview controls.
- Verify color contrast for amber blockers and disabled button text.

## Recommended Priority

Start with Phase 4 plus the bottom navigation spacing. It has the biggest practical payoff because it turns the final step from a buried scroll target into a trustworthy review/action area. Then tighten the first viewport and reference empty state.
