# Post details → Remix → return: analysis and plan

Date: 2026-08-30. Branch: `codex/edits-2026-08-30`, based on `762b3a6`.

Scope: native mobile viewer, Details, and the remix editor. Implementation is now complete in this worktree; see the implementation record below. Findings and source line numbers in the original analysis describe the baseline before edits.

## Findings, in priority order

### 1. High: the viewer and Details disagree about the visible page

The screenshot is consistent with two independent back controls overlapping:

- `ugc-mobile/components/post-details-page.tsx:390`: Details owns a header whose back control returns to the media/post.
- `ugc-mobile/app/viewer.tsx:839`: the viewer owns a floating back control that exits the viewer. It hides only when `detailsOpenForActive` is true.
- `ugc-mobile/app/viewer.tsx:1096`: the horizontal slide tracks its page in `currentHorizontalIndex` and separately reports a boolean to the parent.
- `ugc-mobile/app/viewer.tsx:772`: every vertical momentum-end callback clears `detailsPageOpenItemId`, including callbacks that settle on the current post. It does not move the horizontal pager off Details.
- `ugc-mobile/app/viewer.tsx:811`: any mounted slide can publish a false Details state and clear the parent's marker; the callback does not verify that the reporting slide is active.

Remix pushes `/create/[tool]`; Close calls `router.back()`. Both routes have native headers disabled. There is no evidence that a second native navigation header needs to be hidden.

Validation: extracted the actual vertical callback from the TypeScript syntax tree and invoked it with an unchanged vertical offset while the child remained on Details. The resulting state was `detailsPageOpenItemId = null`, with both viewer-exit and Details-back visibility conditions true. This confirms a code path producing the reported overlap. It does not establish which native callback/refetch sequence occurs on the user's iOS build; that requires device instrumentation.

The same state also governs hardware Back, outer scrolling, and video blocking. This is a navigation-state defect, not just icon placement. Audio/scroll side effects need verification rather than assumption.

### 2. High: Remix can replace an unrelated draft, and fast Close can miss the last edit

`ugc-mobile/components/media-creation-screen.tsx:483` skips loading existing drafts for a remix, but the persistence effect at line 505 still writes all three tool drafts after 350 ms. `ugc-mobile/lib/creation-draft-resume.ts:9` uses one shared storage key. Consequently, a remix session can overwrite the ordinary Create draft set, including other tools initialized to defaults.

The timeout is cancelled on unmount; Close does not explicitly flush pending edits. The close control nevertheless announces that the draft is saved. Treat reliable draft recovery as part of the return flow.

### 3. Medium: the public remix metric counts opening the editor

`src/lib/showcase-remix-service.ts:182` increments the post's remix count and then issues a `post_remixed` notification before returning the editor destination. Closing without generating still counts. This is consistent with the screenshots changing from 6 to 8, although screenshots alone cannot attribute those two increments.

Recommendation: retain opening as internal `remix_start` analytics; define public “remixes” as successful generated remixes, counted once per resulting generation. Audit other remix types and existing attribution before changing this shared backend behavior. Do not silently reinterpret historical counts.

### 4. Medium: the editor loses the source context; resources take too much reading to use

The editor title is always “Create,” even when launched from a specific post. The generic close accessibility hint says “previous tab,” although this flow returns to Details. The resource screenshot places a long prompt and descriptive boilerplate ahead of the next resources and its copy action.

Existing strengths to preserve: a prominent Remix button; a separate Save/Share/Comments row; visible model selection; reference thumbnails; and a Generate button with its credit price.

## Intended interaction

| Surface | Leading control | Result |
| --- | --- | --- |
| Post media | Back | Return to the feed/profile that opened it |
| Post details | Back to media/post | Return within this post, ideally to the media item previously viewed |
| Remix editor | Close remix | Restore the same source post, Details page, and vertical reading position |
| Model/reference/settings overlay | Close overlay | Reveal the unchanged editor |

Repeated open/close cycles must not add duplicate viewer routes, reset the source post, expose two back actions, or count as completed remixes. Opening from media should return to media; opening from Details should return to Details. No generation charge should occur merely from opening or closing the editor.

Keep the existing full-screen editor and Details pager. A new modal stack or broad navigation redesign is unnecessary for this fix.

## Proposed UI

