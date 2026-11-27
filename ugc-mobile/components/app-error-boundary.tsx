import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';

import { AppText, PrimaryButton } from '@/components/ui';
import { reportClientError } from '@/lib/client-error-report';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * What a screen that failed shows (audit 2026-11-27): the recovery expo-router's stock boundary
 * gave, a Try again, without its raw error message, which said nothing useful to a person and
 * could show internals. The error itself goes to `lib/client-error-report.ts`.
 */
export function AppErrorFallback({ onRetry }: { onRetry: () => void }) {
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
    </View>
  );
}

type State = { failed: boolean };

/**
 * The app's own boundary around the navigator: a class, because only `componentDidCatch` is given
 * the component stack, which the report carries. Try again draws the screens again.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
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
    if (this.state.failed) return <AppErrorFallback onRetry={this.retry} />;
    return this.props.children;
  }
}
