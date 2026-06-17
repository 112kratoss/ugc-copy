# Showcase Save Hardening Plan

## Summary
Keep the current heart action as **Save/Bookmark**, not a separate Like feature. Fix toggle drift, stale mobile UI, misleading mobile action-sheet behavior, and missing save analytics by making saves idempotent end-to-end and returning canonical server state.

## Key Changes
- Add an idempotent save API contract:
  - Request: `{ postId, shouldSave, sourceSurface? }`
  - Response: `{ success: true, isSaved, saveCount, changed, message }`
  - Keep legacy `{ generationId }` support for older callers, but update web/mobile clients to send `postId`.
- Add a Supabase migration for `set_post_save_state(post_id, user_id, should_save)`:
  - Uses `INSERT ... ON CONFLICT DO NOTHING` for save.
  - Uses `DELETE ... RETURNING` for unsave.
  - Returns canonical `is_saved`, `save_count`, and `changed`.
  - Preserves the existing `toggle_post_save` function for compatibility.
- Add `post_save_events` analytics:
  - Columns: `id`, `user_id`, `post_id`, `requested_state`, `result_state`, `changed`, `source_surface`, `created_at`.
  - Record authenticated save/unsave attempts after the API resolves post identity.
  - Notify creators only when `shouldSave === true` and `changed === true`.

## Implementation Changes
- Web:
  - Update `useOptimisticPostSave` to accept a `sourceSurface`.
  - Send `{ postId: id, shouldSave }` instead of `{ generationId: id }`.
  - Continue optimistic UI, but reconcile with returned `isSaved` and `saveCount`.
  - This fixes the signed-in hydration race because stale “save” clicks become no-op saves instead of accidental unsaves.
- Mobile:
  - Update `api.saveShowcasePost(postId, { shouldSave, sourceSurface })`.
  - Update viewer/profile save mutations to optimistically patch React Query cache for active source data, showcase feed, showcase detail, and saved media.
  - Reconcile mobile UI from the server response so heart fill, label, count, and saved-feed membership update immediately.
  - Change showcase viewer actions from always `unsave` to `save` or `unsave` based on `item.isSaved`.
- Naming cleanup:
  - Rename client-side request variables from `generationId` to `postId` where the id is a post id.
  - Keep public UI copy as “Save” / “Saved” / “Unsave”; do not introduce “Like”.

## Test Plan
- Backend route tests:
  - Saving an unsaved post returns `isSaved: true`, increments count once, records analytics, sends notification.
  - Saving an already saved post returns `changed: false`, does not increment, does not notify again.
  - Unsaving a saved post returns `isSaved: false`, decrements count once.
  - Unsaving an already unsaved post returns `changed: false`, does not decrement.
  - Legacy `generationId` path still works.
- Web tests:
  - Optimistic save/unsave still updates button state and count.
  - Failed request rolls back.
  - Delayed saved-state hydration plus immediate click reconciles to server `isSaved`/`saveCount`.
- Mobile tests:
  - Viewer action model emits `save` for unsaved showcase items and `unsave` for saved ones.
  - `saveShowcasePost` sends `shouldSave` and auth header.
  - Viewer/profile save mutation updates cached item `isSaved`, `saveCount`, and saved-media membership.
- Verification commands:
  - `npm test -- --run src/__tests__/showcase-client-save-actions.test.tsx src/__tests__/showcase-saved-state-route.test.ts src/__tests__/showcase-saved-media-route.test.ts src/__tests__/home-showcase-preview-grid.test.tsx`
  - `cd ugc-mobile && npm test -- --run __tests__/viewer-actions.test.ts __tests__/profile-dashboard.test.tsx __tests__/profile-media-feed.test.tsx __tests__/immersive-preview-view-model.test.ts __tests__/api-client.test.ts`

## Assumptions
- No separate Like feature is being added.
- Save/bookmark remains the single engagement action behind the heart icon.
- Analytics v1 is event storage only; no admin dashboard is included in this fix.
