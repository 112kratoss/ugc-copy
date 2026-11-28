import { router } from 'expo-router';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';

import { AppText, PrimaryButton, SecondaryButton } from '@/components/ui';
import { reportClientError } from '@/lib/client-error-report';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * What a screen that failed shows (audit 2026-11-27): the recovery expo-router's stock boundary
 * gave, a Try again, without its raw error message, which said nothing useful to a person and
 * could show internals. The error itself goes to `lib/client-error-report.ts`. Where there is a
 * way out (`onHome`), it is offered under Try again.
 */
export function AppErrorFallback({ onRetry, onHome }: { onRetry: () => void; onHome?: () => void }) {
  const theme = useAppTheme();
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        gap: appTheme.spacing.gap,
        padding: appTheme.spacing.screen,
        backgroundColor: theme.colors.background,
      }}
    >
      <AppText variant="sectionTitle" accessibilityRole="header">Something went wrong</AppText>
      <AppText variant="bodySm" color="muted">
        This screen hit a problem and could not be shown. Try again; if it keeps happening, tell us from Help &amp; Support.
      </AppText>
      <PrimaryButton label="Try again" onPress={onRetry} />
      {onHome ? <SecondaryButton label="Go to Home" onPress={onHome} /> : null}
    </View>
  );
}

/**
 * Off the failed screen to Home. A stack screen above the tabs is taken off the stack first, so it
 * is not drawn again under Home; then the tabs are told to show Home, which is all there is to do
 * for a tab that failed (on the Pixel 9a emulator `dismissTo('/')` alone left a failed tab where it
 * was, there being nothing to dismiss) and what brings Home forward when another tab was under the
 * stack screen. The page for a link the app has no screen for leaves the same way (`app/+not-found.tsx`).
 */
export function leaveForHome() {
  if (router.canDismiss()) router.dismissTo('/');
  router.navigate('/');
}

type State = { failed: boolean };

/**
 * The app's own boundary: a class, because only `componentDidCatch` is given the component stack,
 * which the report carries. Try again draws what failed again.
 *
 * It is drawn twice over. Around each screen (`screen`, through `screenErrorLayout`), where an
 * error leaves the navigator and every other screen up, so the page offers the way out as well:
 * a screen that fails every time used to keep the person on Try again until the app was
 * restarted. And once around the navigator, for what fails outside any screen, where nothing is
 * left to leave by.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode; screen?: 'leaves-for-home' | 'holds-home' }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportClientError(error, { componentStack: info.componentStack ?? null, fatal: false });
  }

  retry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <AppErrorFallback
        onRetry={this.retry}
        onHome={this.props.screen === 'leaves-for-home' ? leaveForHome : undefined}
      />
    );
  }
}

/** What a navigator hands its `screenLayout` of the screen it wraps (React Navigation's `useDescriptors`). */
type ScreenLayoutArgs = {
  children: ReactNode;
  route: { name: string };
  navigation: { getState: () => { type: string } };
};

/**
 * Whether Home is this screen or inside it: the Home tab itself, and the tabs' own route in the
 * root Stack, which holds every tab (its boundary catches what the tab bar or the tabs' layout
 * throws). Leaving for Home cannot take such a screen's error page off the screen, so the page
 * offers Try again alone there. Read from the wrapped route, not from the focused one: a failed
 * tab that is not in front is still not Home.
 */
function holdsHome({ route, navigation }: Pick<ScreenLayoutArgs, 'route' | 'navigation'>) {
  if (route.name === '(tabs)') return true;
  return route.name === 'index' && navigation.getState().type === 'tab';
}

/**
 * A navigator's `screenLayout`: each of its screens inside a boundary of its own. Every navigator
 * the app draws takes it (`__tests__/app-error-boundary.test.tsx` reads the layouts), so a screen
 * that throws shows the error page in its own place, Back still leaves it, and Go to Home works.
 * The navigator calls this as a plain function while it builds its screens, so it uses no hook.
 */
export function screenErrorLayout({ children, route, navigation }: ScreenLayoutArgs) {
  return (
    <AppErrorBoundary screen={holdsHome({ route, navigation }) ? 'holds-home' : 'leaves-for-home'}>
      {children}
    </AppErrorBoundary>
  );
}
