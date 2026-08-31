/**
 * Applies a downloaded OTA update when — and only when — the policy allows.
 *
 * expo-updates already downloads in the background and applies at the next cold
 * start. This hook exists to shorten that wait safely; it decides nothing
 * itself, it gathers the four facts `decideUpdateAction` asks for and carries
 * out the answer. If it were deleted tomorrow the app would still receive every
 * update, just later.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

import { subscribeToActivity } from './app-activity';
import { decideUpdateActionNow, type UpdateDecision } from './app-update-policy';
import {
  IDLE_CLOCK,
  advanceBackgroundClock,
  isReturnFromBackground,
  readCriticalFlag,
  type AppLifecycleState,
  type BackgroundClock,
} from './ota-update-gate';

export type OtaUpdateGate = {
  /** True while the critical-update sheet should be on screen. */
  criticalPromptVisible: boolean;
  /** Apply the update now, from the sheet's restart button. */
  applyNow: () => void;
  /** Keep working. This update will not prompt again in this session. */
  dismissPrompt: () => void;
};

export function useOtaUpdateGate(): OtaUpdateGate {
  const { isUpdatePending, isRestarting, downloadedUpdate } = Updates.useUpdates();
  const [criticalPromptVisible, setCriticalPromptVisible] = useState(false);
  const clockRef = useRef<BackgroundClock>(IDLE_CLOCK);
  const dismissedRef = useRef(false);
  const reloadingRef = useRef(false);

  const reload = useCallback(() => {
    // expo-updates is inert in Expo Go and the dev client, where reloadAsync
    // rejects rather than doing nothing — without this guard the only people
    // who would ever see this path fail are the developers working on it.
    if (!Updates.isEnabled || reloadingRef.current) return;
    reloadingRef.current = true;
    Updates.reloadAsync().catch(() => {
      // A failed reload is not worth surfacing. The update stays pending and
      // lands at the next cold start, which is exactly where it would have
      // landed if this hook did not exist.
      reloadingRef.current = false;
    });
  }, []);

  const evaluate = useCallback(() => {
    if (!Updates.isEnabled || isRestarting || reloadingRef.current) return;

    const decision: UpdateDecision = decideUpdateActionNow({
      isUpdatePending,
      isCritical: readCriticalFlag(downloadedUpdate),
      backgroundedForMs: clockRef.current.backgroundedForMs,
      criticalPromptDismissed: dismissedRef.current,
    });

    if (decision === 'apply-silently') reload();
    else if (decision === 'prompt') setCriticalPromptVisible(true);
  }, [downloadedUpdate, isRestarting, isUpdatePending, reload]);

  // Three signals, not a timer. A timer would fire mid-generation, get vetoed
  // by the activity lock, and burn battery re-asking; these are the three
  // moments where the answer can actually have changed.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const previous = clockRef.current;
      clockRef.current = advanceBackgroundClock(previous, next as AppLifecycleState, Date.now());
      if (isReturnFromBackground(previous, next as AppLifecycleState)) evaluate();
    });
    return () => subscription.remove();
  }, [evaluate]);

  // A download finishing.
  useEffect(() => {
    evaluate();
  }, [evaluate]);

  // The last activity lock releasing — a generation that vetoed the update a
  // minute ago has finished, and the user is now idle on a results screen.
  useEffect(() => subscribeToActivity((busy) => {
    if (!busy) evaluate();
  }), [evaluate]);

  const applyNow = useCallback(() => {
    setCriticalPromptVisible(false);
    reload();
  }, [reload]);

  const dismissPrompt = useCallback(() => {
    dismissedRef.current = true;
    setCriticalPromptVisible(false);
  }, []);

  return { criticalPromptVisible, applyNow, dismissPrompt };
}
