// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuestMergeOutcome } from '@/lib/guest-merge';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const state = vi.hoisted(() => ({
  auth: {
    guestMergeOutcome: null as GuestMergeOutcome | null,
    dismissGuestMergeOutcome: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => state.auth,
}));

import { GuestMergeBanner } from '@/components/guest-merge-banner';

function render() {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<GuestMergeBanner />);
  });
  return tree!;
}

const at = 1_700_000_000_000;

describe('GuestMergeBanner (audit 02-8)', () => {
  beforeEach(() => {
    state.auth.guestMergeOutcome = null;
    state.auth.dismissGuestMergeOutcome.mockReset();
  });

  it('draws nothing without an outcome, so it can sit on Home for everyone', () => {
    expect(render().toJSON()).toBeNull();
  });

  it('says how many guest credits were added, and dismisses', () => {
    state.auth.guestMergeOutcome = { status: 'merged', creditsMoved: 250, at };
    const tree = render();

    const block = tree.root.findByType('status-block' as never);
    expect(block.props).toMatchObject({
      tone: 'success',
      title: 'Guest credits added: 250',
      body: 'Your credits and creations are now on your account.',
    });

    const dismiss = tree.root.findByType('secondary-button' as never);
    expect(dismiss.props.label).toBe('Dismiss');
    renderer.act(() => dismiss.props.onPress());
    expect(state.auth.dismissGuestMergeOutcome).toHaveBeenCalledOnce();
  });

  it.each([
    ['conflict', 'Guest credits not added', /different account/],
    ['expired', 'Guest credits not added', /waited too long/],
    ['not_eligible', 'Guest credits not added yet', /keep trying/],
  ] as const)('tells a %s why the credits are not on the account, and what to do', (status, title, reason) => {
    state.auth.guestMergeOutcome = { status, creditsMoved: 0, at };
    const tree = render();

    const block = tree.root.findByType('status-block' as never);
    expect(block.props.tone).toBe('warning');
    expect(block.props.title).toBe(title);
    expect(block.props.body).toMatch(reason);
    expect(block.props.body).toMatch(/support/);
    expect(tree.root.findByType('secondary-button' as never).props.label).toBe('Dismiss');
  });

  it('draws nothing for a link that moved no credits', () => {
    state.auth.guestMergeOutcome = { status: 'merged', creditsMoved: 0, at };
    expect(render().toJSON()).toBeNull();
  });
});
