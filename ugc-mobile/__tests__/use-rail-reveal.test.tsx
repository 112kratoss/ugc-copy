import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RAIL_GESTURE_HOLD_MS, useRailReveal, type RailRevealRequest } from '../lib/use-rail-reveal';

// A rail whose add tile stays fixed at its start: what the creator adds lands among the pictures
// beside it, past the edge once they no longer fit, so the add asks the rail to bring it into
// view (the owner's "pin the add tile at the start of the rails", 2026-10-21).
describe('useRailReveal', () => {
  type Reveal = ReturnType<typeof useRailReveal>;
  const layout = (x: number, width = 72) => ({ nativeEvent: { layout: { x, y: 0, width, height: 72 } } }) as never;
  const scrolled = (x: number) => ({ nativeEvent: { contentOffset: { x, y: 0 } } }) as never;

  afterEach(() => { vi.useRealTimers(); });

  function mount(request: RailRevealRequest | null, ids: string[], { animated = true } = {}) {
    const scrollTo = vi.fn();
    let reveal!: Reveal;
    function Probe({ ask, items }: { ask: RailRevealRequest | null; items: string[] }) {
      reveal = useRailReveal(ask, items, 16, animated);
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe ask={request} items={ids} />); });
    Object.assign(reveal.scrollRef, { current: { scrollTo } });
    renderer.act(() => { reveal.scrollerProps.onLayout(layout(0, 300)); });
    return {
      scrollTo,
      get reveal() { return reveal; },
      /** The commit an add makes: its item joins the rail and the add asks for it. */
      add: (id: string, items: string[]) => {
        const ask = { id };
        renderer.act(() => { tree.update(<Probe ask={ask} items={items} />); });
        return ask;
      },
      render: (ask: RailRevealRequest | null, items: string[]) => renderer.act(() => { tree.update(<Probe ask={ask} items={items} />); }),
    };
  }

  it('scrolls an item asked for past the rail’s end to its right edge when its layout arrives, once', () => {
    const rail = mount(null, ['a', 'b', 'c', 'd']);
    rail.add('e', ['a', 'b', 'c', 'd', 'e']);
    expect(rail.scrollTo).not.toHaveBeenCalled();
    // The others move as the new one joins; only the one asked for is followed.
    rail.reveal.itemLayout('d')(layout(243));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.reveal.itemLayout('e')(layout(324));
    // Its right edge, and the rail's end inset, at the rail's right edge.
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 324 + 72 + 16 - 300, animated: true });

    // Laid out again later (a rename, a removal before it), it is not chased.
    rail.reveal.itemLayout('e')(layout(243));
    expect(rail.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('leaves the rail alone for an item already in view, and brings one before the view to its left edge', () => {
    const rail = mount(null, ['a']);
    rail.add('b', ['a', 'b']);
    rail.reveal.itemLayout('b')(layout(81));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    // Scrolled to the end, an image lands among the clips before the view (the video rail).
    rail.reveal.scrollerProps.onScroll(scrolled(400));
    rail.add('c', ['a', 'b', 'c', 'clip-1', 'clip-2', 'clip-3', 'clip-4', 'clip-5', 'clip-6']);
    rail.reveal.itemLayout('c')(layout(162));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 162, animated: true });
  });

  it('does not animate under Reduce Motion', () => {
    const rail = mount(null, ['a', 'b', 'c', 'd'], { animated: false });
    rail.add('e', ['a', 'b', 'c', 'd', 'e']);
    rail.reveal.itemLayout('e')(layout(324));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 112, animated: false });
  });

  it('follows the latest ask when a second comes before the first item is laid out', () => {
    const rail = mount(null, ['a', 'b']);
    rail.add('c', ['a', 'b', 'c']);
    rail.add('d', ['a', 'b', 'c', 'd']);
    rail.reveal.itemLayout('c')(layout(330));
    expect(rail.scrollTo).not.toHaveBeenCalled();
    rail.reveal.itemLayout('d')(layout(411));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 411 + 72 + 16 - 300, animated: true });
  });

  // A model change while an upload runs can send what it adds to the draft's held-back pictures.
  it('answers an ask for an item that is not on the rail, so a model change that sends it later does not scroll', () => {
    const rail = mount(null, ['a', 'b']);
    const ask = rail.add('held', ['a', 'b']);
    rail.render(ask, ['a', 'b', 'held']);
    rail.reveal.itemLayout('held')(layout(400));
    expect(rail.scrollTo).not.toHaveBeenCalled();
  });

  // An upload can land seconds after its pick, while the creator is swiping the rail or it is
  // still coasting from a fling: a scroll started then would fight them.
  it('drops a reveal that lands during a drag or a fling, and reveals again once the rail is at rest', () => {
    const rail = mount(null, ['a', 'b', 'c', 'd']);
    rail.reveal.scrollerProps.onScrollBeginDrag();
    rail.add('e', ['a', 'b', 'c', 'd', 'e']);
    rail.reveal.itemLayout('e')(layout(324));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    rail.reveal.scrollerProps.onScrollEndDrag(scrolled(0));
    rail.reveal.scrollerProps.onMomentumScrollBegin();
    rail.add('f', ['a', 'b', 'c', 'd', 'e', 'f']);
    rail.reveal.itemLayout('f')(layout(405));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    rail.reveal.scrollerProps.onMomentumScrollEnd(scrolled(60));
    rail.add('g', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    rail.reveal.itemLayout('g')(layout(486));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 486 + 72 + 16 - 300, animated: true });
  });

  it('stops holding reveals back for a drag it never heard end', () => {
    vi.useFakeTimers();
    const rail = mount(null, ['a', 'b', 'c', 'd']);
    rail.reveal.scrollerProps.onScrollBeginDrag();
    vi.advanceTimersByTime(RAIL_GESTURE_HOLD_MS + 1);
    rail.add('e', ['a', 'b', 'c', 'd', 'e']);
    rail.reveal.itemLayout('e')(layout(324));
    expect(rail.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('leaves an ask made before the rail mounted answered, as a tab switch brings the rail back', () => {
    const rail = mount({ id: 'f' }, ['a', 'f']);
    rail.reveal.itemLayout('f')(layout(405));
    expect(rail.scrollTo).not.toHaveBeenCalled();
  });

  // The image rail gives way to a note on a prompt-only model and the video rail to a model that
  // takes no references; each comes back as a new ScrollView at offset 0, with no event to say so.
  it('starts from offset 0 and at rest when the rail mounts anew, and keeps its offset across a layout of the same rail', () => {
    const rail = mount(null, ['a', 'b', 'c', 'd']);
    rail.reveal.scrollerProps.onScroll(scrolled(160));
    renderer.act(() => { rail.reveal.scrollerProps.onLayout(layout(0, 300)); });
    rail.add('e', ['a', 'b', 'c', 'd', 'e']);
    rail.reveal.itemLayout('e')(layout(324));
    expect(rail.scrollTo).not.toHaveBeenCalled();

    rail.reveal.scrollerProps.onScrollBeginDrag();
    const remounted = { scrollTo: rail.scrollTo };
    Object.assign(rail.reveal.scrollRef, { current: remounted });
    renderer.act(() => { rail.reveal.scrollerProps.onLayout(layout(0, 300)); });
    rail.add('f', ['a', 'b', 'c', 'd', 'e', 'f']);
    rail.reveal.itemLayout('f')(layout(405));
    expect(rail.scrollTo).toHaveBeenCalledWith({ x: 405 + 72 + 16 - 300, animated: true });
  });
});
