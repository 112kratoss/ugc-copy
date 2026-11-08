import { useEffect, useState, useSyncExternalStore } from 'react';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';

import { FirstOpenIntro } from '@/components/first-open-intro';
import { useAuth } from '@/lib/auth';
import { decideFirstOpenIntro, markFirstOpenIntroSeen, readFirstOpenIntroSeen, setFirstOpenIntroShowing } from '@/lib/first-open-intro';
import { isLaunchSplashCovering, subscribeLaunchSplash } from '@/lib/launch-splash';
import { useOnboarding } from '@/lib/onboarding';

type HostPhase = 'deciding' | 'showing' | 'done';

/**
 * Plays the first-open intro once, at a cold start, as the logo splash lifts.
 *
 * Rendered just under the launch splash, so the intro's ground is already
 * there when the logo fades and the page slides in over it; the screen the app
 * opened on (Home, for a new install) is set up beneath it the
 * whole time. Whether it plays is decided while the logo still covers the app:
 * if the answer is not known by the time the logo lifts, it does not play, so
 * it can never slide in over a screen someone has already started to use.
 */
export function FirstOpenIntroHost() {
  const covering = useSyncExternalStore(subscribeLaunchSplash, isLaunchSplashCovering, isLaunchSplashCovering);
  const [coldStart] = useState(covering);
  const { isLoading: authLoading, user } = useAuth();
  const { isHydrated, state, storageAvailable } = useOnboarding();
  const [seen, setSeen] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<HostPhase>(coldStart ? 'deciding' : 'done');

  useEffect(() => {
    if (!coldStart) return;
    let active = true;
    void readFirstOpenIntroSeen().then((value) => {
      if (active) setSeen(value);
    });
    return () => {
      active = false;
    };
  }, [coldStart]);

  const decision = decideFirstOpenIntro({
    seen,
    onboardingHydrated: isHydrated,
    storageAvailable,
    authLoading,
    hasUser: Boolean(user),
    onboardingStatus: state.status,
  });

  useEffect(() => {
    if (phase !== 'deciding') return;
    // Undecided when the logo lifts, or told to skip: not this launch.
    if (!covering || decision === 'skip') {
      setPhase('done');
      return;
    }
    if (decision === 'unknown') return;
    // Remembered as it starts, so a launch that is cut short never replays it.
    void markFirstOpenIntroSeen();
    setPhase('showing');
  }, [covering, decision, phase]);

  useEffect(() => {
    if (phase !== 'showing') return;
    setFirstOpenIntroShowing(true);
    return () => setFirstOpenIntroShowing(false);
  }, [phase]);

  if (phase !== 'showing') return null;
  return (
    // A sibling of the app's own provider (it sits beside the launch splash).
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ position: 'absolute', inset: 0, zIndex: 1000 }} pointerEvents="box-none">
      <FirstOpenIntro held={covering} onDone={() => setPhase('done')} />
    </SafeAreaProvider>
  );
}
