// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = false;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import fs from 'node:fs';
import path from 'node:path';

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const report = vi.hoisted(() => ({ reportClientError: vi.fn() }));
const routing = vi.hoisted(() => ({ canDismiss: true, calls: [] as string[] }));

vi.mock('expo-router', () => ({
  router: {
    canDismiss: () => routing.canDismiss,
    dismissTo: (href: string) => { routing.calls.push(`dismissTo ${href}`); },
    navigate: (href: string) => { routing.calls.push(`navigate ${href}`); },
  },
}));

vi.mock('@/lib/client-error-report', () => report);
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { background: 'bg' } }) }));
vi.mock('@/lib/theme', () => ({ appTheme: { spacing: { screen: 16, gap: 12 } } }));
vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
}));

import { AppErrorBoundary, AppErrorFallback, screenErrorLayout } from '@/components/app-error-boundary';

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
  routing.canDismiss = true;
  routing.calls = [];
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

    // Around the navigator there is no navigator left to leave by: Try again stands alone.
    expect(tree.root.findAllByType('secondary-button' as never)).toHaveLength(0);

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

// Follow-up of the same audit: the page offered only Try again, so a screen that failed every time
// kept the person on it until the app was restarted. Each screen is now drawn inside a boundary of
// its own (the navigators' `screenLayout`), which leaves the navigator up, and the page offers the
// way out to Home by the router.
describe("a screen's own error boundary", () => {
  /** The screen as its navigator wraps it: the route's name, and the kind of navigator it is in. */
  const screen = (children: React.ReactNode, route: { name: string; in: 'stack' | 'tab' } = { name: 'support', in: 'stack' }) => (
    screenErrorLayout({ children, route: { name: route.name }, navigation: { getState: () => ({ type: route.in }) } })
  );
  const drawFailed = (route?: { name: string; in: 'stack' | 'tab' }) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(screen(<Fragile />, route)); });
    return tree;
  };

  it('reports the error and offers Try again and Go to Home, which leaves by the router', () => {
    const tree = drawFailed();

    expect(report.reportClientError).toHaveBeenCalledTimes(1);
    const [error, options] = report.reportClientError.mock.calls[0] as [Error, { componentStack: string; fatal: boolean }];
    expect(error.message).toBe('secret internal detail');
    expect(options.fatal).toBe(false);
    expect(options.componentStack).toContain('Fragile');
    expect(drawn(tree)).toContain('Something went wrong');
    expect(drawn(tree)).not.toContain('secret internal detail');
    expect(tree.root.findByType('primary-button' as never).props.label).toBe('Try again');

    // A stack screen above the tabs: taken off the stack, then the tabs are told to show Home
    // (another tab may be the one under it).
    const home = tree.root.findByType('secondary-button' as never);
    expect(home.props.label).toBe('Go to Home');
    act(() => { (home.props.onPress as () => void)(); });
    expect(routing.calls).toEqual(['dismissTo /', 'navigate /']);
    // Leaving does not draw the failed screen again: it stays the error page until Try again.
    expect(drawn(tree)).toContain('Something went wrong');
    expect(report.reportClientError).toHaveBeenCalledTimes(1);

    fails.now = false;
    act(() => { (tree.root.findByType('primary-button' as never).props.onPress as () => void)(); });
    expect(drawn(tree)).toContain('All good');
  });

  it('leaves a failed tab for the Home tab, with nothing to take off the stack', () => {
    // On the Pixel 9a emulator `dismissTo('/')` alone left a failed tab where it was.
    routing.canDismiss = false;
    const tree = drawFailed({ name: 'showcase', in: 'tab' });

    act(() => { (tree.root.findByType('secondary-button' as never).props.onPress as () => void)(); });
    expect(routing.calls).toEqual(['navigate /']);
  });

  it('offers no way Home when the Home tab is the screen that failed', () => {
    const tree = drawFailed({ name: 'index', in: 'tab' });

    expect(drawn(tree)).toContain('Something went wrong');
    expect(tree.root.findByType('primary-button' as never).props.label).toBe('Try again');
    expect(tree.root.findAllByType('secondary-button' as never)).toHaveLength(0);
  });

  it("offers no way Home from the tabs' own route, which holds Home", () => {
    // The root Stack wraps the whole tab navigator as one screen: its boundary catches what the tab
    // bar or the tabs' layout throws, and Home is under that same error page.
    const tree = drawFailed({ name: '(tabs)', in: 'stack' });

    expect(drawn(tree)).toContain('Something went wrong');
    expect(tree.root.findAllByType('secondary-button' as never)).toHaveLength(0);
  });

  it("takes another navigator's index for what it is, not for Home", () => {
    const tree = drawFailed({ name: 'index', in: 'stack' });
    expect(tree.root.findByType('secondary-button' as never).props.label).toBe('Go to Home');
  });

  it('draws a screen that does not fail as it is', () => {
    fails.now = false;
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(screen(<Fragile />)); });
    expect(drawn(tree)).toBe(JSON.stringify({ type: 'text', props: {}, children: ['All good'] }));
    expect(report.reportClientError).not.toHaveBeenCalled();
  });

  it('is the screen layout of every navigator the app draws', () => {
    const appDir = path.join(process.cwd(), 'app');
    const layouts = (fs.readdirSync(appDir, { recursive: true }) as string[])
      .filter((file) => path.basename(file) === '_layout.tsx')
      .map((file) => ({
        file,
        // Without its comments: a navigator or a prop in one is not drawn.
        source: fs.readFileSync(path.join(appDir, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, ''),
      }));
    // The root Stack, the tabs and the post pages' Stack, at the least.
    expect(layouts.length).toBeGreaterThanOrEqual(3);

    for (const { file, source } of layouts) {
      // A layout that draws another kind of navigator (a Slot, native tabs) is named here first.
      const navigators = source.match(/<(?:Stack|Tabs)(?=[\s>])/g) ?? [];
      expect(navigators.length, `${file}: draws a Stack or Tabs`).toBeGreaterThan(0);
      // One prop for each navigator, wherever in its tag, and the app's own layout behind the name.
      const props = source.match(/\bscreenLayout=\{screenErrorLayout\}/g) ?? [];
      expect(props.length, `${file}: every navigator takes screenLayout={screenErrorLayout}`).toBe(navigators.length);
      expect(source, `${file}: screenErrorLayout is the app's own`).toMatch(
        /import \{[^}]*\bscreenErrorLayout\b[^}]*\} from '@\/components\/app-error-boundary';/,
      );
    }
  });
});
