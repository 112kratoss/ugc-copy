import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredAppShellAccount from '@/app/components/DeferredAppShellAccount';
import DeferredGenerationNotifications from '@/app/components/DeferredGenerationNotifications';
import {
  publishAppShellAuthentication,
  readAppShellAuthentication,
} from '@/app/components/app-shell-auth-state';

const authCookieMocks = vi.hoisted(() => ({
  hasSupabaseAuthCookie: vi.fn(),
}));

vi.mock('next/dynamic', () => ({
  default: () => function DynamicIslandStub() {
    return <div data-testid="dynamic-island" />;
  },
}));

vi.mock('@/lib/supabase-auth-cookie', () => ({
  hasSupabaseAuthCookie: authCookieMocks.hasSupabaseAuthCookie,
}));

describe('deferred app shell islands', () => {
  let idleCallbacks: IdleRequestCallback[];

  beforeEach(() => {
    idleCallbacks = [];
    publishAppShellAuthentication(false);
    authCookieMocks.hasSupabaseAuthCookie.mockReset();
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(false);

    vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    vi.stubGlobal('cancelIdleCallback', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushIdleCallbacks() {
    act(() => {
      idleCallbacks.splice(0).forEach((callback) => {
        callback({
          didTimeout: false,
          timeRemaining: () => 50,
        });
      });
    });
  }

  it('loads the account island immediately to avoid signed-in CTA flicker', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    render(<DeferredAppShellAccount />);

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(0);
  });

  it('keeps the Supabase-backed account island out of anonymous renders', () => {
    render(<DeferredAppShellAccount />);

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('publishes signed-out state when the browser auth cookie disappears', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    render(<DeferredAppShellAccount />);
    publishAppShellAuthentication(true);

    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('focus')));

    expect(readAppShellAuthentication()).toBe(false);
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps generation notifications out of the first render', () => {
    publishAppShellAuthentication(true);
    render(<DeferredGenerationNotifications />);

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();

    flushIdleCallbacks();

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
  });

  it('does not load generation notifications for signed-out visitors', () => {
    render(<DeferredGenerationNotifications />);

    flushIdleCallbacks();

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();
  });
});
