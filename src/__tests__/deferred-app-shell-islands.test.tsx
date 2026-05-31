import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeferredAppShellAccount from '@/app/components/DeferredAppShellAccount';
import DeferredGenerationNotifications from '@/app/components/DeferredGenerationNotifications';
import DeferredHomeShowcasePreviewGrid from '@/app/components/DeferredHomeShowcasePreviewGrid';

vi.mock('next/dynamic', () => ({
  default: () => function DynamicIslandStub() {
    return <div data-testid="dynamic-island" />;
  },
}));

describe('deferred app shell islands', () => {
  let idleCallbacks: IdleRequestCallback[];

  beforeEach(() => {
    idleCallbacks = [];

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

  it('keeps the account menu island out of the first render', () => {
    render(<DeferredAppShellAccount />);

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();

    flushIdleCallbacks();

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
  });

  it('keeps generation notifications out of the first render', () => {
    render(<DeferredGenerationNotifications />);

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();

    flushIdleCallbacks();

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
  });

  it('keeps the homepage showcase island out of the first render', () => {
    render(
      <DeferredHomeShowcasePreviewGrid
        items={[]}
        initialSession={null}
        initialCredits={null}
      />
    );

    expect(screen.queryByTestId('dynamic-island')).not.toBeInTheDocument();

    flushIdleCallbacks();

    expect(screen.getByTestId('dynamic-island')).toBeInTheDocument();
  });
});
