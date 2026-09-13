import { beforeEach, describe, expect, it, vi } from 'vitest';

const appMetrics = vi.hoisted(() => ({ markInteractive: vi.fn() }));
vi.mock('expo-observe', () => ({ AppMetrics: appMetrics }));

import {
  isStartupInteractive,
  reportStartupMilestone,
  resetStartupMilestonesForTests,
  type StartupMilestone,
} from '@/lib/startup-interactive';

function progress(entries: [StartupMilestone, string][]) {
  return { passed: new Map(entries) };
}

describe('isStartupInteractive', () => {
  it('is never interactive before the session is restored', () => {
    // Home is still covered by StartupCoordinator, even with a feed in hand
    // (a persisted page can arrive before auth does).
    expect(isStartupInteractive(progress([['home-content', '/']]))).toBe(false);
    expect(isStartupInteractive(progress([]))).toBe(false);
  });

  it('holds a home launch until the feed settles, on posts or on a state to act on', () => {
    expect(isStartupInteractive(progress([['shell-ready', '/']]))).toBe(false);
    expect(isStartupInteractive(progress([['shell-ready', '/'], ['home-content', '/']]))).toBe(true);
    expect(isStartupInteractive(progress([['shell-ready', '/'], ['home-empty-or-error', '/']]))).toBe(true);
  });

  it('ends a launch that landed on another screen with the shell', () => {
    expect(isStartupInteractive(progress([['shell-ready', '/post/7f3a']]))).toBe(true);
  });
});

describe('reportStartupMilestone', () => {
  beforeEach(() => {
    resetStartupMilestonesForTests();
    appMetrics.markInteractive.mockReset();
  });

  it('marks a home launch when its feed settles, attributed to the route it landed on', () => {
    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/' });
    expect(appMetrics.markInteractive).not.toHaveBeenCalled();

    reportStartupMilestone({ milestone: 'home-content', pathname: '/' });
    expect(appMetrics.markInteractive).toHaveBeenCalledExactlyOnceWith({
      routeName: '/',
      params: { completedBy: 'home-content' },
    });
  });

  it('does not depend on the order milestones arrive in', () => {
    reportStartupMilestone({ milestone: 'home-content', pathname: '/' });
    expect(appMetrics.markInteractive).not.toHaveBeenCalled();

    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/' });
    expect(appMetrics.markInteractive).toHaveBeenCalledExactlyOnceWith({
      routeName: '/',
      params: { completedBy: 'shell-ready' },
    });
  });

  it('carries where the home feed came from, even when its posts arrive before the shell', () => {
    reportStartupMilestone({ milestone: 'home-content', pathname: '/', details: { feedSource: 'persisted' } });
    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/' });

    expect(appMetrics.markInteractive).toHaveBeenCalledExactlyOnceWith({
      routeName: '/',
      params: { feedSource: 'persisted', completedBy: 'shell-ready' },
    });
  });

  it('marks a launch once, however many milestones follow', () => {
    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/showcase/12' });
    reportStartupMilestone({ milestone: 'home-content', pathname: '/' });

    expect(appMetrics.markInteractive).toHaveBeenCalledExactlyOnceWith({
      routeName: '/showcase/12',
      params: { completedBy: 'shell-ready' },
    });
  });

  it('keeps the route a milestone first passed on, so a first run redirected to onboarding is not measured', () => {
    // StartupCoordinator re-reports as the pathname changes, and the onboarding
    // redirect lands right after hydration — while home, which never gets to
    // settle its feed, is torn down.
    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/' });
    reportStartupMilestone({ milestone: 'shell-ready', pathname: '/onboarding' });

    expect(appMetrics.markInteractive).not.toHaveBeenCalled();
  });

  it('never lets a failing metric escape into the launch', () => {
    appMetrics.markInteractive.mockImplementation(() => {
      throw new Error('native module missing');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => reportStartupMilestone({ milestone: 'shell-ready', pathname: '/help' })).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