- Details: stable header with one contextual Back control and More options. Keep title/byline, primary Remix, and secondary Save/Share/Comments in their current hierarchy.
- Resources: show access status once. Use a compact prompt preview with **Copy prompt** and **Show full prompt** visible without reading the entire prompt. Copy always copies the full source. Keep expanded text selectable, and retain creator-authored descriptions while removing redundant system boilerplate.
- References and settings: expose thumbnails and concise model/settings information ahead of long notes where the bundle permits. Preserve media-specific resource grouping and purchased-access rules.
- Remix: use “Remix” as the contextual title, with a compact source thumbnail/title/byline. Keep model selection and the priced Generate action. Make reference replacement/removal clear and preserve compatible edits when changing modes.
- Restoration: show which prompt/settings/references are loading; explain missing or unsupported inputs. Offer Retry and an explicit choice to continue with available inputs. Do not allow a late restore to overwrite user edits.
- Closing: untouched sessions close immediately. Edited sessions save to their own resumable draft and flush before exit. If saving fails, disclose it and allow retry or explicit discard; never claim successful saving without confirmation. Define running-generation recovery through Studio separately from cancelling a request.

## Implementation order

1. **Capture and repair the navigation defect.** Add temporary local event tracing for focused route, active post ID, settled horizontal page, vertical settle, and Details visibility. Trace only IDs/state, not prompt or reference contents. Reproduce the exact iOS sequence before removing instrumentation.
2. **Give page state one authority.** Use a viewer position controller keyed by stable post identity and page identity. Derive header visibility, Back behavior, media blocking, and outer-scroll eligibility from it. An unchanged vertical settle is a no-op. Only the active slide can change active page state. Preserve the active post through focus/refetch and reconcile its identity if the source reorders; define a fallback if it disappears. Native pager position must restore consistently after remount/layout changes.
3. **Preserve the navigation contract.** Return with one stack pop to the existing viewer. Keep Details scroll position while the editor is open. Distinguish navigation focus from changing the active post. Scope iOS route-pop gestures so they do not bypass Details-to-media Back; check Android hardware Back and reduced-motion paths too. Do not force a remount or reset to media as a workaround.
4. **Make draft recovery safe.** Separate normal creation and remix-session storage, including source attribution. Save only relevant drafts, flush pending writes on exit, surface failures, and support resuming the same remix without restoring over edits. Cover fast Close and backgrounding.
5. **Apply contextual UI changes.** Add source context and accurate close labels, then compact prompt/resource presentation. Keep the familiar creation controls and avoid duplicating the primary action.
6. **Address metric semantics separately.** Trace generation completion and remix attribution across image/video/motion and other remix types. Move public count/notification to the agreed completion event with idempotency. Keep start analytics and explicitly decide historical-count treatment.

The first delivery should be the navigation repair and behavioral regression coverage. Draft safety follows before cosmetic polish. Metrics need a coordinated backend change, not a mobile-only adjustment.

## Acceptance checks

- Open post → Details → Remix → Close, repeated ten times: same post, page and scroll position; exactly one visible and accessible Back control; Back returns to media.
- Same-index vertical settle, inactive-slide callback, source refetch/reorder, focus loss/return, and orientation/layout change cannot desynchronize visible page and navigation state.
- A real vertical move to another post has an intentional initial page; inactive posts cannot control the current header.
- Cover image/video/motion sources, multi-media posts, text-post Details, saved/profile entry, deep links, creator-profile return, auth/unlock return, and slow/error restoration.
- Check iOS close/edge gestures, Android hardware Back, video audio behavior, large text, VoiceOver/TalkBack, and 48-point existing header targets. Offscreen controls must not remain accessible.
- Editing and closing within 350 ms preserves the final edit. Existing ordinary drafts and other tool drafts remain unchanged. Failure paths never falsely say “saved.”
- Open/close does not spend generation credits. After the separate metric change, abandoned sessions do not increase public completed-remix counts; duplicate completion callbacks cannot double-count.

Existing checks run during analysis: five suites, 35 tests passed (`post-details-navigation`, `post-details-view-model`, `immersive-slide-pages`, `create-tool-screen`, `creation-draft-resume`). The navigation suite checks source strings, not this lifecycle, so its passing result does not rule out the bug. Add behavioral coverage and a native reproduction, rather than more source-string assertions.

At the initial analysis stage, native simulator reproduction, full runtime accessibility checks, and full app testing had not been performed. Subsequent implementation verification is recorded below. Browser emulation alone would not establish the iOS native event sequence.

Framework reference: React Native documents that FlatList does not preserve internal item state outside its render window and that externally dependent rendering state must be supplied explicitly: https://reactnative.dev/docs/flatlist. This supports keeping navigation-critical state outside a virtualized cell; it does not prove the user's specific trigger.

## Implementation record

