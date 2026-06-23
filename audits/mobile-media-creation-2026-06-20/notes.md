# Mobile Media Creation Audit

Date: 2026-06-20
Surface: Expo mobile media creation flow in `ugc-mobile`
Mode: Combined UX and accessibility audit
Destination: Local folder

## Audit Scope

This audit covers the current mobile creation entry and shared media creation screen for image, video, and motion. Evidence comes from Android emulator screenshots and accessibility tree snapshots captured during this run.

## User Goal

Start from the app's creation entry point, choose a creation type, understand required inputs, configure generation settings, and reach a clear generate-ready state.

## Evidence Set

- `00-current-state.png`: Existing video ready-check state found on emulator.
- `01-video-create-top.png`: Video flow mid-screen with prompt and essentials.
- `02-video-create-header.png`: Video flow header and prompt.
- `03-create-menu.png`: Bottom plus create menu.
- `04-image-create-header.png`: Image flow essentials and references.
- `05-motion-create-header.png`: Motion flow essentials and references.
- `06-video-ready-check-bottom.png`: Video ready-check blockers.
- `07-motion-enhance-empty-visible-state.png`: Motion screen after empty Enhance tap.
- `08-motion-ready-check-after-enhance.png`: Motion ready-check after empty Enhance tap.

## Step List

1. Create entry menu: Mixed health.
   The bottom plus menu is visually distinctive and offers two clear choices, Post and Create. The action cards sit very low in the sheet, close to the gesture area, and Post appears first even though the center plus visually suggests creation. This could create hesitation for users who tap plus expecting media creation.

2. Video creation header: Mixed health.
   The header summarizes tool, credits, and cost well. Cost visibility is strong. The page immediately shows that the user's 6 credits are far below a 615-credit video run. The downside is density: tool choice, balances, prompt, and settings all appear as equal-weight cards rather than a guided task.

3. Prompt panel: Mixed health.
   Required state and Enhance are visible. The prompt field is large and easy to target. However, Enhance errors are routed to the lower ready-check area, so an empty Enhance tap does not produce visible feedback near the button.

4. Essentials/model picker: Needs attention.
   Horizontal model cards are clipped on multiple tools. In the video and image captures, model cards and badges/text are cut off at the left or right edge. The tab bar overlaps the lower part of the model picker when Step 1 starts near the bottom of the viewport.

5. Image references state: Mixed health.
   The reference upload block is understandable, and attached images show handles users can reuse. The same screen also shows the bottom tab bar covering the Advanced section, so users can miss the next controls or assume the page ends there.

6. Motion creation state: Needs attention.
   Motion has a different job shape: prompt is optional, but character image and reference motion video are required. The shared order still places prompt first, so the required uploads appear below optional text. That makes the first visible task less aligned with the actual blocker.

7. Ready-check state: Mixed health.
   The readiness rows clearly classify prompt/media/settings/cost. However, errors are repeated in both readiness rows and the Generation checks panel. The repetition increases vertical length and makes the final action feel heavier than necessary.

8. Empty Enhance feedback: Needs attention.
   After tapping Enhance with an empty prompt, the visible area does not show feedback. The message appears only after scrolling to the ready-check panel. This is a feedback placement issue, especially because Enhance is a local action beside the prompt.

## Strengths

- The screen has a coherent dark visual system: cards, chips, metrics, and readiness rows feel like one product.
- Tool switching keeps image, video, and motion in one place instead of sending users through separate stacks.
- Cost and credit visibility are unusually clear for a generation flow.
- Readiness rows are a strong concept because they explain why Generate is disabled.
- Reference handles for image elements are discoverable once a reference is attached.

## UX Risks

1. Bottom tab overlap blocks content.
   Evidence: `02-video-create-header.png`, `04-image-create-header.png`, `05-motion-create-header.png`.
   The tab bar overlaps model cards, references, and Advanced. The layout has bottom padding, but intermediate scroll positions still allow important content to sit underneath the fixed bar.

2. Model picker clipping reduces confidence.
   Evidence: `01-video-create-top.png`, `04-image-create-header.png`, `05-motion-create-header.png`.
   Horizontal cards are partially cut off and text/badges can render outside visible bounds. Users may not know whether there are more models, which model is selected, or whether the card is intentionally cropped.

3. The shared flow order does not fit motion well.
   Evidence: `05-motion-create-header.png`, `08-motion-ready-check-after-enhance.png`.
   Motion requires media first, but the flow starts with an optional prompt. Users are shown optional work before the true blocker.

4. Error feedback is far from the action that triggered it.
   Evidence: `07-motion-enhance-empty-visible-state.png`, `08-motion-ready-check-after-enhance.png`.
   Empty Enhance feedback appears only in the lower Generation checks panel. The top prompt area does not show a message after the tap.

5. Error summaries repeat too much.
   Evidence: `06-video-ready-check-bottom.png`, `08-motion-ready-check-after-enhance.png`.
   Readiness rows and Generation checks repeat the same blocker categories. This is clear, but bulky.

6. Entry menu ordering may conflict with user expectation.
   Evidence: `03-create-menu.png`.
   The center plus implies create, but the first menu action is Post. This is not wrong, but it slows recognition.

## Accessibility Risks

- The bottom overlay can visually obscure focusable controls, making touch and assistive-tech navigation harder to reason about.
- Several controls have useful labels in the accessibility tree, but the full-screen dismiss layer in the create menu may complicate focus order.
- Model cards are focusable and descriptive, but visual clipping may make the perceived target smaller or incomplete.
- The empty Enhance error is not visually colocated with the triggering control. Screen reader announcement behavior was not verified.
- Screenshots cannot confirm contrast ratios, focus traversal quality, keyboard behavior, or screen reader announcements.

## Recommendations

1. Fix scroll padding and snap positions around the tab bar first.
   Ensure every section can rest above the floating tab bar with enough breathing room. The current overlap is the most concrete layout defect.

2. Replace the horizontal model carousel with a mobile-friendly selector.
   Consider a compact selected-model card plus "Change model" sheet, or a vertically stacked model list in a modal. This keeps model text legible and avoids clipped cards.

3. Reorder required work by tool.
   Keep the shared shell, but let each tool define its first required task:
   - Image: Prompt, then optional references.
   - Video: Prompt, then essentials/references.
   - Motion: Required character image and reference video, then optional prompt.

4. Move local action errors next to the local action.
   If Enhance needs prompt text, show a small inline message under the prompt controls and optionally scroll/focus the prompt field.

5. Collapse duplicate validation.
   Keep readiness rows as the primary checklist. Use the Generation checks panel only for details that are not already explained, or show a single concise "Fix 3 items" summary.

6. Tune the create menu labels/order.
   If the plus is meant to prioritize creation, put Create first or make the center plus open directly to Create with Post as a secondary option. If Post should remain first, rename the plus affordance or add a clearer menu title.

## Evidence Limits

- I did not complete a successful generation because the captured account has insufficient credits for the visible runs.
- I did not test native media picker upload completion.
- I did not test screen reader announcements directly.
- I did not test iOS safe-area behavior.
- Findings are based on Android emulator screenshots, accessibility tree snapshots, and the current code paths for the shared creation screen.
