/**
 * When an already-downloaded OTA update is allowed to take effect.
 *
 * expo-updates does the fetching on its own: it checks on cold start, downloads
 * in the background, and swaps the new bundle in at the *next* cold start. That
 * default never interrupts anyone, which is why it ships first and alone. This
 * module governs the one thing added on top of it — deciding whether to call
 * `Updates.reloadAsync()` early, so a fix does not have to wait for a user to
 * fully quit the app.
 *
 * The policy the product settled on:
 *
 *   - Routine updates are silent. No banner, no prompt, no "what's new". A copy
 *     fix or a sheet animation fix should simply be correct the next time the
 *     app opens. Telling people their app changed invites them to look for the
 *     change, which is worse than the bug for anything this small.
 *
 *   - A build may be marked critical when it fixes something actively hurting
 *     users. Critical earns a visible prompt — but not the right to interrupt.
 *
 *   - Nothing, critical included, reloads while the app is busy. `hasActiveWork`
 *     is the veto, and it outranks every other signal here. See lib/app-activity.
 *
 * Keeping the decision in a pure function means the policy can be tested
 * exhaustively without a running app, an update server, or a real reload.
 */

import { hasActiveWork } from './app-activity';

/**
 * How long the app must have been away for a reload to read as a fresh launch.
 *
 * Thirty minutes, because the cost is asymmetric. Too short and someone who
 * glanced at a text message comes back to an app that blinked for no reason
 * they can see; too long and silent updates almost never land early and the
 * machinery earns nothing over the plain cold-start default. Half an hour is
 * past the point where a returning session already feels like a new one.
 */
export const FOREGROUND_RELOAD_THRESHOLD_MS = 30 * 60 * 1000;

export type UpdateDecisionContext = {
  /**
   * An update has finished downloading and is sitting ready. Always true when
   * this is called — the caller does not ask unless there is something to apply.
   */
  isUpdatePending: boolean;
  /**
   * The publisher marked this update critical, via `extra.critical` in the
   * update manifest. Routine updates are false.
   */
  isCritical: boolean;
  /**
   * Any screen currently holds an activity lock — a generation is running, a
   * media upload is in flight, or a purchase sheet is open.
   */
  hasActiveWork: boolean;
  /**
   * Milliseconds the app spent backgrounded before this foreground event. Zero
   * when the decision is being made for a reason other than foregrounding.
   */
  backgroundedForMs: number;
  /**
   * The user has already seen the critical prompt for this update and chose to
   * keep working. Asking again in the same session is nagging.
   */
  criticalPromptDismissed: boolean;
};

export type UpdateDecision =
  /** Reload now, with no UI. The user should not be able to tell this happened. */
  | 'apply-silently'
  /** Show the critical-update sheet and let the user choose when to restart. */
  | 'prompt'
  /** Do nothing. The update stays pending and applies at the next cold start. */
  | 'wait';

/**
 * Decide what to do with a pending update.
 *
 * The order of these checks is the policy. Read top to bottom:
 *
 *  1. Nothing to apply — nothing to do.
 *  2. **Busy always wins.** A generation, upload, or purchase in flight vetoes
 *     every reload including a critical one. This is the rule the product
 *     chose deliberately: the worst outcome is not a user running an old build
 *     for another ten minutes, it is a user watching a render they paid credits
 *     for vanish because the app restarted underneath them. Critical updates
 *     lose this argument on purpose.
 *  3. A critical update prompts as soon as it is safe, without waiting for the
 *     background threshold — that is the whole point of flagging it. Once the
 *     user has dismissed it, it stops asking and falls through to the silent
 *     path, so a dismissed critical update can still land quietly if they go
 *     idle later. It never re-prompts in the same session.
 *  4. Otherwise apply silently, but only after a long enough absence that the
 *     reload is indistinguishable from a normal launch.
 *  5. Anything else waits for the next cold start, which is expo-updates'
 *     own default and always correct.
 */
export function decideUpdateAction(context: UpdateDecisionContext): UpdateDecision {
  if (!context.isUpdatePending) return 'wait';
  if (context.hasActiveWork) return 'wait';

  if (context.isCritical && !context.criticalPromptDismissed) return 'prompt';

  if (context.backgroundedForMs >= FOREGROUND_RELOAD_THRESHOLD_MS) return 'apply-silently';

  return 'wait';
}

/**
 * Convenience wrapper that reads the live activity registry, so callers do not
 * have to remember to pass it and cannot accidentally pass a stale value.
 */
export function decideUpdateActionNow(
  context: Omit<UpdateDecisionContext, 'hasActiveWork'>,
): UpdateDecision {
  return decideUpdateAction({ ...context, hasActiveWork: hasActiveWork() });
}
