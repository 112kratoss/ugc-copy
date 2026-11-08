import { useIsFocused } from '@react-navigation/native';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { shouldReopenSetup, wasSetupShownThisRun, markSetupShownThisRun } from '@/lib/setup-reopen';
import { useOnboardingDestination } from '@/lib/use-onboarding-destination';

/**
 * Opens an unfinished creator setup when Home comes into view, once per app
 * start (`lib/setup-reopen.ts`). Renders nothing.
 */
export function SetupReopen() {
  const destination = useOnboardingDestination();
  const isFocused = useIsFocused();

  useEffect(() => {
    if (!isFocused || !shouldReopenSetup(destination, wasSetupShownThisRun())) return;
    markSetupShownThisRun();
    router.push('/onboarding' as never);
  }, [destination, isFocused]);

  return null;
}
