import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { CreatorOpening } from '@/lib/creator-opening';
import { useOpeningCost } from '@/lib/use-opening-cost';

/**
 * The server's price for the run a creator opened on stands in for the page's own only until the
 * page's first quote is in or has failed, or a start of its own was refused: after that, never again
 * in the page's life (PR #859's review). Kept on, it came back whenever a later quote was on its way
 * for a run like the opening's: a refreshed session's token, a setting changed and changed back,
 * Retry, and the quote asked again after a start refused `cost_changed`, at the refused price.
 */
const OPENING: CreatorOpening = {
  revision: 'rev-1',
  modelId: 'seedance-2-mini',
  settings: { resolution: '480p', duration: 5 },
  costCredits: 19,
};
const RUN = { modelId: 'seedance-2-mini', settings: { resolution: '480p', duration: 5 }, inputs: [] as unknown[] };
type Status = 'idle' | 'pending' | 'ready' | 'error';

function page(quoteStatus: Status, run = RUN) {
  return { run, quoteStatus, confirmedRevision: null, catalogFailed: false };
}

function renderOpeningCost(initial: Status) {
  return renderHook(({ status, run }: { status: Status; run: typeof RUN }) => useOpeningCost(OPENING, page(status, run)), {
    initialProps: { status: initial, run: RUN },
  });
}

describe('useOpeningCost', () => {
  it('stands in while the page has no price of its own', () => {
    const view = renderOpeningCost('idle');
    expect(view.result.current.cost).toBe(19);
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBe(19);
  });

  it('never comes back once the page\'s first quote is in: a refreshed token\'s quote is on its way, not the server\'s', () => {
    const view = renderOpeningCost('pending');
    view.rerender({ status: 'ready', run: RUN });
    expect(view.result.current.cost).toBeNull();
    // A new token is a new quote key: the same run's quote is pending again.
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBeNull();
    // A setting changed and changed back, the same.
    view.rerender({ status: 'pending', run: { ...RUN, settings: { resolution: '720p', duration: 5 } } });
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBeNull();
  });

  it('never comes back once the page\'s first quote has failed, and Retry asks again', () => {
    const view = renderOpeningCost('pending');
    view.rerender({ status: 'error', run: RUN });
    expect(view.result.current.cost).toBeNull();
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBeNull();
  });

  it('never comes back once a start was refused, its cost_changed asking again included', () => {
    const view = renderOpeningCost('pending');
    expect(view.result.current.cost).toBe(19);
    act(() => view.result.current.settle());
    expect(view.result.current.cost).toBeNull();
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBeNull();
  });

  it('keeps openingCost\'s own rules meanwhile: another run has none', () => {
    const view = renderOpeningCost('pending');
    view.rerender({ status: 'pending', run: { ...RUN, modelId: 'kling-3.0-video' } });
    expect(view.result.current.cost).toBeNull();
    view.rerender({ status: 'pending', run: RUN });
    expect(view.result.current.cost).toBe(19);
  });
});
