import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { nextRailRevealRequest, useRailReveal, type RailRevealRequest } from '../lib/use-rail-reveal';

// A rail whose add tile stays fixed at its start: what the creator adds lands among the pictures
// beside it, past the edge once they no longer fit, so the add asks the rail to bring it into
// view (the owner's "pin the add tile at the start of the rails", 2026-10-21).
describe('useRailReveal', () => {
  type Reveal = ReturnType<typeof useRailReveal>;
  const layout = (x: number, width: number) => ({ nativeEvent: { layout: { x, y: 0, width, height: 72 } } }) as never;

  function mount(request: RailRevealRequest | null, { animated = true } = {}) {
    const scrollTo = vi.fn();
    let reveal!: Reveal;
    function Probe({ ask }: { ask: RailRevealRequest | null }) {
      reveal = useRailReveal(ask, 16, animated);
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe ask={request} />); });
    Object.assign(reveal.scrollRef, { current: { scrollTo } });
    return {
      scrollTo,
      get reveal() { return reveal; },
      ask: (next: RailRevealRequest | null) => renderer.act(() => { tree.update(<Probe ask={next} />); }),
    };
  }

  it('scrolls the item asked for to the rail’s end when its layout arrives, once', () => {
    const rail = mount(null);
    rail.reveal.scrollerProps.onLayout(layout(0, 300));
    rail.reveal.itemLayout('a')(layout(0, 72));

    const request = nextRailRevealRequest(null, 'e');
    rail.ask(request);
    expect(rail.scrollTo).not.toHaveBeenCalled();
    // The other items move as the new one joins; only the one asked for is followed.
    rail.reveal.itemLayout('d')(layout(243, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.reveal.itemLayout('e')(layout(324, 72));
    // Its right edge, and the rail's end inset, at the rail's right edge.
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 324 + 72 + 16 - 300, animated: true });

    // Laid out again later (a rename, a removal before it), it is not chased.
    rail.reveal.itemLayout('e')(layout(243, 72));
    rail.ask({ ...request });
    rail.reveal.itemLayout('e')(layout(243, 72));
    expect(rail.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('never scrolls to the left of the rail’s start, and does not animate under Reduce Motion', () => {
    const rail = mount(null, { animated: false });
    rail.reveal.scrollerProps.onLayout(layout(0, 300));
    rail.ask(nextRailRevealRequest(null, 'b'));
    rail.reveal.itemLayout('b')(layout(81, 72));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 0, animated: false });
  });

  it('follows the latest ask when a second comes before the first item is laid out', () => {
    const rail = mount(null);
    rail.reveal.scrollerProps.onLayout(layout(0, 300));
    const first = nextRailRevealRequest(null, 'c');
    rail.ask(first);
    rail.ask(nextRailRevealRequest(first, 'd'));
    rail.reveal.itemLayout('c')(layout(162, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.reveal.itemLayout('d')(layout(243, 72));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 243 + 72 + 16 - 300, animated: true });
  });

  // An upload can land minutes after its pick, while the creator is swiping the rail: a scroll
  // started under their finger would fight it.
  it('leaves the rail to a drag in progress when the item arrives, and reveals the next one after it', () => {
    const rail = mount(null);
    rail.reveal.scrollerProps.onLayout(layout(0, 300));
    const first = nextRailRevealRequest(null, 'e');
    rail.ask(first);
    rail.reveal.scrollerProps.onScrollBeginDrag();
    rail.reveal.itemLayout('e')(layout(324, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    rail.reveal.scrollerProps.onScrollEndDrag();
    rail.reveal.itemLayout('e')(layout(324, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.ask(nextRailRevealRequest(first, 'f'));
    rail.reveal.itemLayout('f')(layout(405, 72));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 405 + 72 + 16 - 300, animated: true });
  });

  it('leaves an ask made before the rail mounted answered, as a tab switch brings the rail back', () => {
    const rail = mount(nextRailRevealRequest(null, 'f'));
    rail.reveal.scrollerProps.onLayout(layout(0, 300));
    rail.reveal.itemLayout('f')(layout(405, 72));
    expect(rail.scrollTo).not.toHaveBeenCalled();
  });
});