- Viewer position now has one owner, keyed by post and media identity. Same-post vertical settles do not clear Details, inactive slides cannot change the active page, and refetch/reorder preserves the selected post. Details Back returns to the last viewed media. Native pop gestures are disabled while Details owns Back; offscreen pages are hidden from accessibility. Programmatic horizontal navigation respects reduced motion.
- Ordinary creation and remix drafts use separate storage. Remix storage is scoped to account and source. Serial autosaves and an exit/background flush preserve the final edit; read/write failures are visible, and closing without saving requires an explicit choice. A native pop cannot reach that guard at all — it completes before JS is consulted — so the editor route withdraws the gesture instead: the iOS 26 full-screen pan is off statically in `app/_layout.tsx`, and the edge swipe is withdrawn for as long as the session has an edit to lose. An untouched session keeps both. Resuming a remix does not restore source values over saved edits. Late or cancelled restoration preserves edits and can retry; generation is blocked until restoration completes or the user explicitly accepts available inputs.
- The editor displays “Remix,” its source title/creator/thumbnail, and accurate Close wording. Prompt resources show Copy prompt and a compact expandable preview; copying always uses the full text. Creator descriptions remain, while the composer's own prompt-card line is dropped in `normalizePostResourceSections` — the one funnel every read and write passes through — so it leaves stored rows on the way out, never reaches a new one, and reads the same on web and mobile whatever app version wrote it. The composer no longer writes it, a migration clears the rows that already had it, and the mobile-side filter stays as the last guard for an old app paired with an old backend.
- Editor opens retain start analytics but no longer increment public remixes or notify the creator. A database ledger counts successful attributed generations once, after an output exists. Notifications are attempted after successful settlement, deduplicated per output, and cannot reverse credit settlement if delivery fails.
- The migration archives old start counts in `posts.legacy_remix_start_count`, rebuilds completed counts from available generation lineage, and suppresses notifications for historical rows. The legacy counter RPC remains callable by the backend as a no-op during rollout.

## Verification and limits

- Native iOS 26.4 / iPhone 17 Pro simulator: ten Post Details → Remix → Close cycles on the reported “ghost rider” post. Each returned with one accessible Back to media action, no overlapping viewer-exit action, and the same source post. The public remix count stayed at 10. Back to media was also verified after the final navigation changes. Screenshots and cycle results are in `audits/remix-return-2026-08-30/`. The gesture behaviour was then verified directly on the same simulator: before the fix a pan starting mid-screen popped the editor; after it, that pan does nothing, the edge swipe still leaves an untouched session, and one keystroke is enough to stop the edge swipe leaving.
- Full mobile Vitest suite: 170 files / 1,644 tests passed. Regression coverage includes stable viewer identity, inactive callbacks, fast-close draft flushing, save failure, resume/restore races, the dirty-session gesture withdrawal, and full-prompt copying.
- Full web Vitest suite: 728 files / 5,173 tests passed. Scoping the earlier run to the backend service and migration-guard suites hid two failures: `backend-owned-rpc-security` and `showcase-remix-route` both still asserted the removed `increment_post_remix_count` call, and now pin its absence instead. The pre-existing shared-reference test in `generation-services` still exceeds its default five-second timeout under full-suite load and passes on rerun; it is unrelated to this change.
- Web and mobile application TypeScript checks, the separate web test TypeScript check, and ESLint on changed backend files passed; `git diff --check` passed.
- Production data, read-only: the boilerplate transform was run as a SELECT over the live rows before writing the migration. Five bundles and five revisions carry the line; the section count is unchanged by it, and no creator-written description exists anywhere in either table, so there is nothing else the update could touch.
- Real local Postgres: the new migrations executed successfully, all twelve pgTAP assertions passed, including the two covering a deleted remix taking its visible count back down, and a separate historical-backfill transaction passed three assertions. Both transactions rolled back. No existing local database was reset; a complete clean migration-history replay remains for CI.
- Android hardware Back, full VoiceOver/TalkBack interaction, large text, every entry/source type, video audio behavior, and device layout changes have not received runtime verification. No paid generation was started and no generation credits were spent during verification.
- Temporary instrumentation was removed. Application source changes remain uncommitted in the worktree; the original checkout is unchanged.

## Rollout

Nothing has been deployed and the migration has not been applied persistently. Release through the repository's normal Quality and production-release workflow: apply the migration, deploy the matching backend, and release the mobile changes. Old backend instances may still emit start-based notifications until replaced, even though the legacy counter RPC becomes a no-op. Historical visible counts may decrease because only completed generations with known lineage can be reconstructed; the archived metric remains available for audit.

For local review, the worktree's Metro server runs on port 8082 and its Next API on port 3001. The simulator is connected to that worktree. These are ignored local environment settings, not committed production configuration.
