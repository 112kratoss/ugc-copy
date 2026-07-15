import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredAppShellAccount from '@/app/components/DeferredAppShellAccount';
import DeferredGenerationNotifications from '@/app/components/DeferredGenerationNotifications';
import DeferredHomeShowcasePreviewGrid from '@/app/components/DeferredHomeShowcasePreviewGrid';
import { publishAppShellAuthentication } from '@/app/components/app-shell-auth-state';

vi.mock('next/dynamic', () => ({
  default: () => function DynamicIslandStub() {
    return <div data-testid="dynamic-island" />;
  },
}));

describe('deferred app shell islands', () => {
  let idleCallbacks: IdleRequestCallback[];

  beforeEach(() => {
    idleCallbacks = [];
    publishAppShellAuthentication(false);

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
    render(<DeferredAppShellAccount />);

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(0);
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

  it('loads the homepage showcase island immediately so save state can resolve', () => {
    render(
      <DeferredHomeShowcasePreviewGrid
        items={[]}
        initialSession={null}
        initialCredits={null}
      />
    );

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
    expect(idleCallbacks).toHaveLength(0);
  });
});
