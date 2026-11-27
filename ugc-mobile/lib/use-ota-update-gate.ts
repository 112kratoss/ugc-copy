/**
 * Applies a downloaded OTA update when — and only when — the policy allows.
 *
 * expo-updates already downloads in the background and applies at the next cold
 * start. This hook exists to shorten that wait safely; it decides nothing
 * itself, it gathers the four facts `decideUpdateAction` asks for and carries
 * out the answer. If it were deleted tomorrow the app would still receive every
 * update, just later.
 *
 * Whether an update is critical is the server's to say (`criticalUpdate` on
 * `/api/app-version`), asked once for each update downloaded, with the
 * manifest's own `extra.critical` as a second source.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';

import type { MagicbookletApiClient } from './api-client';
import { hasActiveWork, subscribeToActivity } from './app-activity';
import { claimAppReload, releaseAppReload } from './app-reload-claim';
import { decideUpdateActionNow, type UpdateDecision } from './app-update-policy';
import {
  IDLE_CLOCK,
  advanceBackgroundClock,
  isCriticalUpdate,
  isReturnFromBackground,
  type AppLifecycleState,
  type BackgroundClock,
} from './ota-update-gate';
import { checkAndFetchUpdate, effectiveBackgroundedForMs, shouldCheckForUpdateOnReturn } from './ota-update-check';
import type { MobileCriticalUpdate } from './types';

export type OtaUpdateGate = {
  /** True while the critical-update sheet should be on screen. */
  criticalPromptVisible: boolean;
  /** Apply the update now, from the sheet's restart button. */
  applyNow: () => void;
  /** Keep working. This update will not prompt again in this session. */
  dismissPrompt: () => void;
};

/** What the server said about one downloaded update. */
type ServerCriticalAnswer = { updateId: string; criticalUpdate: MobileCriticalUpdate | null };

export function useOtaUpdateGate(api: Pick<MagicbookletApiClient, 'getAppVersion'>): OtaUpdateGate {
  const { isUpdatePending, isRestarting, downloadedUpdate } = Updates.useUpdates();
  const [criticalPromptVisible, setCriticalPromptVisible] = useState(false);
  const [serverAnswer, setServerAnswer] = useState<ServerCriticalAnswer | null>(null);
  const clockRef = useRef<BackgroundClock>(IDLE_CLOCK);
  const dismissedRef = useRef(false);
  const reloadingRef = useRef(false);
  // The update the server has been asked about, so each is asked about once.
  const askedUpdateIdRef = useRef<string | null>(null);
  // The check on return (lib/ota-update-check.ts): when the app last came back, whether an update
  // already waited then, when the server was last asked, and whether it is being asked now.
  const returnedAtRef = useRef<number | null>(null);
  const pendingAtReturnRef = useRef(false);
  const lastCheckAtRef = useRef<number | null>(null);
  const checkingRef = useRef(false);

  // A rollback directive has no id, and is never the server's to flag.
  const pendingUpdateId = isUpdatePending && typeof downloadedUpdate?.updateId === 'string'
    ? downloadedUpdate.updateId
    : null;
  const isCritical = isCriticalUpdate(
    downloadedUpdate,
    serverAnswer && serverAnswer.updateId === pendingUpdateId ? serverAnswer.criticalUpdate : null,
  );

  // Asked when the download lands, not at launch: the answer then speaks of the
  // update actually waiting, and the start-up version check never waits on it.
  const askServer = useCallback(() => {
    if (!Updates.isEnabled || !pendingUpdateId || askedUpdateIdRef.current === pendingUpdateId) return;
    const updateId = pendingUpdateId;
    askedUpdateIdRef.current = updateId;
    api.getAppVersion()
      .then((response) => setServerAnswer({ updateId, criticalUpdate: response.criticalUpdate ?? null }))
      .catch(() => {
        // Unanswered: the manifest's own flag still counts, and the next
        // return to the app asks again.
        if (askedUpdateIdRef.current === updateId) askedUpdateIdRef.current = null;
      });
  }, [api, pendingUpdateId]);

  const reload = useCallback(() => {
    // expo-updates is inert in Expo Go and the dev client, where reloadAsync
    // rejects rather than doing nothing — without this guard the only people
    // who would ever see this path fail are the developers working on it.
    if (!Updates.isEnabled || reloadingRef.current) return;
    // One reload at a time: a root remounted in this runtime may be reloading
    // it already (lib/root-remount-reload.ts), and the update then lands at
    // the next one.
    if (!claimAppReload()) return;
    reloadingRef.current = true;
    Updates.reloadAsync().catch(() => {
      // A failed reload is not worth surfacing. The update stays pending and
      // lands at the next cold start, which is exactly where it would have
      // landed if this hook did not exist.
      reloadingRef.current = false;
      releaseAppReload();
    });
  }, []);

  const evaluate = useCallback(() => {
    if (!Updates.isEnabled || isRestarting || reloadingRef.current) return;

    const decision: UpdateDecision = decideUpdateActionNow({
      isUpdatePending,
      isCritical,
      backgroundedForMs: effectiveBackgroundedForMs({
        backgroundedForMs: clockRef.current.backgroundedForMs,
        pendingAtReturn: pendingAtReturnRef.current,
        returnedAtMs: returnedAtRef.current,
      }),
      criticalPromptDismissed: dismissedRef.current,
    });

    if (decision === 'apply-silently') reload();
    else if (decision === 'prompt') setCriticalPromptVisible(true);
  }, [isCritical, isRestarting, isUpdatePending, reload]);

  // A return after a long absence asks the update server, never during a purchase, a run or an
  // upload, and at most once per interval. What it fetches makes `isUpdatePending` true, and the
  // gate decides on that as on any download. Failures leave the cold start's check.
  const checkForUpdate = useCallback(() => {
    const nowMs = Date.now();
    if (!shouldCheckForUpdateOnReturn({
      enabled: Updates.isEnabled,
      isUpdatePending,
      checking: checkingRef.current,
      hasActiveWork: hasActiveWork(),
      backgroundedForMs: clockRef.current.backgroundedForMs,
      lastCheckAtMs: lastCheckAtRef.current,
      nowMs,
    })) return;
    checkingRef.current = true;
    lastCheckAtRef.current = nowMs;
    void checkAndFetchUpdate(Updates).finally(() => {
      checkingRef.current = false;
    });
  }, [isUpdatePending]);

  // Three signals, not a timer. A timer would fire mid-generation, get vetoed
  // by the activity lock, and burn battery re-asking; these are the three
  // moments where the answer can actually have changed.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      const previous = clockRef.current;
      clockRef.current = advanceBackgroundClock(previous, next as AppLifecycleState, Date.now());
      if (isReturnFromBackground(previous, next as AppLifecycleState)) {
        returnedAtRef.current = Date.now();
        pendingAtReturnRef.current = isUpdatePending;
        askServer();
        evaluate();
        checkForUpdate();
      }
    });
    return () => subscription.remove();
  }, [askServer, checkForUpdate, evaluate, isUpdatePending]);

  // A download finishing: the server is asked about it, and its answer
  // arriving is another chance to decide.
  useEffect(() => {
    askServer();
  }, [askServer]);

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
