import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { MagicbookletApiClient } from './api-client';
import {
  defaultInstallOnboardingState,
  mergeInstallOnboardingState,
  ONBOARDING_STORAGE_KEY,
  parseInstallOnboardingState,
  reconcileInstallOnboardingState,
  type InstallOnboardingState,
  type RemoteOnboardingState,
} from './onboarding-state';
import type { OnboardingEventName, OnboardingGoal } from './types';

type OnboardingContextValue = {
  state: InstallOnboardingState;
  isHydrated: boolean;
  storageAvailable: boolean;
  update: (value: Partial<InstallOnboardingState>) => Promise<InstallOnboardingState>;
  skip: () => Promise<InstallOnboardingState>;
  complete: () => Promise<InstallOnboardingState>;
  reconcileFromServer: (remote: RemoteOnboardingState) => Promise<InstallOnboardingState>;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState(defaultInstallOnboardingState);
  const stateRef = useRef(defaultInstallOnboardingState);
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(ONBOARDING_STORAGE_KEY)
      .then((value) => {
        if (active) {
          const parsed = parseInstallOnboardingState(value);
          stateRef.current = parsed;
          setState(parsed);
        }
      })
      .catch(() => {
        if (active) setStorageAvailable(false);
      })
      .finally(() => {
        if (active) setIsHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(async (value: Partial<InstallOnboardingState>) => {
    const next = mergeInstallOnboardingState(stateRef.current, value);
    stateRef.current = next;
    setState(next);
    try {
      await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next));
    } catch {
      setStorageAvailable(false);
    }
    return next;
  }, []);

  /**
   * Fold the account's server state in. Promote-only, and a no-op when nothing
   * changed — this runs on every app foreground, so an unconditional write here
   * would churn AsyncStorage and re-render the whole navigator for nothing.
   */
  const reconcileFromServer = useCallback(async (remote: RemoteOnboardingState) => {
    const next = reconcileInstallOnboardingState(stateRef.current, remote);
    if (next === stateRef.current) return next;
    stateRef.current = next;
    setState(next);
    try {
      await AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(next));
    } catch {
      setStorageAvailable(false);
    }
    return next;
  }, []);

  const contextValue = useMemo<OnboardingContextValue>(() => ({
    state,
    isHydrated,
    storageAvailable,
    update,
    skip: () => update({ status: 'skipped' }),
    complete: () => update({ status: 'completed' }),
    reconcileFromServer,
  }), [isHydrated, reconcileFromServer, state, storageAvailable, update]);

  return <OnboardingContext.Provider value={contextValue}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const value = useContext(OnboardingContext);
  if (!value) throw new Error('useOnboarding must be used within OnboardingProvider');
  return value;
}

export async function trackOnboardingEvent(
  api: MagicbookletApiClient,
  eventName: OnboardingEventName,
  options: { goal?: OnboardingGoal | null; step?: string | null } = {},
) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  const clientEventId = globalThis.crypto?.randomUUID?.()
    ?? await import('expo-crypto').then((crypto) => crypto.randomUUID());
  await api.recordOnboardingEvent({
    clientEventId,
    eventName,
    platform: Platform.OS,
    goal: options.goal,
    step: options.step,
    occurredAt: new Date().toISOString(),
  }).catch(() => undefined);
}
