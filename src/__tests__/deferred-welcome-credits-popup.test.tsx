import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ pathname: '/' }));

// Next keeps the query in step with the address, `history.replaceState` included.
vi.mock('next/navigation', () => ({
  usePathname: () => harness.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// The gate is tested on its own (welcome-credits-gate.test.tsx): here, when it loads and what it is told.
vi.mock('next/dynamic', () => ({
  default: () => function GateStandIn({ offeredHere, returned }: { offeredHere: boolean; returned: { pathname: string; referral: string | null } | null }) {
    return <div data-testid="gate" data-offered={String(offeredHere)} data-returned={returned ? `${returned.pathname}|${returned.referral ?? ''}` : ''} />;
  },
}));

import DeferredWelcomeCreditsPopup from '@/components/DeferredWelcomeCreditsPopup';
import { publishAppShellAuthentication } from '@/components/app-shell-auth-state';

describe('the welcome popup’s place in the root layout', () => {
  beforeEach(() => {
    harness.pathname = '/';
    publishAppShellAuthentication(false);
  });

  afterEach(() => {
    publishAppShellAuthentication(false);
    window.history.replaceState(null, '', '/');
  });

  it('loads nothing for a visitor', () => {
    render(<DeferredWelcomeCreditsPopup />);
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();
  });

  it('loads the gate once the shell has a signed-in account on Home or a creator', () => {
    const view = render(<DeferredWelcomeCreditsPopup />);
    act(() => publishAppShellAuthentication(true));
    expect(screen.getByTestId('gate')).toHaveAttribute('data-offered', 'true');

    harness.pathname = '/create-image';
    view.rerender(<DeferredWelcomeCreditsPopup />);
    expect(screen.getByTestId('gate')).toHaveAttribute('data-offered', 'true');
  });

  it('loads nothing on another page, and keeps the gate (offering nothing) once loaded', () => {
    harness.pathname = '/showcase';
    publishAppShellAuthentication(true);
    const view = render(<DeferredWelcomeCreditsPopup />);
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();

    harness.pathname = '/';
    view.rerender(<DeferredWelcomeCreditsPopup />);
    harness.pathname = '/showcase';
    view.rerender(<DeferredWelcomeCreditsPopup />);
    expect(screen.getByTestId('gate')).toHaveAttribute('data-offered', 'false');
  });

  it('takes the page a sign-up returned to, with its invite’s outcome, and the flags off its address', () => {
    harness.pathname = '/showcase';
    window.history.replaceState(null, '', '/showcase?chip=new&welcome=1&referral=applied#top');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    publishAppShellAuthentication(true);
    render(<DeferredWelcomeCreditsPopup />);

    expect(screen.getByTestId('gate')).toHaveAttribute('data-offered', 'true');
    expect(screen.getByTestId('gate')).toHaveAttribute('data-returned', '/showcase|applied');
    // Through Next's own history handling (a null state).
    expect(replaceState).toHaveBeenCalledWith(null, '', '/showcase?chip=new#top');
    expect(window.location.search).toBe('?chip=new');
    replaceState.mockRestore();
  });

  it('leaves a creator’s flags to its welcome card, and a page it never covers as it is', () => {
    harness.pathname = '/create-video';
    window.history.replaceState(null, '', '/create-video?handover=nonce-1234&welcome=1');
    publishAppShellAuthentication(true);
    const view = render(<DeferredWelcomeCreditsPopup />);
    expect(window.location.search).toBe('?handover=nonce-1234&welcome=1');
    expect(screen.getByTestId('gate')).toHaveAttribute('data-returned', '');
    view.unmount();

    harness.pathname = '/pricing';
    window.history.replaceState(null, '', '/pricing?welcome=1');
    render(<DeferredWelcomeCreditsPopup />);
    expect(window.location.search).toBe('?welcome=1');
    expect(screen.queryByTestId('gate')).not.toBeInTheDocument();
  });
});
