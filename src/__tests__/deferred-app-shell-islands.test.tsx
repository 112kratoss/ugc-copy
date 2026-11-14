import { act, render, screen, within } from '@testing-library/react';
import type React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredAppShellAccount from '@/components/DeferredAppShellAccount';
import DeferredGenerationNotifications from '@/components/DeferredGenerationNotifications';
import {
  publishAppShellAuthentication,
  readAppShellAuthentication,
} from '@/components/app-shell-auth-state';

const authCookieMocks = vi.hoisted(() => ({
  hasSupabaseAuthCookie: vi.fn(),
}));

const islandMocks = vi.hoisted(() => ({
  props: [] as unknown[],
  loading: [] as Array<(() => React.ReactNode) | undefined>,
}));

vi.mock('next/dynamic', () => ({
  default: (_loader: unknown, options?: { loading?: () => React.ReactNode }) => {
    islandMocks.loading.push(options?.loading);
    return function DynamicIslandStub(props: unknown) {
      islandMocks.props.push(props);
      return <div data-testid="dynamic-island" />;
    };
  },
}));

vi.mock('@/lib/supabase-auth-cookie', () => ({
  hasSupabaseAuthCookie: authCookieMocks.hasSupabaseAuthCookie,
}));

describe('deferred app shell islands', () => {
  let idleCallbacks: IdleRequestCallback[];

  beforeEach(() => {
    idleCallbacks = [];
    islandMocks.props = [];
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

  it('hands the account island the shell\'s page and click, for the menu\'s Profile', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    const onNavigate = vi.fn();
    render(<DeferredAppShellAccount pathname="/profile" onNavigate={onNavigate} />);

    expect(islandMocks.props.at(-1)).toEqual({ pathname: '/profile', onNavigate });
  });

  // The server cannot read the visitor's cookie on a page it prerendered, so it draws both: "Sign
  // in", and the signed-in shape, each behind the root element's mark, which the layout sets from
  // the cookie before the page draws (app-shell-account-restore.test.ts). A signed-in refresh
  // drew "Sign in" first and moved the whole bar when the account landed (2026-11-14).
  it('draws both shapes of the slot on the server, each behind the mark that shows it', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    const container = document.createElement('div');
    container.innerHTML = renderToString(<DeferredAppShellAccount pathname="/" />);

    const signIn = within(container).getByRole('link', { name: 'Sign in for 25 free credits' });
    expect(signIn).toHaveClass('app-shell-when-signed-out');
    expect(signIn).toHaveAttribute('href', '/login?returnUrl=%2F');
    const signedIn = container.querySelectorAll('.app-shell-when-signed-in');
    expect(signedIn).toHaveLength(2);
    signedIn.forEach((element) => expect(element).toHaveAttribute('aria-hidden', 'true'));
    expect(container.querySelector('.app-shell-credits-pending')).not.toBeNull();
    expect(within(container).queryByTestId('dynamic-island')).toBeNull();
  });

  it('adopts the server\'s slot without a mismatch, then keeps the shape the browser has', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    const container = document.createElement('div');
    container.innerHTML = renderToString(<DeferredAppShellAccount pathname="/" />);
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();

    render(<DeferredAppShellAccount pathname="/" />, { container, hydrate: true, onRecoverableError });

    expect(onRecoverableError).not.toHaveBeenCalled();
    // Mounted, the account island loads, and nothing in the slot carries a mark any longer: a
    // sign-out later in the visit draws "Sign in" whatever the root element says.
    expect(within(container).getByTestId('dynamic-island')).toBeInTheDocument();
    expect(container.querySelector('.app-shell-when-signed-in, .app-shell-when-signed-out')).toBeNull();
  });

  it('holds the signed-in shape while the account island loads', () => {
    const loading = islandMocks.loading.find(Boolean);
    expect(loading).toBeDefined();
    const { container } = render(<>{loading!()}</>);

    expect(container.querySelector('.app-shell-credits-pending')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /Sign in/ })).toBeNull();
  });

  it('keeps the Supabase-backed account island out of anonymous renders', () => {
    render(<DeferredAppShellAccount />);

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in for 25 free credits' })).toBeInTheDocument();
  });

  it('publishes signed-out state when the browser auth cookie disappears', () => {
    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(true);
    render(<DeferredAppShellAccount />);
    publishAppShellAuthentication(true);

    authCookieMocks.hasSupabaseAuthCookie.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('focus')));

    expect(readAppShellAuthentication()).toBe(false);
    expect(screen.getByRole('link', { name: 'Sign in for 25 free credits' })).toBeInTheDocument();
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
