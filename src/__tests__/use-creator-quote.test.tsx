import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogGenerationRequestPayload } from '@/lib/generation-model-adapters';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { useCreatorQuote } from '@/lib/use-creator-quote';
import { catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import { quoteStandIn } from './fixtures/web-quote-stand-in';

vi.mock('@/lib/generation-model-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/generation-model-client')>('@/lib/generation-model-client');
  const { quoteHookStandIn } = await import('./fixtures/web-quote-stand-in');
  return { ...actual, useWebGenerationModelQuote: quoteHookStandIn(actual.WebCatalogRequestError) };
});

/** A run as a creator posts it, and the quote request it is priced with. */
function runOf(settings: Record<string, string>): { run: CatalogGenerationRequestPayload; request: GenerationModelQuoteInput } {
  const run: CatalogGenerationRequestPayload = {
    kind: 'image',
    modelId: 'nano-banana-2',
    catalogRevision: 'rev-1',
    settings,
    prompt: 'A lighthouse at dawn',
    inputs: [{ slot: 'imageReferences', kind: 'image', url: 'https://signed.example.com/lead.png', label: 'Hero shot' }],
  };
  return { run, request: catalogRunQuoteInput({ ...run, inputs: run.inputs ?? [] }) };
}

const lighthouse = runOf({ aspectRatio: 'auto' });
const square = runOf({ aspectRatio: '1:1' });

function renderQuote(request: GenerationModelQuoteInput | null = lighthouse.request) {
  return renderHook(({ current }) => useCreatorQuote(current, 'token'), { initialProps: { current: request } });
}

beforeEach(() => {
  quoteStandIn.reset(8);
});

describe('useCreatorQuote', () => {
  it('asks again at Retry quote', () => {
    quoteStandIn.answers = ['error', 8];
    const { result } = renderQuote();
    expect(result.current.status).toBe('error');

    act(() => result.current.retry());

    expect(quoteStandIn.lastAttempt()).toBe(1);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });
  });

  it('asks again when the start says the price changed, and the price that moved is the next press’s', () => {
    quoteStandIn.answers = [8, 10];
    const { result } = renderQuote();

    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));

    expect(quoteStandIn.lastAttempt()).toBe(1);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 10 }, pageOutOfDate: false });
  });

  it('says the page is out of date when the price asked again is the refused price of the refused run', () => {
    const { result } = renderQuote();

    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));

    expect(quoteStandIn.lastAttempt()).toBe(1);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: true });
  });

  it('says nothing before the price asked again is in, nor after it failed, until Retry brings the refused price back', () => {
    quoteStandIn.answers = [8, 'pending', 'error', 8];
    const { result } = renderQuote();

    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current).toMatchObject({ status: 'pending', pageOutOfDate: false });

    act(() => result.current.retry());
    expect(result.current).toMatchObject({ status: 'error', pageOutOfDate: false });

    act(() => result.current.retry());
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: true });
  });

  it('holds only the refused run: another run is priced on its own, and the refused one is still refused', () => {
    const { result, rerender } = renderQuote();
    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current.pageOutOfDate).toBe(true);

    rerender({ current: square.request });
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });

    rerender({ current: lighthouse.request });
    expect(result.current.pageOutOfDate).toBe(true);
  });

  it('reads nothing into a refusal of a run that went without a price', () => {
    const { result } = renderQuote();

    act(() => result.current.costChanged(lighthouse.run));

    expect(quoteStandIn.lastAttempt()).toBe(1);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });
  });

  // Only the first price in since the refusal is read against it. A later quote of the run
  // back at the refused price (a price put back, a refreshed session, Retry) is no refusal:
  // the start would take it, and the page held Generate and said it was out of date.
  it('forgets a refusal once the price asked again has moved, and holds nothing when the old price comes back', () => {
    quoteStandIn.answers = [8, 10, 8];
    const { result } = renderQuote();
    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current).toMatchObject({ quote: { costCredits: 10 }, pageOutOfDate: false });

    act(() => result.current.retry());

    expect(quoteStandIn.lastAttempt()).toBe(2);
    expect(result.current).toMatchObject({ status: 'ready', quote: { costCredits: 8 }, pageOutOfDate: false });
  });

  it('forgets a refusal once a start of that run succeeds', () => {
    const { result, rerender } = renderQuote();
    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current.pageOutOfDate).toBe(true);

    // The price moves (a deploy that fixed the page's quote, say), and the run goes at it.
    quoteStandIn.answers = [8, 10];
    rerender({ current: lighthouse.request });
    expect(result.current).toMatchObject({ quote: { costCredits: 10 }, pageOutOfDate: false });
    act(() => result.current.started({ ...lighthouse.run, expectedCostCredits: 10 }));

    // The old price back (a rollback): the run went, so the page holds nothing.
    quoteStandIn.answers = [8, 8];
    rerender({ current: lighthouse.request });
    expect(result.current).toMatchObject({ quote: { costCredits: 8 }, pageOutOfDate: false });
  });

  it('keeps a refusal when a start of another run succeeds', () => {
    const { result, rerender } = renderQuote();
    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current.pageOutOfDate).toBe(true);

    act(() => result.current.started({ ...square.run, expectedCostCredits: 8 }));
    rerender({ current: lighthouse.request });

    expect(result.current.pageOutOfDate).toBe(true);
  });

  it('keeps the latest refusal only: a refusal at the price that moved is read against that price', () => {
    quoteStandIn.answers = [8, 10, 10];
    const { result } = renderQuote();
    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 8 }));
    expect(result.current).toMatchObject({ quote: { costCredits: 10 }, pageOutOfDate: false });

    act(() => result.current.costChanged({ ...lighthouse.run, expectedCostCredits: 10 }));

    expect(quoteStandIn.lastAttempt()).toBe(2);
    expect(result.current).toMatchObject({ quote: { costCredits: 10 }, pageOutOfDate: true });
  });
});
