// Define React Native development global.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const mocks = vi.hoisted(() => {
  // Models React Native's BackHandler: listeners are consulted newest-first
  // and the first to return true ends the press.
  const listeners: Array<() => boolean> = [];
  return {
    listeners,
    announce: vi.fn(),
    addEventListener: vi.fn((_event: string, listener: () => boolean) => {
      listeners.push(listener);
      return {
        remove: () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    }),
  };
});

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  BackHandler: { addEventListener: mocks.addEventListener },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: {} }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ isSigningOut: false }),
}));

import { SIGN_OUT_COVER_MIN_VISIBLE_MS, SignOutCover } from '../components/sign-out-overlay';

function pressBack() {
  for (const listener of [...mocks.listeners].reverse()) {
    if (listener()) return true;
  }
  return false;
}

// Host elements only: the mocked View component and the element it renders
// would otherwise both match.
function progressPanels(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => node.type === 'view' && node.props.accessibilityRole === 'progressbar');
}

describe('SignOutCover', () => {
  let tree: renderer.ReactTestRenderer;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listeners.length = 0;
    mocks.announce.mockClear();
  });

  afterEach(() => {
    act(() => tree?.unmount());
    vi.useRealTimers();
  });

  function render(active: boolean) {
    act(() => {
      tree = renderer.create(<SignOutCover active={active} />);
    });
  }

  function setActive(active: boolean) {
    act(() => {
      tree.update(<SignOutCover active={active} />);
    });
  }

  it('draws nothing while no sign-out is running', () => {
    render(false);

    expect(tree.toJSON()).toBeNull();
    expect(mocks.listeners).toHaveLength(0);
  });

  it('covers the app with a labelled progress panel, announced to screen readers', () => {
    render(false);
    setActive(true);

    const panels = progressPanels(tree);
    expect(panels).toHaveLength(1);
    const [panel] = panels;
    expect(panel.props.accessibilityLabel).toBe('Signing out');
    expect(panel.props.accessibilityState).toEqual({ busy: true });
    expect(tree.root.findAll((node) => node.type === 'text').map((node) => node.props.children))
      .toEqual(['Signing out…', 'One moment']);
    expect(mocks.announce).toHaveBeenCalledWith('Signing out');
  });

  it('holds for the minimum when the sign-out finishes quickly, then leaves', () => {
    render(false);
    setActive(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    setActive(false);

    act(() => {
      vi.advanceTimersByTime(SIGN_OUT_COVER_MIN_VISIBLE_MS - 300 - 1);
    });
    expect(progressPanels(tree)).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('leaves as soon as a long sign-out finishes', () => {
    render(false);
    setActive(true);
    act(() => {
      vi.advanceTimersByTime(SIGN_OUT_COVER_MIN_VISIBLE_MS + 5_000);
    });
    expect(progressPanels(tree)).toHaveLength(1);

    setActive(false);

    expect(tree.toJSON()).toBeNull();
  });

  it('stays up when a retry starts before the hold runs out', () => {
    render(false);
    setActive(true);
    setActive(false);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    setActive(true);
    act(() => {
      vi.advanceTimersByTime(SIGN_OUT_COVER_MIN_VISIBLE_MS * 3);
    });

    expect(progressPanels(tree)).toHaveLength(1);
  });

  it('swallows Android back while it is up, and releases it afterwards', () => {
    render(false);
    setActive(true);

    expect(pressBack()).toBe(true);

    setActive(false);
    act(() => {
      vi.advanceTimersByTime(SIGN_OUT_COVER_MIN_VISIBLE_MS);
    });
    expect(mocks.listeners).toHaveLength(0);
    expect(pressBack()).toBe(false);
  });
});
