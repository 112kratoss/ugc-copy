import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  destination: 'identity' as 'intro' | 'identity' | 'reward' | 'none' | 'pending',
  focused: true,
}));

vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => harness.focused }));
vi.mock('@/lib/use-onboarding-destination', () => ({ useOnboardingDestination: () => harness.destination }));

import { router } from 'expo-router';
import { SetupReopen } from '../components/setup-reopen';
import {
  markSetupShownThisRun,
  resetSetupShownThisRun,
  shouldReopenSetup,
  wasSetupShownThisRun,
} from '../lib/setup-reopen';

describe('when an unfinished setup opens again (owner 11-08)', () => {
  it('opens for a missing name or credits still to add, once per app start', () => {
    expect(shouldReopenSetup('identity', false)).toBe(true);
    expect(shouldReopenSetup('reward', false)).toBe(true);
    expect(shouldReopenSetup('identity', true)).toBe(false);
    for (const destination of ['intro', 'none', 'pending'] as const) {
      expect(shouldReopenSetup(destination, false)).toBe(false);
    }
  });
});

describe('the reopen on Home', () => {
  const trees: renderer.ReactTestRenderer[] = [];
  const mount = () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => { tree = renderer.create(<SetupReopen />); });
    trees.push(tree);
    return tree;
  };

  beforeEach(() => {
    resetSetupShownThisRun();
    vi.mocked(router.push).mockClear();
    harness.destination = 'identity';
    harness.focused = true;
  });
  afterEach(() => {
    act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  });

  it('opens the setup once, and not again in the same run', () => {
    mount();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith('/onboarding');
    expect(wasSetupShownThisRun()).toBe(true);
    mount();
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('stays put once the setup was shown some other way, such as after a sign-in', () => {
    markSetupShownThisRun();
    mount();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('waits for Home to be in view and for an answer', () => {
    harness.focused = false;
    const tree = mount();
    expect(router.push).not.toHaveBeenCalled();
    harness.destination = 'pending';
    harness.focused = true;
    act(() => { tree.update(<SetupReopen />); });
    expect(router.push).not.toHaveBeenCalled();
    harness.destination = 'reward';
    act(() => { tree.update(<SetupReopen />); });
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('never opens for a finished account or a guest', () => {
    for (const destination of ['none', 'intro'] as const) {
      harness.destination = destination;
      mount();
    }
    expect(router.push).not.toHaveBeenCalled();
  });
});
