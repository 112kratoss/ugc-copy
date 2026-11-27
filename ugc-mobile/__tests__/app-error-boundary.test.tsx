// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = false;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const report = vi.hoisted(() => ({ reportClientError: vi.fn() }));

vi.mock('@/lib/client-error-report', () => report);
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { background: 'bg' } }) }));
vi.mock('@/lib/theme', () => ({ appTheme: { spacing: { screen: 16, gap: 12 } } }));
vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
}));

import { AppErrorBoundary, AppErrorFallback } from '@/components/app-error-boundary';

// Audit 2026-11-27: errors on phones reached nobody. The app's own boundary keeps the recovery the
// stock one gave (a Retry) without showing the raw message, and hands the error, with its component
// stack, to the reporter.
const fails = { now: true };
function Fragile() {
  if (fails.now) throw new Error('secret internal detail');
  return React.createElement('text', null, 'All good');
}

function drawn(tree: renderer.ReactTestRenderer) {
  return JSON.stringify(tree.toJSON());
}

beforeEach(() => {
  vi.clearAllMocks();
  fails.now = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the app error boundary', () => {
  it('reports the error with its component stack, hides the raw message, and recovers on Try again', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<AppErrorBoundary><Fragile /></AppErrorBoundary>);
    });

    expect(report.reportClientError).toHaveBeenCalledTimes(1);
    const [error, options] = report.reportClientError.mock.calls[0] as [Error, { componentStack: string; fatal: boolean }];
    expect(error.message).toBe('secret internal detail');
    expect(options.fatal).toBe(false);
    expect(options.componentStack).toContain('Fragile');
    expect(drawn(tree)).toContain('Something went wrong');
    expect(drawn(tree)).not.toContain('secret internal detail');

    fails.now = false;
    act(() => { (tree.root.findByType('primary-button' as never).props.onPress as () => void)(); });
    expect(drawn(tree)).toContain('All good');
  });

  it('draws the same recovery for the route boundary, with no raw message', () => {
    const onRetry = vi.fn();
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<AppErrorFallback onRetry={onRetry} />); });
    act(() => { (tree.root.findByType('primary-button' as never).props.onPress as () => void)(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(tree.root.findByType('primary-button' as never).props.label).toBe('Try again');
  });
});
