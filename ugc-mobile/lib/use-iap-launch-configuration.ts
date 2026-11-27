import { useEffect, useMemo, useState } from 'react';
import { InteractionManager, Platform } from 'react-native';

import { configureIapForUser } from './iap';
import { IAP_LAUNCH_CONFIGURE_DELAY_MS, createIapLaunchConfigurator } from './iap-launch-configuration';

/**
 * Sets RevenueCat up for the current identity once the shell is ready and the launch has settled,
 * and again whenever the identity changes (`iap-launch-configuration.ts`). Mounted once, from the
 * root layout.
 */
export function useIapLaunchConfiguration(identityUserId: string | null, shellReady: boolean) {
  const [due, setDue] = useState(false);
  const configurator = useMemo(
    () => createIapLaunchConfigurator({ configure: configureIapForUser, os: Platform.OS }),
    [],
  );

  useEffect(() => {
    if (!shellReady || due) return;
    let interaction: { cancel: () => void } | null = null;
    const timer = setTimeout(() => {
      interaction = InteractionManager.runAfterInteractions(() => setDue(true));
    }, IAP_LAUNCH_CONFIGURE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      interaction?.cancel();
    };
  }, [due, shellReady]);

  useEffect(() => {
    if (due) void configurator.sync(identityUserId);
  }, [configurator, due, identityUserId]);
}
