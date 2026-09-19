# Creations follow-up fixes — 2026-09-16

## Scope and release status

Addresses R1–R4 from the review of PR #171, published source `2055c5e467b0adaba8efc6a8e1f791386800b342`.
Implementation branch: `fix/creations-review-followup`, worktree `edits-2026-09-16`.
These changes are local; no production OTA or store build has been published from this patch.

## Changes

| Finding | Cause | Change |
| --- | --- | --- |
| R1: wrong initial creation | Warm library items rendered before the requested ID resolved, letting position effects settle on the unrelated first item. | Gate the viewer's items, initial position and playback until the selected ID resolves; loading, error and missing states remain authoritative during initial selection. |
| R2: endless initial spinner | An absent primary result was treated as loading even after the primary request failed. Retry could target a disabled selection query. | Expose the primary failure and route Retry to the primary request. A running retry returns to loading. Both card feed and viewer can recover in place. |
| R3: image recovery starvation | Covered images kept global recovery slots while their deadlines were disabled; waiters had no terminal deadline. | Release slots on suspension, backgrounding or identity change; bound budget waiting; remember native display callbacks even when covered; reset recovery state for manual retry. |
| R4: skipped posts after refresh | Retained numeric offsets became obsolete after rows were removed ahead of the boundary. | Preserve cached cards but restart subsequent Posts/Saved paging at the freshly verified head boundary. Existing flatteners deduplicate overlap. Generation cursor behavior is unchanged. |

Offset continuation deliberately rereads overlapping pages as the reader asks for more. It does not eagerly refetch the entire library. This is a repair for head-refresh continuation, not snapshot isolation against arbitrary concurrent server writes.

## Automated validation

- Regression cases were added before implementation; the failure probes exposed primary-error handling, recovery ownership/waiting, and skipped pagination rows.
- Full mobile suite: **225 files / 2,171 tests passed**, repeated after the local session restarted.
- Mobile TypeScript checking passed.
- `git diff --check` passed.
- No web, API, database, native configuration, or dependency changes.

## Physical Android validation

Samsung SM-S928B, serial `RFCX40629WT`, Expo Go 55.0.7, actual source components imported into a local harness with controlled API/media responses. The full production shell could not run in Expo Go because its native metrics module is absent there.

Earlier in this task, before the local environment restarted:

- Warm-library missing-ID viewer showed loading followed by the missing-item state.
- Delayed selected-ID viewer showed loading followed by the requested `selected` item, with no `unrelated` item in the captured accessibility states.
- Primary read failure showed an error and Retry in both the viewer and card feed; retry loaded the selected item.
- Two stalled images acquired two slots. Covering them released both; the newly visible third image acquired a slot and retried.
- The phone retained the terminal “Taking too long to load” state after the desktop session restarted; that screen and accessibility dump were saved as `earlier-fixed-terminal.*`.

Those earlier temporary screenshot/log files were removed by the session restart; their results remain in the task transcript.

After restart, the native image test was repeated against both the published baseline component and the fixed component:

| Observation | Published baseline | Fixed component |
| --- | --- | --- |
| Two stalled images after their first deadline | Two recovery slots held | Two recovery slots held |
| Cover those images while leaving them mounted | Both slots remain held | Both slots released |
| Third visible image reaches its deadline | No retry; blocked by covered images | Acquires a slot and retries |
| Continued stall, captured around 70 seconds into the scenario | Third image still blank, no retry action | Finite attempts exhausted; “Taking too long to load” and Retry shown |
| Server resumes and user taps Retry | Not exercised | Actual app-icon image displayed, verified visually in the screenshot |

The native runner's last assertion initially expected a `recovered` diagnostic after manual retry. That expectation was incorrect: manual retry resets the attempt to zero, and the diagnostic intentionally records only automatic retry recovery. The raw log preserves that harness assertion failure. The screenshot proves the image rendered; the runner was corrected to require visual inspection there. No product change was needed for that assertion.

## Evidence

Local folder:

`/Users/athuls/UGC copy/archive/ugc-app-audits/creations-followup-fix-2026-09-16/`

- `mobile-tests.txt`: full mobile suite.
- `typecheck.txt`: TypeScript check.
- `harness/`: isolated native image-recovery reproduction, including the published baseline component and current component.
- Native XML/PNG captures and run logs alongside the harness.
- `native-baseline.txt` and `baseline-end.png`: native reproduction of recovery starvation.
- `native-fixed.txt`, `fixed-covered.png`, `fixed-visible.png`, `fixed-end.png`, and `fixed-manual-retry.png`: fixed native behavior through successful manual recovery.

## Limits

This patch fixes the four review findings. It does not prove the initiating cause of the earlier intermittent all-media-blank incident. Cache-hit measurements, signed-URL expiry/credential renewal, extended decoder/memory stress, iOS, and end-to-end checks of the next exact production OTA remain separate validation work. No production content was edited for these tests.
